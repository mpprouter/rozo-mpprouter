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
    // 444 as of 2026-08-09, after two rounds of real paid verification run
    // from a server. Both recoveries moved the number up the only legitimate
    // way — a paid call that returned an actual result:
    //   - openai_chat: the 2026-08-01 "region-blocked" verdict was an artifact
    //     of the client environment that test ran from.
    //   - anthropic_messages: the 404s were retired 2024 model ids. A current
    //     id (claude-haiku-4-5) returns a real completion.
    // Everything else re-tested in those rounds stays delisted with fresh
    // evidence in its verifiedNote. Note tempo_rpc returned 202 again and was
    // deliberately NOT re-listed: its documented failure begins with a 202 and
    // an async job id that never resolves, so a 202 alone is not delivery.
    // 447 as of 2026-08-11: +3 mercury GET routes charge-verified with real
    // paid mainnet calls (tx hashes in docs/verified-services.md); the 4th
    // (events/by-ledger) stayed delisted — upstream 500/slow on the paid attempt.
    //
    // 448 as of 2026-08-18: events/by-ledger relisted after Mercury shipped the
    // ledger-range query-plan fix on 2026-08-15, and charge-verified the same day
    // with a real paid mainnet call (tx 5028a601...4f0d).
    expect(routes.filter(r => r.verifiedMode !== false)).toHaveLength(448)
    // 3 → 4 on 2026-08-18: the mercury GET routes are the only listed GETs, and
    // events/by-ledger joined them at the beta launch (see the note above).
    expect(getRoutes.filter(r => r.verifiedMode !== false)).toHaveLength(4)
  })

  it('keeps the SCF #44 Tranche 2 count of distinct verified services', () => {
    // SCF #44 Tranche 2 commits to "top 20 services verified payable". The
    // unit of that promise is the SERVICE, not the route — several services
    // have many verified routes and most have exactly one — so this counts
    // distinct `service` ids, not routes.
    //
    // A route counts as verified only when `verifiedMode` names a settlement
    // dialect that a real paid call actually exercised. Both dialects count:
    // `charge` settles per request, `session` settles through a Tempo
    // channel. Deliberately NOT `chargeVerified === true`, which silently
    // undercounts — openai is verified via a real paid call that returned a
    // completion (2026-08-09) but settles as 'session' and so carries no
    // `chargeVerified` flag.
    //
    // `verifiedMode: undefined` must never count. Undefined means "payable by
    // default, never probed", which is the state the 45 dead Nansen routes
    // were in when they shipped as available.
    //
    // 15 → 21 on 2026-08-18: six services charge-verified with real paid
    // mainnet calls (~$0.081 total) — fal, alphavantage, openweather, deepl,
    // mapbox, wolframalpha. Tx hashes in docs/verified-services.md.
    //
    // Moving this number UP requires a 200 from a real paid call per new
    // service. Moving it DOWN is legitimate when a paid re-probe shows a
    // service has broken; update this comment with which one and why.
    const verifiedServices = new Set(
      PUBLIC_SERVICE_ROUTES.filter(
        r => r.verifiedMode === 'charge' || r.verifiedMode === 'session',
      ).map(r => r.service),
    )
    expect(verifiedServices.size).toBe(21)
    // The commitment itself, stated independently of the exact figure above,
    // so a future delisting that drops us under 20 fails loudly.
    expect(verifiedServices.size).toBeGreaterThanOrEqual(20)
  })

  it('explains in verifiedNote why each gated-off GET route is gated', () => {
    for (const r of getRoutes.filter(r => r.verifiedMode === false)) {
      expect(r.verifiedNote).toMatch(/not been real-money verified|DISABLED/i)
    }
    // Listed GET routes must carry the paid-run evidence — or, for a route
    // listed ahead of its probe, say so explicitly. The second branch is a
    // deliberate, narrow exception (2026-08-18 beta launch of mercury
    // events/by-ledger) and it is bounded: exactly one route may sit in it,
    // so a second unverified listing fails this test rather than sliding in.
    const listed = getRoutes.filter(r => r.verifiedMode !== false)
    // Every listed GET route must carry its paid-run evidence. by-ledger briefly
    // sat listed-but-unverified during the 2026-08-18 launch; that window closed
    // the same day, so the exception is gone and the bar is uniform again.
    for (const r of listed) {
      expect(r.verifiedNote).toMatch(/charge-verified/)
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
