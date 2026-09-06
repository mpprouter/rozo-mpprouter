import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { consumeDomainProof, getDomainProofEvidence, issueDomainProof } from '../src/services/provider-domain-proof'
import { inspectProviderUrl, readBoundedText } from '../src/services/provider-check'
import { monitorPublishedProviders } from '../src/services/provider-monitor'
import { submitAndPersistPartnerDiscovery, submitPartnerDiscovery } from '../src/services/provider-discovery'
import { handleX402WellKnown } from '../src/routes/x402-well-known'
import { handleProviderCheck, handleProviderDashboard, handleProviderGet, handleProviderVerify } from '../src/routes/providers'
import { resetProviderCache, type ProviderRecord } from '../src/services/provider-registry'
import { readProviderRevenue } from '../src/services/provider-revenue'
import { STELLAR_PUBNET_USDC_ISSUER } from '../src/playground/deposit'
import { issueDashboardToken } from '../src/services/provider-dashboard-auth'
import { runClaimedPaidGate } from '../src/services/provider-verify-claim'

function kv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
    list: async ({ prefix = '' } = {}) => ({ keys: [...store.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
  }
}

const address = Keypair.random().publicKey()
const record: ProviderRecord = {
  id: 'api-example-com', name: 'Example', email: 'ops@example.com', apiBaseUrl: 'https://api.example.com',
  payouts: [{ network: 'stellar:pubnet', payTo: address, asset: 'USDC' }],
  routes: [{ operation: 'summarize', method: 'GET', upstreamPath: '/summarize', priceUsd: '0.01' }],
  status: 'published', verification: { domainVerifiedAt: new Date().toISOString(), healthStatus: 'healthy' },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerKey: { network: 'stellar:pubnet', address },
}

function env() { return { MPP_STORE: kv(), STELLAR_NETWORK: 'stellar:pubnet', STELLAR_X402_PAY_TO: address } as any }

function addAtomicLimiter<T extends Record<string, any>>(base: T): T {
  const states = new Map<string, { value: string | null; version: number }>()
  const stub = {
    fetch: async (request: Request) => {
      const body = await request.json() as any
      const state = states.get(body.key) ?? { value: null, version: 0 }
      if (new URL(request.url).pathname === '/read') return Response.json(state)
      if (body.expectedVersion !== state.version) return Response.json({ ok: false, ...state })
      state.value = body.value; state.version += 1; states.set(body.key, state)
      return Response.json({ ok: true })
    },
  }
  return Object.assign(base, { ATOMIC_STORE: { idFromName: () => ({}), get: () => stub } })
}

beforeEach(() => { vi.restoreAllMocks(); resetProviderCache() })

describe('provider check and domain ownership', () => {
  it('discovers a live 402 and returns five independent checks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      accepts: [{ network: 'stellar:pubnet', payTo: address, amount: '100000', asset: 'USDC' }],
    }), { status: 402 }))
    const result = await inspectProviderUrl('https://api.example.com/summarize')
    expect(result.checks).toHaveLength(5)
    expect(result.checks.map(item => item.key)).toEqual(['website_reachable', 'service_discovered', 'payment_configured', 'ownership_confirmed', 'paid_call_works'])
    expect(result.draft?.payouts[0].pay_to).toBe(address)
  })

  it('refuses a manifest resource on another origin before fetching it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      resources: [{ resource: 'https://other-public.example/route', method: 'GET' }],
    }), { status: 200 }))
    const result = await inspectProviderUrl('https://api.example.com')
    expect(result.draft).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rate limits the public check handler before outbound fetch work', async () => {
    const states = new Map<string, { value: string | null; version: number }>()
    const stub = {
      fetch: async (request: Request) => {
        const body = await request.json() as any
        const state = states.get(body.key) ?? { value: null, version: 0 }
        if (new URL(request.url).pathname === '/read') return Response.json(state)
        if (body.expectedVersion !== state.version) return Response.json({ ok: false, ...state })
        state.value = body.value; state.version += 1; states.set(body.key, state)
        return Response.json({ ok: true })
      },
    }
    const e = {
      MPP_STORE: kv(),
      ATOMIC_STORE: { idFromName: () => ({}), get: () => stub },
    } as any
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should only run after throttle'))
    const makeRequest = () => new Request('https://router.test/v1/providers/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8' }, body: JSON.stringify({ url: 'https://api.example.com' }),
    })
    for (let i = 0; i < 5; i++) expect((await handleProviderCheck(makeRequest(), e)).status).toBe(422)
    const blocked = await handleProviderCheck(makeRequest(), e)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('requires the one-time dashboard bearer token and keeps its hash private', async () => {
    const credential = await issueDashboardToken()
    const e = addAtomicLimiter(env())
    const privateRecord = { ...record, dashboardTokenHash: credential.hash }
    await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify(privateRecord))
    await e.MPP_STORE.put(`providerDashboardCache:${record.id}`, JSON.stringify({ cached: true }))
    const request = (authorization?: string) => new Request(`https://router.test/v1/providers/${record.id}/dashboard`, {
      headers: { 'CF-Connecting-IP': '203.0.113.9', ...(authorization ? { Authorization: authorization } : {}) },
    })
    expect((await handleProviderDashboard(request(), e, record.id)).status).toBe(401)
    expect((await handleProviderDashboard(request('Bearer ' + 'f'.repeat(64)), e, record.id)).status).toBe(401)
    const allowed = await handleProviderDashboard(request(`Bearer ${credential.token}`), e, record.id)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ cached: true })

    const publicBody = await (await handleProviderGet(e, record.id)).text()
    expect(publicBody).not.toContain('dashboardTokenHash')
    expect(publicBody).not.toContain(credential.token)
  })

  it('binds the well-known token to domain, provider and payTo and consumes it once', async () => {
    const e = env()
    const proof = await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(proof.manifest), { status: 200 }))
    const first = await consumeDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, token: proof.token, claimSecret: proof.claim_secret })
    expect(first.ok).toBe(true)
    expect(await getDomainProofEvidence(e, record.id, record.apiBaseUrl, address)).toBeTruthy()
    const replay = await consumeDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, token: proof.token, claimSecret: proof.claim_secret })
    expect(replay.ok).toBe(false)
  })

  it('does not overwrite an unexpired domain challenge for the same binding', async () => {
    const e = env()
    await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
    await expect(issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })).rejects.toThrow(/already active/)
  })

  it('stops reading an oversized streamed discovery response', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(40_000)); controller.close() } })
    await expect(readBoundedText(new Response(stream))).rejects.toThrow(/too large/)
  })
})

