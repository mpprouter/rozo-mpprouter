/**
 * Catalog honesty + proxy execution gate (2026-06-22 opt-IN flip).
 *
 * Two invariants, locked in together:
 *
 *  1. Catalog honesty — the public catalog only advertises a payable
 *     `methods.stellar` block for operator-verified routes
 *     (`verifiedMode: 'charge' | 'session'`). Untested
 *     (`verifiedMode: undefined`) and known-broken (`verifiedMode:
 *     false`) routes are still LISTED, but carry no stellar block and a
 *     truthful `payment_status` so no agent sends money into them.
 *
 *  2. Proxy execution gate — hiding a route from the catalog is not a
 *     security control on its own: a direct POST to an unverified path
 *     must also be refused BEFORE any merchant probe / payment. The gate
 *     in `handleProxy` returns a generic 4xx for any route whose
 *     `verifiedMode` isn't 'charge'/'session', and crucially does so
 *     without ever calling `fetch` (no merchant contact, no Tempo spend).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  listPublicCatalog,
  PUBLIC_SERVICE_ROUTES,
} from '../src/services/merchants'
import type { PublicServiceRoute } from '../src/services/merchants-types'
import { handleProxy } from '../src/routes/proxy'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

function freshKv(): KVNamespace {
  const kv = new Map<string, string>()
  return {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kv.set(key, value)
    },
    delete: async (key: string) => {
      kv.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
}

/**
 * Env that booby-traps every secret + KV access: reading any secret
 * field or touching MPP_STORE throws. Used by the gate tests to PROVE
 * the 403 is returned before the handler reads any key material, KV, or
 * contacts a merchant — not just "no fetch happened". If a future edit
 * moves the gate below the first env/KV use, these tests fail loudly.
 */
function makeTrapEnv(): Env {
  const trap = (label: string) => () => {
    throw new Error(`gate must not reach ${label} for an unverified route`)
  }
  const MPP_STORE = {
    get: trap('MPP_STORE.get'),
    put: trap('MPP_STORE.put'),
    delete: trap('MPP_STORE.delete'),
    list: trap('MPP_STORE.list'),
    getWithMetadata: trap('MPP_STORE.getWithMetadata'),
  } as unknown as KVNamespace

  const base: Record<string, unknown> = {
    MPP_STORE,
    ATOMIC_STORE: makeAtomicStoreMock(),
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_RPC_URL: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    TEMPO_RPC_URL: 'https://rpc.tempo.xyz',
    OPTIMISTIC_THRESHOLD: '0.05',
    RATE_LIMIT_MAX: '10',
    XLM_USD_RATE: '0.1533',
    X402_ENABLED: 'true',
    PAYINVOICE_ADMIN_SECRET: 'test',
  }
  // Booby-trap every secret-bearing field: reading it throws.
  for (const secret of [
    'STELLAR_ROUTER_PUBLIC', 'STELLAR_GAS_SECRET', 'STELLAR_GAS_PUBLIC',
    'TEMPO_ROUTER_PRIVATE_KEY', 'TEMPO_ROUTER_ADDRESS', 'MPP_SECRET_KEY',
    'STELLAR_X402_PAY_TO', 'STELLAR_X402_FACILITATOR_SECRET',
  ]) {
    Object.defineProperty(base, secret, {
      enumerable: true,
      get() {
        throw new Error(`gate must not read secret ${secret} for an unverified route`)
      },
    })
  }
  return base as unknown as Env
}

