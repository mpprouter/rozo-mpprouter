/**
 * Router-hosted paywall: registration, credential sealing, route shape,
 * and the proxy-side guarantees that keep it x402-only and un-relayed.
 * No payment is made; the x402 settle path itself is covered by the
 * existing stellar-x402-server tests and by production verification.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { handleProviderRegister, handleProviderGet } from '../src/routes/providers'
import { getProviderRecord, resetProviderCache, routesForProvider } from '../src/services/provider-registry'
import { hostedOriginHeaders, hostedProviderIdFor, openHostingSecret, resolveHostedRoute, sealHosting, validateHosting } from '../src/services/provider-hosting'
import { isDirectSettlementRoute } from '../src/routes/provider-relay'
import { listCatalogWithOverlay } from '../src/services/catalog-overlay'
import { handleProxy } from '../src/routes/proxy'

const PAYOUT = Keypair.random().publicKey()

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = new Map<string, string>()
  const atomic = new Map<string, { value: string | null; version: number }>()
  const stub = {
    fetch: async (request: Request) => {
      const body = (await request.json()) as any
      const state = atomic.get(body.key) ?? { value: null, version: 0 }
      if (new URL(request.url).pathname === '/read') return Response.json(state)
      if (body.expectedVersion !== state.version) return Response.json({ ok: false, ...state })
      state.value = body.op === 'delete' ? null : body.value
      state.version += 1
      atomic.set(body.key, state)
      return Response.json({ ok: true })
    },
  }
  return {
    kv,
    MPP_STORE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v) }, delete: async (k: string) => { kv.delete(k) }, list: async () => ({ keys: [], list_complete: true }) },
    ATOMIC_STORE: { idFromName: () => ({}), get: () => stub },
    STELLAR_NETWORK: 'stellar:pubnet',
    PROVIDERS_ENDPOINT_ENABLED: 'true',
    PROVIDER_HOSTING_KEK: 'k'.repeat(48),
    ...overrides,
  } as any
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://router.test/v1/providers/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5', 'X-MPP-Client-Id': crypto.randomUUID(), ...headers },
    body: JSON.stringify(body),
  })
}

const registration = {
  id: 'acme-data',
  name: 'Acme Data',
  email: 'ops@acme.example',
  payouts: [{ network: 'stellar:pubnet', pay_to: PAYOUT, asset: 'USDC' }],
  routes: [{ operation: 'quote', method: 'GET', upstream_path: '/v1/quote', price_usd: '0.005', verify_with: true }],
  hosting: { origin_url: 'https://api.acme.example', auth: { header: 'X-API-Key', scheme: 'raw', value: 'acme-live-key-123' } },
}

beforeEach(() => { resetProviderCache(); vi.restoreAllMocks() })

describe('hosting config and sealing', () => {
  it('validates the hosting block and generates a gateway secret on request', () => {
    const env = makeEnv()
    const supplied = validateHosting(env, registration.hosting)
    expect(supplied).toMatchObject({ originUrl: 'https://api.acme.example', auth: { header: 'X-API-Key', scheme: 'raw', value: 'acme-live-key-123', generated: false } })
    const generated = validateHosting(env, { origin_url: 'https://api.acme.example', auth: { generate: true } })
    expect(generated.auth.generated).toBe(true)
    expect(generated.auth.value).toMatch(/^mppg_[0-9a-f]{64}$/)
    expect(generated.auth.header).toBe('Authorization')
    expect(generated.auth.scheme).toBe('bearer')
    expect(() => validateHosting(env, { origin_url: 'http://api.acme.example', auth: { generate: true } })).toThrow(/https/)
    expect(() => validateHosting(env, { origin_url: 'https://api.acme.example', auth: {} })).toThrow(/auth.value/)
    expect(() => validateHosting(env, { origin_url: 'https://api.acme.example', auth: { header: 'Cookie', value: 'x' } })).toThrow(/cannot be/)
    expect(() => validateHosting(env, { origin_url: 'https://10.0.0.1', auth: { generate: true } })).toThrow()
    // Never ourselves: a loop, and a stored credential handed to our own handlers.
    for (const bad of ['https://apiserver.mpprouter.dev', 'https://other-pay.mpprouter.dev', 'https://pay.mpprouter.dev', 'https://x.workers.dev', 'https://coupon.rozo.ai']) {
      expect(() => validateHosting(env, { origin_url: bad, auth: { generate: true } })).toThrow(/cannot point/)
    }
  })

  it('seals the credential with the KEK and never stores it in the clear', async () => {
    const env = makeEnv()
    const stored = await sealHosting(env, validateHosting(env, registration.hosting))
    expect(JSON.stringify(stored)).not.toContain('acme-live-key-123')
    expect(await openHostingSecret(env, stored)).toBe('acme-live-key-123')
    expect(await openHostingSecret(makeEnv({ PROVIDER_HOSTING_KEK: 'z'.repeat(48) }), stored)).toBeNull()
  })

  it('maps hosted hostnames to provider ids and nothing else', () => {
    const env = makeEnv()
    expect(hostedProviderIdFor(env, 'acme-data-pay.mpprouter.dev')).toBe('acme-data')
    expect(hostedProviderIdFor(env, 'ACME-DATA-pay.mpprouter.dev')).toBe('acme-data')
    expect(hostedProviderIdFor(env, 'apiserver.mpprouter.dev')).toBeNull()
    expect(hostedProviderIdFor(env, 'evil-pay.mpprouter.dev.attacker.com')).toBeNull()
    expect(hostedProviderIdFor(env, 'x.y-pay.mpprouter.dev')).toBeNull()
    expect(hostedProviderIdFor(env, '-pay.mpprouter.dev')).toBeNull()
    // A dotted suffix still works where the certificate exists.
    const dotted = makeEnv({ PROVIDER_HOSTED_SUFFIX: 'pay.mpprouter.dev' })
    expect(hostedProviderIdFor(dotted, 'acme-data.pay.mpprouter.dev')).toBe('acme-data')
  })
})

describe('hosted registration', () => {
  it('registers a hosted provider on its hosted origin, returns the credential digest, never the credential', async () => {
    const env = makeEnv()
    const res = await handleProviderRegister(post(registration), env)
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.api_base_url).toBe('https://acme-data-pay.mpprouter.dev')
    expect(body.ownership_proof.type).toBe('hosted_origin_auth')
    expect(body.verification.ownership_proof_means).toMatch(/Not key custody/)
    expect(body.hosting.hosted_origin).toBe('https://acme-data-pay.mpprouter.dev')
    expect(body.hosting.paid_routes).toEqual(['https://acme-data-pay.mpprouter.dev/v1/quote'])
    expect(body.hosting.generated_secret).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('acme-live-key-123')
    const record = (await getProviderRecord(env, 'acme-data'))!
    expect(record.hosting?.originUrl).toBe('https://api.acme.example')
    expect(JSON.stringify(record)).not.toContain('acme-live-key-123')
    const pub = await (await handleProviderGet(env, 'acme-data')).json() as any
    expect(pub.hosting).toEqual({ mode: 'router', origin_host: 'api.acme.example', auth_header: 'X-API-Key' })
    expect(JSON.stringify(pub)).not.toMatch(/ciphertext|acme-live-key/)
  })

  it('returns a generated secret exactly once', async () => {
    const env = makeEnv()
    const res = await handleProviderRegister(post({ ...registration, hosting: { origin_url: 'https://api.acme.example', auth: { generate: true } } }), env)
    const body = await res.json() as any
    expect(body.hosting.generated_secret).toMatch(/^mppg_/)
    const again = await handleProviderRegister(post({ ...registration, hosting: { origin_url: 'https://api.acme.example', auth: { keep: true } } }, { Authorization: `Bearer ${body.dashboard_token}` }), env)
    expect(again.status).toBe(201)
    const againBody = await again.json() as any
    expect(againBody.hosting.generated_secret).toBeUndefined()
    expect(againBody.hosting.auth_digest).toBe(body.hosting.auth_digest)
  })

  it('refuses hosting without a KEK, without a Stellar payout, and relayed records on a hosted hostname', async () => {
    expect((await handleProviderRegister(post(registration), makeEnv({ PROVIDER_HOSTING_KEK: undefined }))).status).toBe(503)
    const noStellar = await handleProviderRegister(post({ ...registration, payouts: [{ network: 'eip155:8453', pay_to: '0x' + '1'.repeat(40) }] }), makeEnv())
    expect(noStellar.status).toBe(400)
    const relayOnHosted = await handleProviderRegister(post({ ...registration, hosting: undefined, api_base_url: 'https://acme-data-pay.mpprouter.dev', ownership_proof: { type: 'x402_pay_to' } }), makeEnv())
    expect(relayOnHosted.status).toBe(400)
    expect(await relayOnHosted.json()).toMatchObject({ field: 'api_base_url' })
  })

  it('an update of a hosted record needs the dashboard token and a hosting block', async () => {
    const env = makeEnv()
    const first = await (await handleProviderRegister(post(registration), env)).json() as any
    const noToken = await handleProviderRegister(post(registration), env)
    expect(noToken.status).toBe(401)
    const dropHosting = await handleProviderRegister(post({ ...registration, hosting: undefined, api_base_url: 'https://api.acme.example', ownership_proof: { type: 'x402_pay_to' } }, { Authorization: `Bearer ${first.dashboard_token}` }), env)
    expect(dropHosting.status).toBe(400)
  })
})

describe('hosted routes in the catalog and the proxy', () => {
  it('renders hosted routes with the origin as upstream, fixed pricing, a daily cap, and never as relay', async () => {
    const env = makeEnv()
    await handleProviderRegister(post(registration), env)
    const record = (await getProviderRecord(env, 'acme-data'))!
    const [route] = routesForProvider(record)
    expect(route).toMatchObject({ hosted: true, hostedPath: '/v1/quote', upstreamHost: 'api.acme.example', upstreamPath: '/v1/quote', fixedPricing: { amountUsd: '0.005' }, rateLimit: { perDay: 2000 }, publicPath: '/v1/services/acme-data/quote' })
    expect(isDirectSettlementRoute(route)).toBe(false)
    // Publish it and look at the public catalog.
    record.status = 'published'
    record.verification.paidCallAt = 'x'
    env.kv.set('providerIndex:v1', JSON.stringify({ providers: [record], builtAt: 'x' }))
    resetProviderCache()
    const entry = (await listCatalogWithOverlay(env)).find(e => e.id === 'acme-data_quote') as any
    expect(entry.settlement_mode).toBe('router_paywall')
    expect(entry.payment_hints).toMatchObject({ dialect: 'x402', relayed: false, pay_to: PAYOUT })
    expect(entry.methods.stellar.intents).toEqual([])
    const resolved = await resolveHostedRoute(env, 'acme-data-pay.mpprouter.dev', '/v1/quote', 'GET')
    expect(resolved?.id).toBe('acme-data_quote')
    // Resolvable while still pending, so the paid verification can reach it.
    const fresh = makeEnv()
    await handleProviderRegister(post(registration), fresh)
    expect((await resolveHostedRoute(fresh, 'acme-data-pay.mpprouter.dev', '/v1/quote', 'GET'))?.id).toBe('acme-data_quote')
    const rec = (await getProviderRecord(fresh, 'acme-data'))!
    rec.status = 'suspended'; await fresh.MPP_STORE.put('provider:acme-data', JSON.stringify(rec))
    expect(await resolveHostedRoute(fresh, 'acme-data-pay.mpprouter.dev', '/v1/quote', 'GET')).toBeUndefined()
    expect(await resolveHostedRoute(env, 'acme-data-pay.mpprouter.dev', '/v1/other', 'GET')).toBeUndefined()
    expect(await resolveHostedRoute(env, 'other-pay.mpprouter.dev', '/v1/quote', 'GET')).toBeUndefined()
  })

  it('never passes a non-x402 credential or a channel bootstrap through to the origin', async () => {
    const env = makeEnv()
    await handleProviderRegister(post(registration), env)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('should not be called', { status: 200 }))
    const ctx = { waitUntil() {} } as any
    for (const req of [
      new Request('https://acme-data-pay.mpprouter.dev/v1/quote', { headers: { Authorization: 'Bearer stolen-or-random' } }),
      new Request('https://acme-data-pay.mpprouter.dev/v1/quote?payment=channel&agent=' + PAYOUT),
    ]) {
      const res = await handleProxy(req, env, ctx)
      expect(res.status).toBe(402)
      expect(await res.json()).toMatchObject({ error: 'x402 required' })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a second payout network on a hosted registration', async () => {
    const res = await handleProviderRegister(post({ ...registration, payouts: [...registration.payouts, { network: 'eip155:8453', pay_to: '0x' + '1'.repeat(40) }] }), makeEnv())
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field: 'payouts' })
  })

  it('builds origin headers with the provider credential and none of the buyer credentials', async () => {
    const env = makeEnv()
    await handleProviderRegister(post(registration), env)
    const headers = (await hostedOriginHeaders(env, 'acme-data', new Request('https://acme-data-pay.mpprouter.dev/v1/quote', {
      headers: { 'PAYMENT-SIGNATURE': 'buyer', Authorization: 'Payment x', Cookie: 'a=b', Accept: 'application/json', 'X-Forwarded-For': '1.1.1.1' },
    })))!
    expect(headers.get('x-api-key')).toBe('acme-live-key-123')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('payment-signature')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-forwarded-for')).toBeNull()
    expect(headers.get('x-mpp-router-gateway')).toBe('acme-data')
    expect(await hostedOriginHeaders(makeEnv({ PROVIDER_HOSTING_KEK: 'z'.repeat(48), MPP_STORE: env.MPP_STORE }), 'acme-data', new Request('https://x/'))).toBeNull()
  })
})
