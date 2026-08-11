/**
 * Mercury MVP: fixed-price + router-held-credential proxy path.
 *
 * Locks in the four behaviors from the design doc
 * (ainative todos/20260811-mercury-mpp-router-integration-design.md):
 *
 *   1. A fixed-pricing route issues the router's OWN 402 challenge (no
 *      unpaid merchant probe — a single unauthenticated fetch to a
 *      router-held-credential upstream would just 401, not "free").
 *   2. Once the agent pays, the router calls the upstream DIRECTLY with
 *      `upstreamAuth` injected — never via Tempo/payMerchant.
 *   3. `rateLimit.perDay` is enforced BEFORE any payment step: over cap
 *      → 429 + Retry-After, and no fetch call is made at all (no money
 *      taken, no upstream contact).
 *   4. The injected credential is never derivable from the response the
 *      test asserts on (defence in depth for "never log the secret").
 *
 * Uses a mocked `../src/services/merchants` module so this suite doesn't
 * depend on any real catalog route's `verifiedMode` (Mercury's real
 * catalog entries ship `verifiedMode:false` until the first paid run —
 * see merchants.ts OPERATOR_OVERLAY — so a real-catalog round trip would
 * always 403 before reaching this code path).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Credential } from 'mppx'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { PublicServiceRoute } from '../src/services/merchants-types'

/**
 * Reuse real-shaped Stellar keypairs from `.dev.vars` (gitignored local
 * secrets) so `createStellarPayment` gets valid StrKey material — a
 * hand-typed fake secret fails StrKey checksum validation before the
 * test ever reaches the code under test. Never printed/logged/committed;
 * suite self-skips when `.dev.vars` is absent (fresh clone / CI), same
 * pattern as tests/proxy.test.ts.
 */
