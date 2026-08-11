/**
 * Launch gate escape hatch for verifiedMode:false routes (P1 fix, codex
 * review 2026-08-12).
 *
 * A brand-new router-held-credential route (Mercury MVP) ships
 * `verifiedMode: false` until an operator has run one real paid call
 * end-to-end. But the SECURITY GATE in proxy.ts 403s every
 * `verifiedMode === false` route unconditionally — with no escape hatch
 * that first real call could never happen, so verifiedMode could never
 * flip away from `false`. `route.launchGate` names an Env var; when that
 * var is literally `'verify'`, the gate lets the route through despite
 * `verifiedMode === false` — any other value (including unset) still
 * 403s, so the route stays closed to the public and is only reachable
 * when the operator has deliberately flipped the var for their own test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PublicServiceRoute } from '../src/services/merchants-types'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const GATED_ROUTE: PublicServiceRoute = {
  id: 'mercury_events_by_ledger',
  service: 'mercury',
  operation: 'events_by_ledger',
  name: 'Mercury – Events by ledger',
  categories: ['blockchain'],
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
  verifiedMode: false,
  upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' },
  fixedPricing: { amountUsd: '0.0005' },
  rateLimit: { perDay: 1000 },
  launchGate: 'MERCURY_LAUNCH_MODE',
}

vi.mock('../src/services/merchants', async () => {
  const actual = await vi.importActual<typeof import('../src/services/merchants')>(
    '../src/services/merchants',
  )
  return {
    ...actual,
    getRouteByPublicPath: (pathname: string, method: string) =>
      pathname === GATED_ROUTE.publicPath && method.toUpperCase() === GATED_ROUTE.method
        ? GATED_ROUTE
        : undefined,
    getAllowedMethodsForPath: (pathname: string) =>
      pathname === GATED_ROUTE.publicPath ? [GATED_ROUTE.method] : [],
  }
})

import { handleProxy } from '../src/routes/proxy'
import type { Env } from '../src/index'

/**
 * Env whose every secret/KV access throws — a 403 proves the gate
 * refused from the route table alone, before touching any credential or
 * making an upstream call. Deliberately does NOT set MERCURY_LAUNCH_MODE
 * (undefined) unless overridden.
 */
function makeTrapEnv(overrides: Partial<Env> = {}): Env {
  const trap = (label: string) => () => {
    throw new Error(`must not reach ${label} — the gate should have refused first`)
  }
  const MPP_STORE = {
    get: trap('MPP_STORE.get'),
    put: trap('MPP_STORE.put'),
    delete: trap('MPP_STORE.delete'),
    list: trap('MPP_STORE.list'),
    getWithMetadata: trap('MPP_STORE.getWithMetadata'),
  } as unknown as KVNamespace
  return {
    MPP_STORE,
    ATOMIC_STORE: makeAtomicStoreMock(),
    STELLAR_NETWORK: 'stellar:pubnet',
    X402_ENABLED: 'false',
    // Needed only to build the router's OWN fixed-price 402 challenge
    // (mppx's HMAC opaque) when the gate lets the route through — not a
    // real secret/keypair, just syntactically valid enough for the local
    // challenge-building code path to not throw. No upstream/network
    // call happens in that test — no signing, no RPC.
    MPP_SECRET_KEY: 'test-only-not-a-real-secret-0123456789abcdef',
    // A syntactically valid (but not privately held) Stellar StrKey
    // public address — only used as the `recipient` field on the 402
    // challenge our own router issues, never signed against.
    STELLAR_ROUTER_PUBLIC: 'GBBFJR2T7Q2SOHI2YA7ORKENONGKKG5SZO4MW2UAWZWF63SBHY3GYQ2H',
    ...overrides,
  } as unknown as Env
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
}

function request(): Request {
  return new Request('https://apiserver.mpprouter.dev/v1/services/mercury/events/by-ledger', {
    method: 'GET',
  })
}

describe('SECURITY GATE launch-gate bypass', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy?.mockRestore()
  })

  it('403s a verifiedMode:false route with the launch gate unset (today\'s default)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await handleProxy(request(), makeTrapEnv(), makeCtx())
    expect(res.status).toBe(403)
    expect((await res.json() as any).error).toBe('Route not enabled for payment')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('403s when the launch gate var is set to anything other than the exact string "verify"', async () => {
    for (const wrongValue of ['true', '1', 'VERIFY', 'verified', '']) {
      const res = await handleProxy(
        request(),
        makeTrapEnv({ MERCURY_LAUNCH_MODE: wrongValue } as Partial<Env>),
        makeCtx(),
      )
      expect(res.status).toBe(403)
    }
  })

  it('lets the route through the gate (reaches the real payment flow, not the blanket 403) when MERCURY_LAUNCH_MODE=verify', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await handleProxy(
      request(),
      makeTrapEnv({ MERCURY_LAUNCH_MODE: 'verify' } as Partial<Env>),
      makeCtx(),
    )
    // No credential was presented, so the route issues its own 402
    // fixed-price challenge (never the merchant, per fixedPricing) —
    // proof the request reached past the SECURITY GATE into the normal
    // payment negotiation, not the generic 403 refusal.
    expect(res.status).toBe(402)
    expect(res.status).not.toBe(403)
    const wwwAuth = res.headers.get('www-authenticate')
    expect(wwwAuth).toMatch(/method="stellar"/)
    // Still never touched the upstream merchant — no credential yet.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a route with no launchGate at all is unaffected by any env var value (old-route path unchanged)', async () => {
    const ungatedRoute: PublicServiceRoute = { ...GATED_ROUTE, launchGate: undefined }
    const modMod = await import('../src/services/merchants')
    const spy = vi.spyOn(modMod, 'getRouteByPublicPath').mockImplementation(
      (pathname: string, method: string) =>
        pathname === ungatedRoute.publicPath && method.toUpperCase() === ungatedRoute.method
          ? ungatedRoute
          : undefined,
    )
    try {
      const res = await handleProxy(
        request(),
        makeTrapEnv({ MERCURY_LAUNCH_MODE: 'verify' } as Partial<Env>),
        makeCtx(),
      )
      // launchGate is undefined, so the env var is irrelevant — still 403.
      expect(res.status).toBe(403)
    } finally {
      spy.mockRestore()
    }
  })
})
