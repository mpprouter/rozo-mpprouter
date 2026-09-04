/**
 * The merged catalog view: compile-time snapshot + runtime provider overlay.
 *
 * Every function here is the async counterpart of a synchronous export in
 * `merchants.ts`. Those synchronous exports are deliberately NOT changed:
 * they still answer from the snapshot alone, they still cost zero I/O, and
 * the ~15 call sites and ~30 tests that depend on that keep working. This
 * file is what a surface calls when it also wants to see providers.
 *
 * ## Snapshot wins, always
 *
 * `mergeRoutes` drops any overlay route whose `publicPath` + `method`
 * already exists in the snapshot. This is the load-bearing rule of the
 * whole feature and it is enforced here, once, rather than trusted to
 * registration-time validation — validation runs against the snapshot as
 * it was on the day someone registered, and the snapshot is refreshed on
 * a different schedule. A provider who registers `foo/bar` today and finds
 * the next snapshot refresh has imported an mpp.dev route at the same path
 * stops being served, rather than quietly taking over a route we settle
 * for. That is the safe direction to fail: they lose traffic, nobody
 * loses money to the wrong address.
 *
 * ## Why the reads are cheap
 *
 * One KV read per 10s per isolate, shared by every surface (see the index
 * cache in `provider-registry.ts`). When the registry is empty — which it
 * is until the first provider publishes — every function here returns the
 * snapshot result unchanged, allocating one array.
 */

import {
  listPublicCatalog,
  getRouteByPublicPath,
  getAllowedMethodsForPath,
  PUBLIC_SERVICE_ROUTES,
  type CatalogEnvView,
} from './merchants'
import type { PublicCatalogEntry, PublicServiceRoute } from './merchants-types'
import { listOverlayRoutes } from './provider-registry'
import type { Env } from '../index'

/** `publicPath` + `method`, the catalog's real primary key. */
function routeKey(publicPath: string, method: string): string {
  return `${method.toUpperCase()} ${publicPath}`
}

/**
 * Snapshot routes first, then the overlay routes that do not collide.
 *
 * Exported for the tests that assert the collision rule directly — it is
 * the one invariant a reviewer should be able to check without standing up
 * a KV mock.
 */
export function mergeRoutes(
  snapshot: readonly PublicServiceRoute[],
  overlay: readonly PublicServiceRoute[],
): PublicServiceRoute[] {
  if (overlay.length === 0) return snapshot as PublicServiceRoute[]
  const taken = new Set(snapshot.map(r => routeKey(r.publicPath, r.method)))
  const out = [...snapshot]
  for (const route of overlay) {
    const key = routeKey(route.publicPath, route.method)
    if (taken.has(key)) continue
    taken.add(key)
    out.push(route)
  }
  return out
}

/** All routes the router serves right now, snapshot and overlay. */
export async function getAllRoutes(env: Env | undefined): Promise<PublicServiceRoute[]> {
  return mergeRoutes(PUBLIC_SERVICE_ROUTES, await listOverlayRoutes(env))
}

/**
 * Route lookup for the proxy.
 *
 * Snapshot first and synchronously, so the hot path for all 674 existing
 * routes never waits on KV — a provider registration must not add latency
 * to traffic that has nothing to do with it.
 */
export async function getRouteWithOverlay(
  env: Env,
  pathname: string,
  method: string,
): Promise<PublicServiceRoute | undefined> {
  const fromSnapshot = getRouteByPublicPath(pathname, method)
  if (fromSnapshot) return fromSnapshot
  const wanted = routeKey(pathname, method)
  const overlay = await listOverlayRoutes(env)
  return overlay.find(r => routeKey(r.publicPath, r.method) === wanted)
}

/** 405-vs-400 helper, overlay-aware. Mirrors `getAllowedMethodsForPath`. */
export async function getAllowedMethodsWithOverlay(
  env: Env,
  pathname: string,
): Promise<string[]> {
  const methods = new Set(getAllowedMethodsForPath(pathname))
  for (const route of await listOverlayRoutes(env)) {
    if (route.publicPath === pathname) methods.add(route.method)
  }
  return [...methods]
}

/**
 * Render an overlay route into a public catalog entry.
 *
 * Kept here rather than in `listPublicCatalog` so that function stays
 * synchronous and snapshot-only. The two must agree on the fields a client
 * reads, which is what `tests/provider-overlay.test.ts` checks.
 */
function overlayCatalogEntry(
  route: PublicServiceRoute,
  env?: CatalogEnvView,
): PublicCatalogEntry {
  const operator = route.operator!
  return {
    id: route.id,
    name: route.name,
    category: route.categories[0] ?? 'other',
    categories: route.categories,
    description: route.description,
    public_path: route.publicPath,
    method: route.method,
    price: route.price,
    payment_method: route.paymentMethod,
    network: route.network,
    asset: route.asset,
    status: 'active',
    // Published implies a real paid call landed in the provider's wallet.
    payment_status: 'verified',
    payment_enabled: true,
    charge_rozo_verified: route.chargeVerified ?? null,
    charge_rozo_verified_at: route.chargeVerifiedAt ?? null,
    session_rozo_verified: null,
    session_rozo_verified_at: null,
    docs_url: `https://apiserver.mpprouter.dev/docs/integration#${route.id.replace(/_/g, '-')}`,
    methods: {
      stellar: { intents: ['charge'] },
      // No `stellar_x402` block: that one advertises OUR facilitator
      // address, which is precisely the wrong answer here. The per-chain
      // addresses live in `operator.payouts` below and in the live 402.
      tempo: { intents: [], role: 'upstream' },
    },
    settlement: 'direct',
    operator: {
      id: operator.id,
      name: operator.name,
      ...(operator.verifiedAt ? { verified_at: operator.verifiedAt } : {}),
      payouts: operator.payouts.map(p => ({
        network: p.network,
        pay_to: p.payTo,
        asset: p.asset,
      })),
    },
    payment_hints: {
      network: env?.STELLAR_NETWORK,
      intent: 'charge',
      dialect: 'mpp',
      // The provider's Stellar address, when they registered one — NOT
      // ours. A wallet that reads this hint and pays it is paying the
      // right party. Omitted rather than defaulted when the provider
      // settles only on other chains: a wrong hint here is worse than a
      // missing one, because the client would sign against it.
      ...(() => {
        const stellarPayout = operator.payouts.find(p => p.network.startsWith('stellar:'))
        return stellarPayout ? { pay_to: stellarPayout.payTo } : {}
      })(),
      requires_classic_usdc_trustline: true,
    },
  }
}

/** The public catalog, snapshot entries first, then providers. */
export async function listCatalogWithOverlay(
  env: Env,
): Promise<PublicCatalogEntry[]> {
  const overlay = await listOverlayRoutes(env)
  const base = listPublicCatalog(env)
  if (overlay.length === 0) return base
  const taken = new Set(
    PUBLIC_SERVICE_ROUTES.map(r => routeKey(r.publicPath, r.method)),
  )
  const extra = overlay
    .filter(r => !taken.has(routeKey(r.publicPath, r.method)))
    .map(r => overlayCatalogEntry(r, env))
  return [...base, ...extra]
}