describe('health, discovery and public manifest', () => {
  it('marks a provider degraded after recurring free-probe failures', async () => {
    const e = env()
    const failing = { ...record, verification: { ...record.verification, consecutiveProbeFailures: 1 } }
    await e.MPP_STORE.put('providerIndex:v1', JSON.stringify({ providers: [failing], builtAt: new Date().toISOString() }))
    await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify(failing))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }))
    await monitorPublishedProviders(e)
    const stored = JSON.parse((await e.MPP_STORE.get(`provider:${record.id}`))!)
    expect(stored.verification.healthStatus).toBe('degraded')
  })

  it.each(['pending', 'suspended'] as const)('never republishes a stale indexed provider whose authoritative status is %s', async status => {
    const e = env()
    await e.MPP_STORE.put('providerIndex:v1', JSON.stringify({ providers: [record], builtAt: new Date().toISOString() }))
    await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify({ ...record, status, updatedAt: `authoritative-${status}` }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await monitorPublishedProviders(e)
    const stored = JSON.parse((await e.MPP_STORE.get(`provider:${record.id}`))!)
    expect(stored.status).toBe(status)
    expect(stored.updatedAt).toBe(`authoritative-${status}`)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not overwrite a provider suspended while its health probe is in flight', async () => {
    const e = env()
    const published = { ...record, updatedAt: 'published-v1' }
    await e.MPP_STORE.put('providerIndex:v1', JSON.stringify({ providers: [published], builtAt: new Date().toISOString() }))
    await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify(published))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify({ ...published, status: 'suspended', updatedAt: 'suspended-v2' }))
      return new Response('down', { status: 503 })
    })
    await monitorPublishedProviders(e)
    const stored = JSON.parse((await e.MPP_STORE.get(`provider:${record.id}`))!)
    expect(stored.status).toBe('suspended')
    expect(stored.updatedAt).toBe('suspended-v2')
  })

  it('does not claim partner submission when no adapter is configured', async () => {
    const result = await submitPartnerDiscovery(env(), record)
    expect(result.submissionStatus).toBe('not_submitted')
  })

  it('does not overwrite a re-registration during verify waitUntil partner submission', async () => {
    const e = { ...env(), PROVIDER_DISCOVERY_SUBMIT_URL: 'https://partner.example/register' }
    const published = { ...record, updatedAt: 'published-v1' }
    await e.MPP_STORE.put('providerIndex:v1', JSON.stringify({ providers: [published], builtAt: new Date().toISOString() }))
    await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify(published))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify({ ...published, status: 'pending', updatedAt: 'pending-v2' }))
      return Response.json({ submission_id: 'submission-1' })
    })
    await submitAndPersistPartnerDiscovery(e, record.id)
    const stored = JSON.parse((await e.MPP_STORE.get(`provider:${record.id}`))!)
    expect(stored.status).toBe('pending')
    expect(stored.discovery).toBeUndefined()
  })

  it('routes verify waitUntil through the guarded partner submission helper', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(new URL('../src/routes/providers.ts', import.meta.url), 'utf8')
    expect(source).toContain('ctx.waitUntil(submitAndPersistPartnerDiscovery(env, latest.id))')
  })

  it('lists direct provider routes at /.well-known/x402', async () => {
    const e = env()
    await e.MPP_STORE.put('providerIndex:v1', JSON.stringify({ providers: [record], builtAt: new Date().toISOString() }))
    resetProviderCache()
    const response = await handleX402WellKnown(e)
    const body = await response.json() as any
    // `settlement` describes the ROUTE, not one payment option on it: an
    // accepts[] entry is an x402 field and gains nothing from a key the
    // spec does not define. The manifest now also carries our own 674
    // routes, so the provider's entry is found by operator rather than by
    // being the only thing in the list.
    const direct = body.resources.find((r: any) => r.operator?.id === record.id)
    expect(direct).toMatchObject({ settlement: 'direct', payable_through_router: true })
    expect(direct.accepts[0]).toMatchObject({ payTo: address, network: 'stellar:pubnet' })
  })

  it('sums only canonical Circle USDC revenue with bigint base units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ _embedded: { records: [
      { to: address, asset_code: 'USDC', asset_issuer: STELLAR_PUBNET_USDC_ISSUER, amount: '9007199254740993.0000001' },
      { to: address, asset_code: 'USDC', asset_issuer: STELLAR_PUBNET_USDC_ISSUER, amount: '0.0000009' },
      { to: address, asset_code: 'USDC', asset_issuer: Keypair.random().publicKey(), amount: '999999.0000000' },
    ] } }))
    const result = await readProviderRevenue(env(), record) as any
    expect(result.total_received).toBe('9007199254740993.0000010')
    expect(result.payments_sampled).toBe(2)
  })
})

