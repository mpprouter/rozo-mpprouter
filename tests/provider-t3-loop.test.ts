/**
 * SCF44 Tranche 3 — the self-serve loop end to end, with money mocked.
 *
 *   check → x402_pay_to proof → register → free probe → paid gate →
 *   automatic publication → durable evidence → catalog → relay → select
 *
 * Fixtures are the real shapes, not toy ones: an x402 v2 multi-chain
 * `accepts[]` in the style Agent402 serves (Base + Solana + Stellar), a
 * v1 body, an mppx `WWW-Authenticate`, `PAYMENT-RESPONSE` /
 * `X-PAYMENT-RESPONSE` / `payment-receipt` receipts, and Horizon operation
 * records. No key is loaded, no network is reached, no payment is made:
 * the paid HTTP call is injected and the ledger is a fake. What these
 * tests prove is the router's behaviour around a payment, not that a
 * mainnet payment happened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'

const paidExecutor = vi.hoisted(() => vi.fn())
const horizon = vi.hoisted(() => ({ ops: [] as any[], status: 200, byHash: {} as Record<string, { status: number; ops?: any[] }> }))

// The paid call and the ledger are the only two things mocked. Everything
// else — parsing, gates, claim store, handlers, catalog, relay, selection —
// runs for real against in-memory KV and DO stand-ins.
vi.mock('../src/services/provider-verification', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/provider-verification')>()
  const horizonFetch: typeof fetch = async (input: any) => {
    const hash = String(input).match(/transactions\/([0-9a-f]{64})/)?.[1] ?? ''
    const override = horizon.byHash[hash]
    return new Response(JSON.stringify({ _embedded: { records: override?.ops ?? horizon.ops } }), { status: override?.status ?? horizon.status })
  }
  return {
    ...actual,
    gateRealMoneyCall: (env: any, record: any, spec: any, dialect: any) =>
      actual.gateRealMoneyCall(env, record, spec, dialect, { execute: paidExecutor, fetchImpl: horizonFetch }),
    assertSettledToProvider: (env: any, tx: string, addr: string) =>
      actual.assertSettledToProvider(env, tx, addr, horizonFetch),
  }
})

import {
  handleProviderCheck,
  handleProviderRegister,
  handleProviderVerify,
  handleProviderVerificationStatus,
} from '../src/routes/providers'
import { gateRealMoneyCall, receiptTxHash, parseProviderChallenge } from '../src/services/provider-verification'
import { resetProviderCache } from '../src/services/provider-registry'
import { listCatalogWithOverlay, getRouteWithOverlay } from '../src/services/catalog-overlay'
import { handleProxy } from '../src/routes/proxy'
import { rankCandidates, selectProvider, type Candidate } from '../src/services/provider-selection'

const PROVIDER = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()
const ROUTER_POOL = Keypair.random().publicKey()
const TX = 'a'.repeat(63) + '1'
const ORIGIN = 'https://agent402.example'

function makeEnv() {
  const kv = new Map<string, string>()
  const atomic = new Map<string, { value: string | null; version: number }>()
  const stub = {
    fetch: async (request: Request) => {
      const body = (await request.json()) as any
      const state = atomic.get(body.key) ?? { value: null, version: 0 }
      if (new URL(request.url).pathname === '/read') return Response.json(state)
      if (body.expectedVersion !== state.version) return Response.json({ ok: false, ...state })
      if (body.op === 'delete') state.value = null
      else state.value = body.value
      state.version += 1
      atomic.set(body.key, state)
      return Response.json({ ok: true })
    },
  }
  return {
    kv,
    atomic,
    MPP_STORE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value) },
      delete: async (key: string) => { kv.delete(key) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    ATOMIC_STORE: { idFromName: () => ({}), get: () => stub },
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: ROUTER_POOL,
    STELLAR_RPC_URL: 'https://rpc.example',
    PROVIDER_VERIFY_STELLAR_SECRET: Keypair.random().secret(),
    PROVIDERS_ENDPOINT_ENABLED: 'true',
  } as any
}

const ctx = { waitUntil() {} } as any

function post(path: string, body: unknown) {
  return new Request(`https://router.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', 'X-MPP-Client-Id': crypto.randomUUID() },
    body: JSON.stringify(body),
  })
}

/** Agent402-shaped x402 v2 challenge: three chains, one of them Stellar. */
function agent402Challenge(stellarPayTo = PROVIDER, amount = '30000') {
  return {
    x402Version: 2,
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', payTo: '0x' + '4'.repeat(40), amount: '3000', asset: '0x' + 'a'.repeat(40), maxTimeoutSeconds: 60 },
      { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: '3000' },
      { scheme: 'exact', network: 'stellar:pubnet', payTo: stellarPayTo, amount, asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', extra: { areFeesSponsored: true } },
    ],
  }
}

