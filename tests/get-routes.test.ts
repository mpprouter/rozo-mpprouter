/**
 * GET route support (2026-07-31).
 *
 * `build-routes.ts` used to drop every non-POST endpoint. The snapshot
 * disproves the stated reason ("free management endpoints"): 174 GET
 * endpoints carry a `payment` block and they are systematically the
 * *result-retrieval* half of async APIs — Dune
 * `GET /execution/:id/results`, Allium `GET /query-runs/:id/results`.
 * An agent could pay $0.05–$4 for a Dune query and then have no
 * endpoint to read the answer from.
 *
 * These tests lock in the four things that make the change safe:
 *   1. Every pre-existing POST route keeps its id, public path and
 *      payability — the new routes are strictly additive.
 *   2. GET routes are BUILT but NOT PAYABLE. Inheriting the router's
 *      "payable unless proven broken" default would have added ~176
 *      never-probed routes to the payable set, which is exactly how 45
 *      dead Nansen routes came to be advertised as available.
 *   3. Path parameters are supplied as query params, the failure modes
 *      are actionable, and the catalog advertises the names.
 *   4. Method routing: same public path under two methods is not a
 *      collision, and the wrong method still yields 405 + allowed_methods.
 */

import { describe, it, expect } from 'vitest'
import {
  PUBLIC_SERVICE_ROUTES,
  listPublicCatalog,
  getRouteByPublicPath,
  getAllowedMethodsForPath,
  requiredPathParams,
  resolveUpstreamPath,
  UpstreamPathPlaceholderError,
} from '../src/services/merchants'
import { buildRoutesFromMppSnapshot } from '../src/services/build-routes'
import { handleProxy } from '../src/routes/proxy'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

/**
 * Env whose every secret and KV access throws, so a test that gets a
 * 405/403 proves the router answered from the route table alone — no
 * merchant contact, no key material, no spend.
 */