function loadDevVars(): Record<string, string> | null {
  const path = resolve(__dirname, '..', '.dev.vars')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const FIXED_ROUTE: PublicServiceRoute = {
  id: 'mercury_events_by_ledger',
  service: 'mercury',
  operation: 'events_by_ledger',
  name: 'Mercury – Events by ledger',
  categories: ['blockchain', 'stellar', 'indexer'],
  description: 'test',
  method: 'GET',
  price: '$0.0005/request',
  paymentMethod: 'stellar',
  upstreamPaymentMethod: 'tempo.charge',
  network: 'stellar-mainnet',
  asset: 'USDC',
  publicPath: '/v1/services/mercury/events/by-ledger',
  upstreamHost: 'mainnet.mercurydata.app',
  upstreamPath: '/rest/events/by-ledger',
  verifiedMode: 'charge',
  upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' },
  fixedPricing: { amountUsd: '0.0005' },
  rateLimit: { perDay: 2 },
}

vi.mock('../src/services/merchants', async () => {
  const actual = await vi.importActual<typeof import('../src/services/merchants')>(
    '../src/services/merchants',
  )
  return {
    ...actual,
    getRouteByPublicPath: (pathname: string, method: string) =>
      pathname === FIXED_ROUTE.publicPath && method.toUpperCase() === FIXED_ROUTE.method
        ? FIXED_ROUTE
        : undefined,
    getAllowedMethodsForPath: (pathname: string) =>
      pathname === FIXED_ROUTE.publicPath ? [FIXED_ROUTE.method] : [],
  }
})

// payMerchant/payMerchantSession must NEVER be called for a fixedPricing +
// upstreamAuth route — the whole point is bypassing Tempo.
const { payMerchantSpy, payMerchantSessionSpy } = vi.hoisted(() => ({
  payMerchantSpy: vi.fn(async () => {
    throw new Error('payMerchant must not be called for an upstreamAuth route')
  }),
  payMerchantSessionSpy: vi.fn(async () => {
    throw new Error('payMerchantSession must not be called for an upstreamAuth route')
  }),
}))
vi.mock('../src/mpp/tempo-client', () => ({
  payMerchant: payMerchantSpy,
  payMerchantSession: payMerchantSessionSpy,
  ChannelNotInstalledError: class ChannelNotInstalledError extends Error {},
}))

import { handleProxy } from '../src/routes/proxy'
import { checkAndBumpDailyLimit, utcDateKey } from '../src/mpp/rate-limit-do'
import type { Env } from '../src/index'

const MERCURY_TOKEN = 'test-mercury-jwt-do-not-use'

function freshKv(): KVNamespace {
  const kv = new Map<string, string>()
  return {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => { kv.set(key, value) },
    delete: async (key: string) => { kv.delete(key) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
}

function requireVar(vars: Record<string, string>, name: string): string {
  const v = vars[name]
  if (!v) throw new Error(`Missing ${name} in .dev.vars`)
  return v
}

const devVars = loadDevVars()
const STELLAR_ROUTER_PUBLIC = devVars ? requireVar(devVars, 'STELLAR_ROUTER_PUBLIC') : ''

function makeEnv(overrides: Partial<Env> = {}): Env {
  if (!devVars) throw new Error('.dev.vars missing — suite is skipped in CI')
  return {
    MPP_STORE: freshKv(),
    ATOMIC_STORE: makeAtomicStoreMock(),
    STELLAR_ROUTER_PUBLIC,
    STELLAR_GAS_SECRET: requireVar(devVars, 'STELLAR_GAS_SECRET'),
    STELLAR_GAS_PUBLIC: requireVar(devVars, 'STELLAR_GAS_PUBLIC'),
    STELLAR_NETWORK: devVars.STELLAR_NETWORK ?? 'stellar:testnet',
    STELLAR_RPC_URL: devVars.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    TEMPO_ROUTER_PRIVATE_KEY: requireVar(devVars, 'TEMPO_ROUTER_PRIVATE_KEY'),
    TEMPO_ROUTER_ADDRESS: requireVar(devVars, 'TEMPO_ROUTER_ADDRESS'),
    TEMPO_RPC_URL: devVars.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz',
    MPP_SECRET_KEY: requireVar(devVars, 'MPP_SECRET_KEY'),
    OPTIMISTIC_THRESHOLD: devVars.OPTIMISTIC_THRESHOLD ?? '0.05',
    RATE_LIMIT_MAX: devVars.RATE_LIMIT_MAX ?? '10',
    X402_ENABLED: 'false',
    MERCURYDATA_MAINNET_JWT: MERCURY_TOKEN,
    ...overrides,
  } as unknown as Env
}

function makeCtx(waited: Promise<unknown>[] = []): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => { waited.push(p) },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}

function request(): Request {
  return new Request('https://apiserver.mpprouter.dev/v1/services/mercury/events/by-ledger', {
    method: 'GET',
  })
}

describe.skipIf(!loadDevVars())('Mercury fixed-price / upstreamAuth proxy path', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    payMerchantSpy.mockClear()
    payMerchantSessionSpy.mockClear()
    fetchSpy?.mockRestore()
  })

  it('issues its own 402 for a no-credential request WITHOUT probing the upstream', async () => {
    const env = makeEnv()
    fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await handleProxy(request(), env, makeCtx())

    expect(response.status).toBe(402)
    const wwwAuth = response.headers.get('www-authenticate')
    expect(wwwAuth).toBeTruthy()
    // amountUsd "0.0005" at 6dp === base units "500"
    expect(wwwAuth).toMatch(/method="stellar"/)
    // No upstream fetch — the router built the 402 itself, it never
    // touched mainnet.mercurydata.app for a route it hasn't been paid on.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // P1 fix (codex review 2026-08-12): the unpaid/handshake leg (no
  // credential presented yet — the agent's very first round-trip, which
  // only gets the router's own 402 challenge) must NOT consume a
  // rate-limit slot. Before this fix, checkAndBumpDailyLimit ran
  // unconditionally here, so a 1,000/day cap became ~500 real calls
  // (every real call is preceded by one unpaid probe) and unauthenticated
  // spam could burn the whole daily allowance without a single upstream
  // call. The gate is now a non-consuming peek; only a verified paid
  // request consumes (see `mercury-rate-limit-do.test.ts` for
  // `peekDailyLimit` unit coverage of the primitive itself).
  it('the unpaid 402 handshake leg never consumes the rate-limit cap, however many times it repeats', async () => {
    const env = makeEnv()
    fetchSpy = vi.spyOn(globalThis, 'fetch')

    // perDay is 2 on FIXED_ROUTE, but we fire 5 unauthenticated requests —
    // if the old bug were still present, request #3 would already 429.
    const responses = []
    for (let i = 0; i < 5; i++) {
      responses.push(await handleProxy(request(), env, makeCtx()))
    }
    for (const r of responses) {
      expect(r.status).toBe(402)
    }
    expect(fetchSpy).not.toHaveBeenCalled()

    // Prove the counter itself never moved: the DO's first REAL
    // (consuming) check still sees a fully fresh cap.
    const key = `ratelimit:${FIXED_ROUTE.service}:${utcDateKey()}`
    const firstRealConsume = await checkAndBumpDailyLimit(env, key, FIXED_ROUTE.rateLimit!.perDay)
    expect(firstRealConsume).toEqual({ ok: true, used: 1, limit: FIXED_ROUTE.rateLimit!.perDay })
  })

  it('still blocks with 429 + Retry-After when the cap is genuinely exhausted, before any fetch — even on the unpaid leg', async () => {
    const env = makeEnv()

    // Simulate the cap already having been consumed by real paid calls
    // (the only leg allowed to consume it) on a prior request.
    const key = `ratelimit:${FIXED_ROUTE.service}:${utcDateKey()}`
    await checkAndBumpDailyLimit(env, key, FIXED_ROUTE.rateLimit!.perDay)
    await checkAndBumpDailyLimit(env, key, FIXED_ROUTE.rateLimit!.perDay)

    fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r3 = await handleProxy(request(), env, makeCtx())

    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBeTruthy()
    const body = await r3.json() as any
    expect(body.error).toMatch(/rate limit/i)
    // Still no upstream contact and no payment step reached.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an unrecognized (non-mppx-shaped) credential passes through untouched and never leaks the router-held Mercury secret', async () => {
    const env = makeEnv()

    // Step 1: no-credential request to get the router's own HMAC-bound 402.
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    const challenge = await handleProxy(request(), env, makeCtx())
    expect(challenge.status).toBe(402)
    const wwwAuth = challenge.headers.get('www-authenticate')!

    // Step 2: mock the upstream response for the real paid call.
    let capturedUpstreamRequest: { url: string; headers: Headers } | undefined
    fetchSpy.mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined))
      capturedUpstreamRequest = { url, headers }
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    // A credential classifyAuth doesn't recognize as Stellar MPP/x402
    // (unrelated Bearer scheme) takes the generic transparent-passthrough
    // branch — router-agnostic, pre-existing behavior. The invariant this
    // test locks in for a router-held-credential (upstreamAuth) route
    // specifically: passthrough forwards the AGENT's own header, and
    // NEVER the router's injected Mercury secret (`injectUpstreamAuth`
    // only runs on the paid, verified path inside `payMerchantAndGetBody`
    // — never on this fallback).
    const agentBearer = 'Bearer agent-own-unrelated-token'
    const retry = await handleProxy(
      new Request('https://apiserver.mpprouter.dev/v1/services/mercury/events/by-ledger', {
        method: 'GET',
        headers: { Authorization: agentBearer },
      }),
      env,
      makeCtx(),
    )
    expect(retry.status).toBe(200)
    expect(payMerchantSpy).not.toHaveBeenCalled()
    expect(payMerchantSessionSpy).not.toHaveBeenCalled()
    expect(capturedUpstreamRequest).toBeDefined()
    // The agent's own header went upstream (transparent passthrough)...
    expect(capturedUpstreamRequest!.headers.get('authorization')).toBe(agentBearer)
    // ...and it is NOT the router-held Mercury secret in any form.
    expect(capturedUpstreamRequest!.headers.get('authorization')).not.toContain(MERCURY_TOKEN)
  })
})