function challenge402(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 402, headers: { 'Content-Type': 'application/json', ...headers } })
}

function b64(obj: unknown) {
  return btoa(JSON.stringify(obj))
}

function paidOk(receiptHeader: string, value: string, body = '{"peg":"ok"}') {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', [receiptHeader]: value } })
}

const registration = {
  id: 'agent402',
  name: 'Agent402',
  email: 'ops@agent402.example',
  api_base_url: ORIGIN,
  payouts: [{ network: 'stellar:pubnet', pay_to: PROVIDER, asset: 'USDC' }],
  routes: [
    { operation: 'stablecoin-peg', method: 'GET', upstream_path: '/api/stablecoin-peg', price_usd: '0.003', verify_with: true },
    { operation: 'web-search', method: 'GET', upstream_path: '/api/search', price_usd: '0.02', capability: 'web-search.v1' },
  ],
  ownership_proof: { type: 'x402_pay_to' },
}

beforeEach(() => {
  paidExecutor.mockReset()
  horizon.ops = [{ type: 'invoke_host_function', parameters: [{ value: PROVIDER }] }]
  horizon.status = 200
  horizon.byHash = {}
  resetProviderCache()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------
// Receipts and the paid gate, per dialect
// ---------------------------------------------------------------------

describe('paid gate: receipts and dialects', () => {
  const record = () => ({
    id: 'p', name: 'P', email: 'a@b.co', apiBaseUrl: ORIGIN,
    payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER, asset: 'USDC' }],
    routes: [{ operation: 'peg', method: 'GET' as const, upstreamPath: '/api/stablecoin-peg', priceUsd: '0.003' }],
    status: 'pending' as const, verification: {}, createdAt: '', updatedAt: '', ownerKey: { network: 'stellar:pubnet', address: PROVIDER },
  })

  it('reads the hash from an x402 v2 PAYMENT-RESPONSE, a v1 X-PAYMENT-RESPONSE and an mppx payment-receipt', () => {
    const v2 = new Headers({ 'payment-response': b64({ success: true, transaction: TX, network: 'stellar:pubnet', payer: OTHER }) })
    const v1 = new Headers({ 'x-payment-response': b64({ success: true, transaction: TX, network: 'stellar' }) })
    const mpp = new Headers({ 'payment-receipt': b64({ hash: TX, state: 'settled' }) })
    expect(receiptTxHash(v2)).toBe(TX)
    expect(receiptTxHash(v1)).toBe(TX)
    expect(receiptTxHash(mpp)).toBe(TX)
    expect(receiptTxHash(new Headers())).toBeNull()
  })

  it('pays an x402 challenge with the x402 executor and confirms settlement to the provider', async () => {
    paidExecutor.mockResolvedValue(paidOk('payment-response', b64({ success: true, transaction: TX, network: 'stellar:pubnet' })))
    const env = makeEnv()
    const r = record()
    const result = await gateRealMoneyCall(env, r as any, r.routes[0], 'x402')
    expect(result).toMatchObject({ ok: true, txHash: TX, network: 'stellar:pubnet', dialect: 'x402' })
    expect(paidExecutor).toHaveBeenCalledTimes(1)
    expect(paidExecutor.mock.calls[0][0]).toMatchObject({ dialect: 'x402', url: `${ORIGIN}/api/stablecoin-peg`, method: 'GET', network: 'stellar:pubnet', rpcUrl: 'https://rpc.example' })
  })

  it('pays an mppx challenge with the mppx executor', async () => {
    paidExecutor.mockResolvedValue(paidOk('payment-receipt', b64({ hash: TX })))
    const env = makeEnv()
    const r = record()
    const result = await gateRealMoneyCall(env, r as any, r.routes[0], 'mppx')
    expect(result).toMatchObject({ ok: true, txHash: TX, dialect: 'mppx' })
    expect(paidExecutor.mock.calls[0][0].dialect).toBe('mppx')
  })

  it('refuses to pay an x402 challenge without a Soroban RPC, and pays nothing', async () => {
    const env = makeEnv()
    delete env.STELLAR_RPC_URL
    const r = record()
    const result = await gateRealMoneyCall(env, r as any, r.routes[0], 'x402')
    expect(result).toMatchObject({ ok: false, code: 'gate_unavailable' })
    expect(paidExecutor).not.toHaveBeenCalled()
  })

  it('binds the recipient: a hash that pays someone else fails, a hash with a ROZO leg fails', async () => {
    paidExecutor.mockImplementation(async () => paidOk('payment-response', b64({ success: true, transaction: TX })))
    const env = makeEnv()
    const r = record()
    horizon.ops = [{ type: 'payment', to: OTHER }]
    expect(await gateRealMoneyCall(env, r as any, r.routes[0], 'x402')).toMatchObject({ ok: false, code: 'settlement_not_found', txHash: TX })
    horizon.ops = [{ type: 'invoke_host_function', parameters: [{ value: PROVIDER }, { value: ROUTER_POOL }] }]
    expect(await gateRealMoneyCall(env, r as any, r.routes[0], 'x402')).toMatchObject({ ok: false, code: 'settlement_not_direct', txHash: TX })
  })

  it('carries the hash on a paid-but-not-served failure so it can be reconciled, never re-paid', async () => {
    paidExecutor.mockResolvedValue(new Response('busy', { status: 503, headers: { 'payment-response': b64({ success: true, transaction: TX }) } }))
    const env = makeEnv()
    const r = record()
    expect(await gateRealMoneyCall(env, r as any, r.routes[0], 'x402')).toMatchObject({ ok: false, code: 'paid_call_not_200', txHash: TX })
  })

  it('parses v1 and v2 x402 bodies and mppx headers into one challenge shape', () => {
    const v1 = parseProviderChallenge(402, new Headers(), JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', payTo: '0x' + '1'.repeat(40), maxAmountRequired: '3000' }] }))
    expect(v1).toMatchObject({ dialect: 'x402', x402Version: 1, accepts: [{ network: 'base', amount: '3000', decimals: 6 }] })
    const v2h = parseProviderChallenge(402, new Headers({ 'payment-required': b64(agent402Challenge()) }), '')
    expect(v2h?.accepts.map(a => a.network)).toContain('stellar:pubnet')
    expect(v2h?.accepts.find(a => a.network === 'stellar:pubnet')?.decimals).toBe(7)
  })
})

// ---------------------------------------------------------------------
// The whole loop through the HTTP handlers
// ---------------------------------------------------------------------

function mockProviderOrigin(challenge: unknown = agent402Challenge()) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(ORIGIN)) return challenge402(challenge)
    throw new Error(`unexpected fetch ${url}`)
  })
}