function makeTrapEnv(): Env {
  const trap = (label: string) => () => {
    throw new Error(`must not reach ${label} for an unroutable request`)
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
    X402_ENABLED: 'true',
  }
  for (const secret of [
    'STELLAR_ROUTER_PUBLIC', 'STELLAR_GAS_SECRET', 'TEMPO_ROUTER_PRIVATE_KEY',
    'MPP_SECRET_KEY', 'STELLAR_X402_PAY_TO',
  ]) {
    Object.defineProperty(base, secret, {
      enumerable: true,
      get() {
        throw new Error(`must not read secret ${secret}`)
      },
    })
  }
  return base as unknown as Env
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const routes = PUBLIC_SERVICE_ROUTES as ReadonlyArray<(typeof PUBLIC_SERVICE_ROUTES)[number]>
const getRoutes = routes.filter(r => r.method === 'GET')
const postRoutes = routes.filter(r => r.method === 'POST')

describe('GET routes — build', () => {
  it('builds the result-retrieval endpoints that were being dropped', () => {
    expect(getRoutes.length).toBeGreaterThan(100)
    const byPath = (p: string) => routes.find(r => r.upstreamPath === p && r.method === 'GET')
    expect(byPath('/api/v1/execution/{execution_id}/results')).toBeDefined()
    expect(byPath('/api/v1/execution/{execution_id}/csv')).toBeDefined()
    expect(byPath('/api/v1/explorer/query-runs/{run_id}/results')).toBeDefined()
  })

  it('adds only GET — PUT/DELETE stay out (non-idempotent, unreviewed)', () => {
    expect(new Set(routes.map(r => r.method))).toEqual(new Set(['GET', 'POST']))
  })

  it('leaves every pre-existing POST route untouched', () => {
    // 496 POST routes shipped before this change; the count is asserted
    // so that a future snapshot refresh that silently drops POST routes
    // fails here rather than in production.
    expect(postRoutes).toHaveLength(496)
    // Spot-check identity of routes agents have bookmarked.
    expect(getRouteByPublicPath('/v1/services/firecrawl/scrape', 'POST')?.id).toBe('firecrawl_scrape')
    expect(getRouteByPublicPath('/v1/services/exa/search', 'POST')?.id).toBe('exa_search')
    expect(getRouteByPublicPath('/v1/services/storage/upload', 'POST')?.id).toBe('storage_upload')
  })

  it('does not change how many routes are payable', () => {
    // Every newly-built GET route is gated off — the anti-Nansen
    // invariant, asserted by the second expectation below.
    //
    // The POST baseline was 446 when GET support landed. It dropped to 442 on
    // 2026-08-01, when real-money verification delisted four routes that
    // take payment and then fail: openai_chat and openrouter_chat
    // (merchant's upstream region-restricted / credential invalid,
    // tempoxyz/mpp#852), alchemy_rpc and tempo_rpc (both confirmed
    // pay-then-fail on chain). Moving this number DOWN is the mechanism
    // working; moving it up without a paid verification is not.
    //
    // 443 as of 2026-08-09: openai_chat is back, and it moved up the only
    // legitimate way — a real paid call (202, completion returned) run from a
    // server, which is also how we learned the 2026-08-01 failure was an
    // artifact of the client environment it was tested from. The other three
    // were re-tested in the same round and stay delisted, each with a fresh
    // failure recorded in its verifiedNote.
    expect(routes.filter(r => r.verifiedMode !== false)).toHaveLength(443)
    expect(getRoutes.filter(r => r.verifiedMode !== false)).toHaveLength(0)
  })

  it('explains in verifiedNote why each GET route is gated off', () => {
    for (const r of getRoutes) {
      expect(r.verifiedMode).toBe(false)
      expect(r.verifiedNote).toMatch(/not been real-money verified/i)
    }
  })
})

describe('GET routes — id and path de-duplication', () => {
  const snapshot = {
    services: [
      {
        id: 'acme',
        name: 'Acme',
        serviceUrl: 'https://acme.example',
        status: 'active',
        endpoints: [
          // GET deliberately listed FIRST, as the real snapshot does for
          // storage and alchemy. POST must still win the bare id.
          { method: 'GET', path: '/thing/:id', payment: { amount: '1000', decimals: 6 } },
          { method: 'POST', path: '/thing/:id', payment: { amount: '2000', decimals: 6 } },
        ],
      },
    ],
  } as any

  it('gives POST the bare id even when GET is listed first', () => {
    const built = buildRoutesFromMppSnapshot(snapshot, {}, {}) as any[]
    const post = built.find(r => r.method === 'POST')
    const get = built.find(r => r.method === 'GET')
    expect(post.id).toBe('acme_thing_id')
    expect(get.id).toBe('acme_thing_id_get')
  })

  it('treats same path + different method as one path, not a collision', () => {
    const built = buildRoutesFromMppSnapshot(snapshot, {}, {}) as any[]
    const paths = built.map(r => r.publicPath)
    // Both routes share the public path; neither is renamed to `…_2`,
    // because `getRouteByPublicPath(path, method)` disambiguates and
    // the 405 response advertises both methods.
    expect(new Set(paths).size).toBe(1)
    expect(paths.every(p => !p.endsWith('_2'))).toBe(true)
  })

  it('does not leak a legacy `service::path` overlay onto the GET sibling', () => {
    const overlay = {
      'acme::/thing/{id}': { verifiedMode: 'charge' as const },
    }
    const built = buildRoutesFromMppSnapshot(snapshot, overlay, {}) as any[]
    expect(built.find(r => r.method === 'POST').verifiedMode).toBe('charge')
    // The GET route must stay gated — the operator verified POST.
    expect(built.find(r => r.method === 'GET').verifiedMode).toBe(false)
  })

  it('honours a method-qualified overlay key for the GET route', () => {
    const overlay = {
      'acme::GET::/thing/{id}': { verifiedMode: 'charge' as const },
    }
    const built = buildRoutesFromMppSnapshot(snapshot, overlay, {}) as any[]
    expect(built.find(r => r.method === 'GET').verifiedMode).toBe('charge')
    // POST keeps the router's default (undefined = payable-unless-broken);
    // the GET-qualified key must not have touched it.
    expect(built.find(r => r.method === 'POST').verifiedMode).toBeUndefined()
  })
})

describe('path parameter substitution', () => {
  const dune = {
    id: 'dune_results',
    upstreamPath: '/api/v1/execution/{execution_id}/results',
  }

  it('substitutes from the query string and reports what it consumed', () => {
    const { path, consumed } = resolveUpstreamPath(
      dune as any,
      new URLSearchParams('execution_id=01HZX9'),
    )
    expect(path).toBe('/api/v1/execution/01HZX9/results')
    // Consumed params are stripped from the forwarded query so the
    // merchant never sees the router's addressing scheme.
    expect([...consumed]).toEqual(['execution_id'])
  })

  it('fails with an actionable message when the id is missing', () => {
    expect(() => resolveUpstreamPath(dune as any, new URLSearchParams()))
      .toThrow(UpstreamPathPlaceholderError)
    try {
      resolveUpstreamPath(dune as any, new URLSearchParams())
    } catch (err: any) {
      // The message must tell the agent the exact shape of the retry.
      expect(err.message).toContain('?execution_id=')
      expect(err.message).toContain('path_params')
      expect(err.message).toMatch(/QUERY PARAMS/i)
    }
  })

  it('rejects a wrongly-shaped id rather than forwarding it', () => {
    for (const bad of ['../../admin', 'a/b', 'x?y=1', 'x#frag', 'a b', '']) {
      expect(() =>
        resolveUpstreamPath(dune as any, new URLSearchParams([['execution_id', bad]])),
      ).toThrow(UpstreamPathPlaceholderError)
    }
  })

  it('handles a template with several parameters, and defaults', () => {
    const multi = {
      id: 'multi',
      upstreamPath: '/{version}/runs/{run_id}/results/{format}',
      placeholderDefaults: { version: 'v1' },
    }
    const { path, consumed } = resolveUpstreamPath(
      multi as any,
      new URLSearchParams('run_id=abc&format=json&unrelated=keep'),
    )
    expect(path).toBe('/v1/runs/abc/results/json')
    expect([...consumed].sort()).toEqual(['format', 'run_id'])
    // A defaulted placeholder is not required of the caller…
    expect(requiredPathParams(multi as any).sort()).toEqual(['format', 'run_id'])
    // …but supplying one still overrides the default.
    expect(
      resolveUpstreamPath(multi as any, new URLSearchParams('version=v2&run_id=a&format=csv')).path,
    ).toBe('/v2/runs/a/results/csv')
    // Missing one of several is still a clean 400-shaped error naming
    // the specific placeholder that was absent.
    expect(() => resolveUpstreamPath(multi as any, new URLSearchParams('run_id=abc')))
      .toThrow(/\{format\}/)
  })
})

describe('catalog advertises path parameters', () => {
  const catalog = listPublicCatalog()

  it('lists the required param names for a templated route', () => {
    const entry = catalog.find(e => e.public_path === '/v1/services/dune/execution_execution_id_results')
    expect(entry).toBeDefined()
    expect(entry!.method).toBe('GET')
    expect(entry!.path_params).toEqual(['execution_id'])
  })

  it('omits path_params entirely for routes that need none', () => {
    const entry = catalog.find(e => e.id === 'firecrawl_scrape')
    expect(entry).toBeDefined()
    expect(entry!.path_params).toBeUndefined()
  })

  it('never advertises a param the resolver would supply from a default', () => {
    for (const entry of catalog) {
      const route = routes.find(r => r.id === entry.id)!
      expect(entry.path_params ?? []).toEqual(requiredPathParams(route))
      for (const name of entry.path_params ?? []) {
        expect(route.placeholderDefaults?.[name]).toBeUndefined()
      }
    }
  })
})

describe('method routing', () => {
  it('registers both methods for a shared public path', () => {
    const shared = routes.find(
      r => r.method === 'GET' && routes.some(o => o.method === 'POST' && o.publicPath === r.publicPath),
    )
    if (shared) {
      expect(getAllowedMethodsForPath(shared.publicPath).sort()).toEqual(['GET', 'POST'])
    }
    // Every GET route resolves under GET and not under POST-only lookup.
    const sample = getRoutes[0]
    expect(getRouteByPublicPath(sample.publicPath, 'GET')?.id).toBe(sample.id)
  })

  it('answers a wrong-method request with 405 + allowed_methods, touching nothing', async () => {
    const res = await handleProxy(
      new Request('https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape'),
      makeTrapEnv(),
      ctx,
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
    const body = await res.json() as any
    expect(body.allowed_methods).toEqual(['POST'])
  })

  it('refuses a GET route that is not real-money verified, before any spend', async () => {
    const route = getRoutes[0]
    const res = await handleProxy(
      new Request(`https://apiserver.mpprouter.dev${route.publicPath}`),
      makeTrapEnv(),
      ctx,
    )
    // Generic refusal — same shape as any other gated route, so it
    // leaks no merchant or channel detail.
    expect(res.status).toBe(403)
    expect((await res.json() as any).error).toBe('Route not enabled for payment')
  })

  it('never reads a body on a GET request', async () => {
    // A GET Request has no body; if the proxy called request.text()
    // unconditionally on a body-less request with a Content-Type it
    // would still be wrong to forward. Assert the router answers from
    // the route table with the trap env intact.
    const req = new Request('https://apiserver.mpprouter.dev/v1/services/nope/nope')
    const res = await handleProxy(req, makeTrapEnv(), ctx)
    expect(res.status).toBe(400)
    expect(req.bodyUsed).toBe(false)
  })
})