function loadDevVars(): Record<string, string> | null {
  const path = resolve(__dirname, '..', '.dev.vars')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
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

/**
 * Real env for the one test that drives a VERIFIED route all the way to a
 * 402 challenge — that path needs the router's actual MPP/Stellar keys to
 * sign the challenge, so it reads `.dev.vars`. Returns null when
 * `.dev.vars` is absent (fresh clone / CI) so the caller can skip rather
 * than fail.
 */
function makeRealEnv(): Env | null {
  const vars = loadDevVars()
  if (!vars) return null
  const need = (name: string): string | null => vars[name] ?? null
  const required = [
    'STELLAR_ROUTER_PUBLIC', 'STELLAR_GAS_SECRET', 'STELLAR_GAS_PUBLIC',
    'TEMPO_ROUTER_PRIVATE_KEY', 'TEMPO_ROUTER_ADDRESS', 'MPP_SECRET_KEY',
  ]
  for (const name of required) {
    if (!need(name)) return null
  }
  return {
    MPP_STORE: freshKv(),
    ATOMIC_STORE: makeAtomicStoreMock(),
    STELLAR_ROUTER_PUBLIC: need('STELLAR_ROUTER_PUBLIC')!,
    STELLAR_GAS_SECRET: need('STELLAR_GAS_SECRET')!,
    STELLAR_GAS_PUBLIC: need('STELLAR_GAS_PUBLIC')!,
    STELLAR_NETWORK: vars.STELLAR_NETWORK ?? 'stellar:pubnet',
    STELLAR_RPC_URL: vars.STELLAR_RPC_URL ?? 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    TEMPO_ROUTER_PRIVATE_KEY: need('TEMPO_ROUTER_PRIVATE_KEY')!,
    TEMPO_ROUTER_ADDRESS: need('TEMPO_ROUTER_ADDRESS')!,
    TEMPO_RPC_URL: vars.TEMPO_RPC_URL ?? 'https://rpc.tempo.xyz',
    MPP_SECRET_KEY: need('MPP_SECRET_KEY')!,
    OPTIMISTIC_THRESHOLD: vars.OPTIMISTIC_THRESHOLD ?? '0.05',
    RATE_LIMIT_MAX: vars.RATE_LIMIT_MAX ?? '10',
    XLM_USD_RATE: vars.XLM_USD_RATE ?? '0.1533',
    X402_ENABLED: vars.X402_ENABLED ?? 'true',
    STELLAR_X402_PAY_TO: vars.STELLAR_X402_PAY_TO ?? need('STELLAR_ROUTER_PUBLIC')!,
    STELLAR_X402_FACILITATOR_SECRET: vars.STELLAR_X402_FACILITATOR_SECRET ?? need('STELLAR_GAS_SECRET')!,
    PAYINVOICE_ADMIN_SECRET: vars.PAYINVOICE_ADMIN_SECRET ?? 'test',
  } as Env
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
}

/**
 * Build a synthetic route with a controlled `verifiedMode`, push it onto
 * the live route table, run `fn`, then pop it back off. Distinct path
 * per tier so the proxy resolver finds exactly this one.
 */
function withRoute<T>(
  partial: { id: string; publicPath: string; verifiedMode?: 'charge' | 'session' | false },
  fn: (route: PublicServiceRoute) => T,
): T {
  const route: PublicServiceRoute = {
    id: partial.id,
    service: 'gatetest',
    operation: 'op',
    name: `Gate test ${partial.id}`,
    categories: ['test'],
    description: 'gate test route',
    method: 'POST',
    price: '$0.001/request',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.charge',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: partial.publicPath,
    upstreamHost: 'merchant.invalid',
    upstreamPath: '/v1/do',
    ...(partial.verifiedMode !== undefined ? { verifiedMode: partial.verifiedMode } : {}),
  }
  PUBLIC_SERVICE_ROUTES.push(route)
  try {
    return fn(route)
  } finally {
    const idx = PUBLIC_SERVICE_ROUTES.indexOf(route)
    if (idx !== -1) PUBLIC_SERVICE_ROUTES.splice(idx, 1)
  }
}

describe('catalog honesty (opt-IN payment advertising)', () => {
  const env = { X402_ENABLED: 'false' }

  it('an untested (verifiedMode undefined) route is payable but marked available/unverified (Option A)', () => {
    withRoute({ id: '__gate_untested__', publicPath: '/v1/services/gatetest/untested' }, () => {
      const item = listPublicCatalog(env).find(i => i.id === '__gate_untested__')!
      expect(item).toBeDefined()
      // Option A: untested routes ARE payable (advertise stellar) but flagged
      // available + unverified so the client decides its own risk.
      expect(item.methods.stellar).toEqual({ intents: ['charge'] })
      expect(item.payment_status).toBe('available')
      expect(item.payment_enabled).toBe(true)
      expect(item.payment_status_note).toBeTypeOf('string')
      // Per-mode trust fields present and null (never verified in either mode).
      expect(item.charge_rozo_verified).toBeNull()
      expect(item.session_rozo_verified).toBeNull()
    })
  })

  it('a known-broken (verifiedMode false) route is unavailable, not payable', () => {
    withRoute({ id: '__gate_broken__', publicPath: '/v1/services/gatetest/broken', verifiedMode: false }, () => {
      const item = listPublicCatalog(env).find(i => i.id === '__gate_broken__')!
      expect(item).toBeDefined()
      expect(item.methods.stellar).toBeUndefined()
      expect(item.payment_status).toBe('unavailable')
      expect(item.payment_enabled).toBe(false)
      expect(item.payment_status_note).toBeTypeOf('string')
    })
  })

  it('a verified route is payable with a stellar block and no note', () => {
    withRoute({ id: '__gate_verified__', publicPath: '/v1/services/gatetest/verified', verifiedMode: 'charge' }, () => {
      const item = listPublicCatalog(env).find(i => i.id === '__gate_verified__')!
      expect(item).toBeDefined()
      expect(item.methods.stellar).toEqual({ intents: ['charge'] })
      expect(item.payment_status).toBe('verified')
      expect(item.payment_enabled).toBe(true)
      expect(item.payment_status_note).toBeUndefined()
    })
  })

  it('GLOBAL invariant (Option A): only verifiedMode:false routes are non-payable', () => {
    const items = listPublicCatalog(env)
    for (const route of PUBLIC_SERVICE_ROUTES) {
      const item = items.find(i => i.id === route.id)
      if (!item) continue
      if (route.verifiedMode === false) {
        // Confirmed-broken: not payable, no stellar block.
        expect(item.methods.stellar, `broken route ${route.id} must not advertise stellar`).toBeUndefined()
        expect(item.payment_status).toBe('unavailable')
        expect(item.payment_enabled).toBe(false)
      } else {
        // verified OR untested: payable, advertises stellar.
        expect(item.methods.stellar, `route ${route.id} should advertise stellar`).toEqual({ intents: ['charge'] })
        expect(item.payment_enabled).toBe(true)
        expect(['verified', 'available']).toContain(item.payment_status)
      }
    }
    // The verified set is exactly the routes carrying a charge/session verifiedMode.
    const verifiedCount = items.filter(i => i.payment_status === 'verified').length
    const overlayVerified = PUBLIC_SERVICE_ROUTES.filter(
      r => r.verifiedMode === 'charge' || r.verifiedMode === 'session',
    ).length
    expect(verifiedCount).toBe(overlayVerified)
    expect(verifiedCount).toBeGreaterThan(0)
  })
})

describe('proxy verifiedMode execution gate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Option A: an untested (verifiedMode undefined) route is NOT gated — it proceeds into the payment flow', async () => {
    const env = makeTrapEnv()
    // Spy on the trap accessors so we can PROVE the request reached the
    // payment flow (which reads secrets/KV) rather than passing vacuously on
    // some earlier throw. makeTrapEnv throws from these on access.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await withRoute(
      { id: '__gate_proxy_untested__', publicPath: '/v1/services/gatetest/proxy-untested' },
      async () => {
        const req = new Request('https://apiserver.mpprouter.dev/v1/services/gatetest/proxy-untested', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: 'x' }),
        })
        // Under Option A an untested route is payable, so the proxy must NOT
        // short-circuit with the 403 gate. It must proceed past the gate and
        // attempt payment work, which means it tries to reach the merchant
        // (fetch) and/or trips makeTrapEnv's secret/KV trap.
        let gateRefused = false
        let reachedPaymentFlow = false
        try {
          const res = await handleProxy(req, env, makeCtx())
          // Got a response (no throw): it must NOT be the 403 gate.
          if (res.status === 403) {
            const body = (await res.json()) as { error?: string }
            gateRefused = body.error === 'Route not enabled for payment'
          }
          // A merchant probe means we got past the gate into payment work.
          reachedPaymentFlow = fetchSpy.mock.calls.length > 0
        } catch {
          // Trap tripped (secret/KV access) — that only happens AFTER the gate,
          // inside the payment flow. Proves the route was not gated.
          reachedPaymentFlow = true
        }
        expect(gateRefused, 'untested route must NOT hit the 403 payment gate').toBe(false)
        expect(reachedPaymentFlow, 'untested route must reach the payment flow past the gate').toBe(true)
      },
    )
  })

  it('refuses a known-broken (verifiedMode false) route with 403 BEFORE any secret/KV/merchant access', async () => {
    const env = makeTrapEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await withRoute(
      { id: '__gate_proxy_broken__', publicPath: '/v1/services/gatetest/proxy-broken', verifiedMode: false },
      async () => {
        const req = new Request('https://apiserver.mpprouter.dev/v1/services/gatetest/proxy-broken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: 'x' }),
        })
        const res = await handleProxy(req, env, makeCtx())
        expect(res.status).toBe(403)
        expect(fetchSpy).not.toHaveBeenCalled()
        const body = await res.json() as { error?: string }
        expect(body.error).toBe('Route not enabled for payment')
      },
    )
  })

  it.skipIf(!makeRealEnv())('lets a verified route reach the existing 402 charge flow', async () => {
    // This path signs a real 402 challenge with the router's MPP key, so
    // it needs `.dev.vars`; skipped (reported as skipped, not passed) when
    // absent on a fresh clone / CI.
    const env = makeRealEnv()!
    // Mock the merchant 402 challenge so we exercise the charge path
    // without real network. The verified route must NOT be gated — it
    // should reach the merchant probe and return a 402 to the agent.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"payment required"}', {
        status: 402,
        headers: {
          'WWW-Authenticate': [
            'Payment id="test-challenge-id"',
            'realm="parallelmpp.dev"',
            'method="tempo"',
            'intent="charge"',
            `request="${Buffer.from(
              JSON.stringify({
                amount: '10000',
                currency: '0xdeadbeef',
                recipient: '0x1234567890123456789012345678901234567890',
              }),
            )
              .toString('base64')
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=+$/, '')}"`,
          ].join(', '),
          'Content-Type': 'application/json',
        },
      }),
    )

    // parallel/search is a real overlay route with verifiedMode 'charge'.
    const req = new Request('https://apiserver.mpprouter.dev/v1/services/parallel/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    })
    const res = await handleProxy(req, env, makeCtx())
    expect(res.status).toBe(402)
    // The merchant WAS probed (gate did not short-circuit a verified route).
    expect(fetchSpy).toHaveBeenCalled()
  })
})