async function registerAgent402(env: any) {
  const res = await handleProviderRegister(post('/v1/providers/register', registration), env)
  const body = await res.json() as any
  return { res, body }
}

describe('self-serve loop: check → x402_pay_to → register → verify → publish', () => {
  it('check is idempotent and offers every proof; the second check does not fail on the active token', async () => {
    mockProviderOrigin()
    const env = makeEnv()
    const first = await (await handleProviderCheck(post('/v1/providers/check', { url: `${ORIGIN}/api/stablecoin-peg` }), env)).json() as any
    expect(first.domain_proof_status).toBe('issued')
    expect(first.dialect).toBe('x402')
    expect(first.stellar_payout_discovered).toBe(true)
    expect(first.discovered_networks).toEqual(['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'stellar:pubnet'])
    expect(first.ownership_proofs.map((p: any) => p.type)).toEqual(['wallet_signature', 'well_known', 'x402_pay_to'])
    expect(first.domain_proof.claim_secret).toBeTruthy()
    const second = await handleProviderCheck(post('/v1/providers/check', { url: `${ORIGIN}/api/stablecoin-peg` }), env)
    expect(second.status).toBe(200)
    const secondBody = await second.json() as any
    expect(secondBody.domain_proof_status).toBe('already_active')
    expect(secondBody.domain_proof).toBeNull()
    expect(secondBody.checks.find((c: any) => c.key === 'payment_configured').status).toBe('passed')
  })

  it('registers with the x402 payTo proof (no wallet signature), labels it honestly, then verifies, pays once and publishes', async () => {
    mockProviderOrigin()
    paidExecutor.mockResolvedValue(paidOk('payment-response', b64({ success: true, transaction: TX, network: 'stellar:pubnet' })))
    const env = makeEnv()

    const { res, body } = await registerAgent402(env)
    expect(res.status).toBe(201)
    expect(body.ownership_proof.type).toBe('x402_pay_to')
    expect(body.verification.ownership_proof_means).toMatch(/Not key custody/)
    expect(body.verification.domain_verified_at).toBeTruthy()
    expect(body.dashboard_token).toBeTruthy()
    expect(body.links.verification).toContain('/v1/providers/agent402/verification')

    const verified = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(verified.status).toBe(200)
    const v = await verified.json() as any
    expect(v.published).toBe(true)
    expect(v.status).toBe('published')
    expect(v.evidence.settlement_tx).toBe(TX)
    expect(v.evidence.settled_to).toBe(PROVIDER)
    expect(v.evidence.explorer_url).toBe(`https://stellar.expert/explorer/public/tx/${TX}`)
    expect(v.evidence.probe_402.dialect).toBe('x402')
    expect(v.evidence.probe_402.unlisted_networks).toEqual(['eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'])
    expect(v.verification.checks.map((c: any) => c.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed'])
    expect(v.links.listing).toBe('https://www.mpprouter.dev/providers/agent402')
    // The paid gate ran against the route the provider marked verify_with,
    // not the request-dependent search route.
    expect(paidExecutor.mock.calls[0][0].url).toBe(`${ORIGIN}/api/stablecoin-peg`)
    expect(paidExecutor).toHaveBeenCalledTimes(1)

    // Verify again: idempotent, nothing paid.
    const again = await (await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)).json() as any
    expect(again).toMatchObject({ published: true, idempotent: true })
    expect(paidExecutor).toHaveBeenCalledTimes(1)

    // Durable evidence page.
    const status = await (await handleProviderVerificationStatus(env, 'agent402')).json() as any
    expect(status.paid_gate.state).toBe('passed')
    expect(status.verification.paid_call_tx).toBe(TX)
    expect(status.verification.challenge_dialect).toBe('x402')

    // Automatic publication: the catalog now carries the route, relayed,
    // paying the provider's registered address, in the provider's dialect.
    const catalog = await listCatalogWithOverlay(env)
    const entry = catalog.find(e => e.id === 'agent402_web_search') as any
    expect(entry).toBeTruthy()
    expect(entry.settlement).toBe('direct')
    expect(entry.settlement_mode).toBe('relay')
    expect(entry.capability).toBe('web-search.v1')
    expect(entry.payment_hints.dialect).toBe('x402')
    expect(entry.payment_hints.pay_to).toBe(PROVIDER)
    expect(entry.operator.payouts).toEqual([{ network: 'stellar:pubnet', pay_to: PROVIDER, asset: 'USDC' }])
  })

  it('rejects the proof when the live 402 pays a different Stellar address, and stores nothing', async () => {
    mockProviderOrigin(agent402Challenge(OTHER))
    const env = makeEnv()
    const { res, body } = await registerAgent402(env)
    expect(res.status).toBe(401)
    expect(body).toMatchObject({ error: 'ownership_proof_rejected', code: 'pay_to_mismatch' })
    expect(env.kv.has('provider:agent402')).toBe(false)
  })

  it('fails the free probe with an actionable, safely-retryable reason when the price changed, paying nothing', async () => {
    const fetchMock = mockProviderOrigin()
    const env = makeEnv()
    await registerAgent402(env)
    fetchMock.mockImplementation(async () => challenge402(agent402Challenge(PROVIDER, '40000')))
    const res = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(res.status).toBe(422)
    const body = await res.json() as any
    expect(body).toMatchObject({ gate: 'probe-402', code: 'price_mismatch', can_safely_retry: true })
    expect(body.action).toMatch(/Nothing was paid/)
    expect(paidExecutor).not.toHaveBeenCalled()
    const status = await (await handleProviderVerificationStatus(env, 'agent402')).json() as any
    expect(status.next_action.can_safely_retry).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Retry safety and reconciliation
// ---------------------------------------------------------------------

describe('retry never pays twice; uncertain outcomes reconcile from the ledger', () => {
  it('paid but not served: frozen with the hash, retry is refused with the hash, one payment total', async () => {
    mockProviderOrigin()
    paidExecutor.mockResolvedValue(new Response('', { status: 500, headers: { 'payment-response': b64({ success: true, transaction: TX }) } }))
    const env = makeEnv()
    await registerAgent402(env)
    const first = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(first.status).toBe(422)
    const firstBody = await first.json() as any
    expect(firstBody).toMatchObject({ code: 'paid_call_not_200', can_safely_retry: false })
    expect(firstBody.evidence.settlement_tx).toBe(TX)

    const retry = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(retry.status).toBe(409)
    const retryBody = await retry.json() as any
    expect(retryBody).toMatchObject({ error: 'payment_outcome_uncertain', code: 'paid_not_served', settlement_tx: TX, can_safely_retry: false })
    expect(paidExecutor).toHaveBeenCalledTimes(1)

    const status = await (await handleProviderVerificationStatus(env, 'agent402')).json() as any
    expect(status.paid_gate.state).toBe('uncertain')
    expect(status.paid_gate.frozen_tx).toBe(TX)
    expect(status.paid_gate.reconciliation.status).toBe('paid_not_served')
    expect(status.status).toBe('pending')
  })

  it('served 200 but Horizon was down: the next verify reconciles from the hash and publishes without paying again', async () => {
    mockProviderOrigin()
    paidExecutor.mockResolvedValue(paidOk('payment-response', b64({ success: true, transaction: TX })))
    const env = makeEnv()
    await registerAgent402(env)
    horizon.status = 503
    const first = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(first.status).toBe(422)
    expect(await first.json()).toMatchObject({ code: 'settlement_unverified', can_safely_retry: false })

    horizon.status = 200
    const second = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(second.status).toBe(200)
    const body = await second.json() as any
    expect(body.published).toBe(true)
    expect(body.evidence.settlement_tx).toBe(TX)
    expect(body.evidence.real_money.detail).toMatch(/Reconciled from the ledger/)
    expect(paidExecutor).toHaveBeenCalledTimes(1)
  })

  it('a receipt naming a hash the ledger never saw is released after the grace period, and only then may pay again', async () => {
    mockProviderOrigin()
    paidExecutor.mockResolvedValue(paidOk('payment-response', b64({ success: true, transaction: TX })))
    const env = makeEnv()
    await registerAgent402(env)
    horizon.byHash[TX] = { status: 404 }
    expect((await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)).status).toBe(422)
    // Too soon: still frozen.
    const soon = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(soon.status).toBe(409)
    expect(await soon.json()).toMatchObject({ code: 'unresolved', settlement_tx: TX })
    expect(paidExecutor).toHaveBeenCalledTimes(1)
    // Age the claim past the grace period; the hash is still absent.
    const key = [...env.atomic.keys()].find((k: string) => k.startsWith('providerVerifyClaim:'))!
    const state = env.atomic.get(key)!
    const parsed = JSON.parse(state.value!)
    parsed.startedAt = new Date(Date.now() - 45 * 60_000).toISOString()
    state.value = JSON.stringify(parsed)
    const TX2 = 'b'.repeat(64)
    paidExecutor.mockResolvedValue(paidOk('payment-response', b64({ success: true, transaction: TX2 })))
    const later = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(later.status).toBe(200)
    expect((await later.json() as any).evidence.settlement_tx).toBe(TX2)
    expect(paidExecutor).toHaveBeenCalledTimes(2)
  })

  it('an in-flight claim answers 202 and does not start a second payment', async () => {
    mockProviderOrigin()
    let release!: () => void
    paidExecutor.mockImplementation(() => new Promise(resolve => { release = () => resolve(paidOk('payment-response', b64({ success: true, transaction: TX }))) }))
    const env = makeEnv()
    await registerAgent402(env)
    const inFlight = handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    await new Promise(r => setTimeout(r, 10))
    const concurrent = await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)
    expect(concurrent.status).toBe(202)
    expect(await concurrent.json()).toMatchObject({ status: 'verification_in_progress', can_safely_retry: false })
    release()
    expect((await inFlight).status).toBe(200)
    expect(paidExecutor).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------
// Relay: the router forwards the provider's own 402 and settles nothing
// ---------------------------------------------------------------------

describe('published provider routes are relayed', () => {
  async function publish(env: any) {
    mockProviderOrigin()
    paidExecutor.mockResolvedValue(paidOk('payment-response', b64({ success: true, transaction: TX })))
    await registerAgent402(env)
    expect((await handleProviderVerify(post('/v1/providers/verify', { id: 'agent402' }), env, ctx)).status).toBe(200)
    vi.restoreAllMocks()
    resetProviderCache()
  }

  it('forwards the buyer request with its payment credential and returns the provider 402 verbatim', async () => {
    const env = makeEnv()
    await publish(env)
    const route = await getRouteWithOverlay(env, '/v1/services/agent402/web-search', 'GET')
    expect(route?.operator?.id).toBe('agent402')

    const seen: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push(new Request(input, init))
      return challenge402(agent402Challenge(), { 'Payment-Required': b64(agent402Challenge()) })
    })
    const res = await handleProxy(new Request('https://router.test/v1/services/agent402/web-search?q=stellar', {
      headers: { 'PAYMENT-SIGNATURE': 'buyer-x402-payload', Authorization: 'Payment mppx-credential', 'CF-Connecting-IP': '1.2.3.4' },
    }), env, ctx)
    expect(res.status).toBe(402)
    expect(res.headers.get('payment-required')).toBe(b64(agent402Challenge()))
    expect(res.headers.get('x-mpp-router-settlement')).toBe('direct')
    expect(res.headers.get('x-mpp-router-provider')).toBe('agent402')
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`${ORIGIN}/api/search?q=stellar`)
    expect(seen[0].headers.get('payment-signature')).toBe('buyer-x402-payload')
    expect(seen[0].headers.get('authorization')).toBe('Payment mppx-credential')
    expect(seen[0].headers.get('cf-connecting-ip')).toBeNull()
    // Nothing in the router touched a claim, a ledger or a payment key.
    expect([...env.kv.keys()].filter(k => k.startsWith('order:') || k.startsWith('ledger'))).toEqual([])
  })

  it('records a served call as ok with latency and an unreachable provider as a provider fault', async () => {
    const env = makeEnv()
    await publish(env)
    const rows: any[] = []
    env.ROUTE_METRICS_DB = { prepare: () => ({ bind: (...args: any[]) => ({ run: async () => { rows.push(args) }, all: async () => ({ results: [] }) }) }) }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"results":[]}', { status: 200, headers: { 'payment-response': 'x' } }))
    const ok = await handleProxy(new Request('https://router.test/v1/services/agent402/web-search?q=a', { headers: { 'PAYMENT-SIGNATURE': 'p' } }), env, { waitUntil: (p: Promise<any>) => p } as any)
    expect(ok.status).toBe(200)
    await new Promise(r => setTimeout(r, 5))
    expect(rows[0]).toContain('agent402')
    expect(rows[0]).toContain('ok')
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const down = await handleProxy(new Request('https://router.test/v1/services/agent402/web-search?q=a'), env, { waitUntil: (p: Promise<any>) => p } as any)
    expect(down.status).toBe(502)
    expect(await down.json()).toMatchObject({ charged: false, settlement: 'direct' })
    await new Promise(r => setTimeout(r, 5))
    expect(rows[1]).toContain('provider_fault')
  })
})

// ---------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------

function candidate(over: Partial<Candidate> & { provider_id: string }): Candidate {
  return {
    provider_name: over.provider_id, route_id: `${over.provider_id}_search`, operation: 'search', public_path: `/v1/services/${over.provider_id}/search`,
    method: 'GET', price_usd: '0.02', health_status: 'healthy', dialect: 'x402', pay_to: { network: 'stellar:pubnet', address: PROVIDER },
    metrics: { window: '7d', calls: 0, attributable: 0, provider_success_rate: null, latency_p50_ms: null, last_call_at: null, sample_status: 'none' },
    eligible: true, reason: '', tier: 1,
    ...over,
  }
}

describe('quality selection', () => {
  it('ranks deterministically: data beats unknown, unknown beats degraded, offline is out; ties by price then id', () => {
    const ranked = rankCandidates([
      candidate({ provider_id: 'zeta-unknown', price_usd: '0.01' }),
      candidate({ provider_id: 'alpha-unknown', price_usd: '0.01' }),
      candidate({ provider_id: 'offline', health_status: 'offline', eligible: false, tier: 3 }),
      candidate({ provider_id: 'slow-good', tier: 0, metrics: { window: '7d', calls: 20, attributable: 20, provider_success_rate: 0.99, latency_p50_ms: 900, last_call_at: 'x', sample_status: 'sufficient' } }),
      candidate({ provider_id: 'fast-good', tier: 0, metrics: { window: '7d', calls: 20, attributable: 20, provider_success_rate: 0.99, latency_p50_ms: 200, last_call_at: 'x', sample_status: 'sufficient' } }),
      candidate({ provider_id: 'degraded-perfect', health_status: 'degraded', tier: 2, metrics: { window: '7d', calls: 50, attributable: 50, provider_success_rate: 1, latency_p50_ms: 10, last_call_at: 'x', sample_status: 'sufficient' } }),
      candidate({ provider_id: 'best-rate', tier: 0, metrics: { window: '7d', calls: 20, attributable: 20, provider_success_rate: 1, latency_p50_ms: 800, last_call_at: 'x', sample_status: 'sufficient' } }),
    ])
    expect(ranked.map(c => c.provider_id)).toEqual(['best-rate', 'fast-good', 'slow-good', 'alpha-unknown', 'zeta-unknown', 'degraded-perfect', 'offline'])
  })

  it('selects only among routes declaring the same capability, excludes offline, handles insufficient and stale samples, and never substitutes a pinned provider', async () => {
    const env = makeEnv()
    const now = Date.parse('2026-09-12T00:00:00Z')
    const mk = (id: string, health: string, capability?: string) => ({
      id, name: id, email: 'a@b.co', apiBaseUrl: `https://${id}.example`, status: 'published',
      payouts: [{ network: 'stellar:pubnet', payTo: PROVIDER, asset: 'USDC' }],
      routes: [{ operation: 'search', method: 'GET', upstreamPath: '/s', priceUsd: '0.02', ...(capability ? { capability } : {}) }],
      verification: { healthStatus: health, challengeDialect: 'x402', paidCallAt: 'x' }, createdAt: 'x', updatedAt: 'x',
      ownerKey: { network: 'stellar:pubnet', address: PROVIDER },
    })
    env.kv.set('providerIndex:v1', JSON.stringify({ providers: [
      mk('fresh', 'healthy', 'web-search.v1'), mk('few', 'healthy', 'web-search.v1'), mk('stale', 'healthy', 'web-search.v1'),
      mk('dead', 'offline', 'web-search.v1'), mk('samename', 'healthy'), mk('other-cap', 'healthy', 'web-extract.v1'),
    ], builtAt: 'x' }))
    const rowsFor: Record<string, any[]> = {
      fresh: Array.from({ length: 6 }, () => ({ outcome: 'ok', refunded: 0, latency_ms: 300, created_at: now - 3_600_000 })),
      few: [{ outcome: 'ok', refunded: 0, latency_ms: 50, created_at: now - 3_600_000 }],
      stale: Array.from({ length: 9 }, () => ({ outcome: 'ok', refunded: 0, latency_ms: 20, created_at: now - 3 * 24 * 3_600_000 })),
      dead: Array.from({ length: 9 }, () => ({ outcome: 'ok', refunded: 0, latency_ms: 20, created_at: now - 60_000 })),
    }
    env.ROUTE_METRICS_DB = { prepare: () => ({ bind: (id: string) => ({ all: async () => ({ results: rowsFor[id] ?? [] }) }) }) }

    const r = await selectProvider(env, { capability: 'web-search.v1', now }) as any
    expect(r.selected.provider_id).toBe('fresh')
    expect(r.selected.metrics.sample_status).toBe('sufficient')
    expect(r.candidates.map((c: any) => [c.provider_id, c.tier, c.metrics.sample_status, c.eligible])).toEqual([
      ['fresh', 0, 'sufficient', true], ['few', 1, 'insufficient', true], ['stale', 1, 'stale', true], ['dead', 3, 'sufficient', false],
    ])
    expect(r.candidates.find((c: any) => c.provider_id === 'samename')).toBeUndefined()
    expect(r.candidates.find((c: any) => c.provider_id === 'other-cap')).toBeUndefined()
    // Recipient is named before any quote.
    expect(r.selected.pay_to).toEqual({ network: 'stellar:pubnet', address: PROVIDER })
    expect(r.selected.public_path).toBe('/v1/services/fresh/search')

    const pinned = await selectProvider(env, { capability: 'web-search.v1', provider: 'few', now }) as any
    expect(pinned.selected.provider_id).toBe('few')
    const pinnedOffline = await selectProvider(env, { capability: 'web-search.v1', provider: 'dead', now }) as any
    expect(pinnedOffline.selected).toBeNull()
    expect(pinnedOffline.error.code).toBe('pinned_provider_offline')
    const pinnedMissing = await selectProvider(env, { capability: 'web-search.v1', provider: 'samename', now }) as any
    expect(pinnedMissing.error.code).toBe('pinned_provider_not_found')
    const unknownCap = await selectProvider(env, { capability: 'nope.v9', now }) as any
    expect(unknownCap.error.code).toBe('unknown_capability')
  })

  it('a registration may only declare a known capability with the matching method', async () => {
    mockProviderOrigin()
    const env = makeEnv()
    const bad = await handleProviderRegister(post('/v1/providers/register', {
      ...registration, routes: [{ ...registration.routes[1], capability: 'search-ish' }],
    }), env)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_registration', field: 'routes' })
    const wrongMethod = await handleProviderRegister(post('/v1/providers/register', {
      ...registration, routes: [{ ...registration.routes[1], method: 'POST', capability: 'web-search.v1' }],
    }), env)
    expect(wrongMethod.status).toBe(400)
  })
})