describe('real-money verification claim', () => {
  it('returns published verification evidence without entering any paid path', async () => {
    const e = addAtomicLimiter(env())
    await e.MPP_STORE.put(`provider:${record.id}`, JSON.stringify({ ...record, verification: { ...record.verification, paidCallTxHash: 'existing-tx' } }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await handleProviderVerify(new Request('https://router.test/v1/providers/verify', {
      method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.10', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: record.id }),
    }), e, { waitUntil() {} } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ published: true, idempotent: true, evidence: { settlement_tx: 'existing-tx' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows only one concurrent caller to enter the paid gate', async () => {
    const e = addAtomicLimiter(env())
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const paid = vi.fn(async () => { entered(); await blocked; return { ok: true, detail: 'paid', txHash: 'tx' } as const })
    const first = runClaimedPaidGate(e, record.id, 'v1', paid)
    await started
    const second = await runClaimedPaidGate(e, record.id, 'v1', paid)
    expect(second.status).toBe('in_progress')
    expect(paid).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('returns a completed claim without invoking the paid gate again', async () => {
    const e = addAtomicLimiter(env())
    const paid = vi.fn(async () => ({ ok: true, detail: 'paid', txHash: 'tx' } as const))
    await runClaimedPaidGate(e, record.id, 'v2', paid)
    const retry = await runClaimedPaidGate(e, record.id, 'v2', paid)
    expect(retry.status).toBe('completed')
    expect(paid).toHaveBeenCalledTimes(1)
  })

  it('keeps an uncertain timeout locked and never pays twice automatically', async () => {
    const e = addAtomicLimiter(env())
    const paid = vi.fn(async () => { throw new Error('timeout') })
    await runClaimedPaidGate(e, record.id, 'v3', paid)
    const retry = await runClaimedPaidGate(e, record.id, 'v3', paid)
    expect(retry.status).toBe('uncertain')
    expect(paid).toHaveBeenCalledTimes(1)
  })

  describe('the claim secret is what lets the token live for days', () => {
    it('refuses a token published on the domain when the claim secret is absent', async () => {
      // The scenario the secret exists for: an onlooker reads the provider's
      // public .well-known file and tries to claim the record with it. Before
      // the secret, the only thing stopping them was a ten-minute window.
      const e = env()
      const proof = await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(proof.manifest), { status: 200 }))
      const stolen = await consumeDomainProof(e, {
        providerId: record.id, url: record.apiBaseUrl, token: proof.token,
      })
      expect(stolen.ok).toBe(false)
      expect(stolen.detail).toContain('claim secret')
    })

    it('refuses a wrong claim secret', async () => {
      const e = env()
      const proof = await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(proof.manifest), { status: 200 }))
      const wrong = await consumeDomainProof(e, {
        providerId: record.id, url: record.apiBaseUrl, token: proof.token, claimSecret: 'not-the-secret',
      })
      expect(wrong.ok).toBe(false)
    })

    it('does not reach out to the provider domain when the secret is wrong', async () => {
      // Checked before the fetch, so a guessing attacker cannot use us to
      // hammer someone else's origin.
      const e = env()
      const proof = await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
      await consumeDomainProof(e, {
        providerId: record.id, url: record.apiBaseUrl, token: proof.token, claimSecret: 'wrong',
      })
      expect(spy).not.toHaveBeenCalled()
    })

    it('never stores the claim secret itself', async () => {
      const e = env()
      const proof = await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
      const entries = [...(e.MPP_STORE as any).store.entries()]
      // Guard the guard: an empty dump would pass this vacuously.
      expect(entries.length).toBeGreaterThan(0)
      const dumped = JSON.stringify(entries)
      expect(dumped).not.toContain(proof.claim_secret)
      // The hash is stored; the secret is not.
      expect(dumped).toContain('claimSecretHash')
    })

    it('issues a proof that lasts seven days, not ten minutes', async () => {
      const e = env()
      const proof = await issueDomainProof(e, { providerId: record.id, url: record.apiBaseUrl, payTo: address })
      const lifetimeMs = Date.parse(proof.expires_at) - Date.now()
      expect(lifetimeMs).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000)
      expect(lifetimeMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 5000)
    })
  })
})
