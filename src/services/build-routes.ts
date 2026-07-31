/**
 * Build PUBLIC_SERVICE_ROUTES from a frozen mpp.dev catalog snapshot.
 *
 * Why this exists: the router used to maintain `PUBLIC_SERVICE_ROUTES`
 * by hand — twelve services, twelve route entries, hand-typed prices.
 * This drifted relative to upstream as mpp.dev grew to 88 services
 * and 832 endpoints. Operators discovering an mpp.dev service via
 * the docs would find the router silently didn't proxy it.
 *
 * The fix is one-shot bulk import: snapshot mpp.dev's
 * `/api/services` JSON, commit it as
 * `mpp-catalog-snapshot.json`, and generate routes from it at
 * module-load time. Operators can refresh by re-running
 * `scripts/admin/refresh-mpp-snapshot.ts` and committing the new
 * snapshot. No hand-edits needed for new merchants.
 *
 * The 12 historical hand-coded routes ARE NOT lost: an "operator
 * overlay" map carries their `verifiedMode` / `verifiedNote` /
 * `placeholderDefaults` flags. When a generated route matches a
 * hand-coded one by `(service, normalizedPath)`, the overlay
 * fields get merged in. The verified-status work the operator
 * has done is preserved across re-imports.
 *
 * Edge cases:
 * - mpp.dev endpoints use `:placeholder` syntax for path parameters.
 *   The router's `resolveUpstreamPath` only knows `{placeholder}`.
 *   We rewrite `:name` → `{name}` at import time.
 * - Some generated route IDs would collide (e.g. two endpoints
 *   `POST /v1/foo` and `GET /v1/foo` on the same service). We
 *   disambiguate by appending the HTTP method when needed.
 * - Endpoints with `payment === null` (free / preview routes) are
 *   imported with `price: 'free'` and a `freeRoute: true` marker.
 * - Services missing tempo charge intent (e.g. session-only
 *   merchants) get `upstreamPaymentMethod: 'tempo.session'`. Same
 *   logic as before.
 * - Categories: mpp.dev uses an array (`["ai", "media"]`); router
 *   schema is now `categories: string[]`. Single-category routes
 *   become a 1-element array.
 */

import type {
  PublicServiceRoute,
  PublicServiceRouteOverlay,
} from './merchants-types'

// Top-level shape of the snapshot file. Loose typing — we duck-type
// access only the fields we need so a future minor change in
// mpp.dev's response shape doesn't break the build.
interface MppSnapshot {
  version: number
  services: MppService[]
}

interface MppService {
  id: string
  name: string
  description?: string
  serviceUrl: string
  url?: string
  categories?: string[]
  tags?: string[]
  status?: string
  docs?: { homepage?: string; llmsTxt?: string; apiReference?: string }
  methods?: {
    tempo?: { intents?: string[]; assets?: string[] }
  }
  endpoints?: MppEndpoint[]
}

interface MppEndpoint {
  method: string
  path: string
  description?: string
  payment?: {
    intent?: string
    method?: string
    currency?: string
    decimals?: number
    description?: string
    amount?: string
    /**
     * Merchant prices this endpoint per request at call time; the
     * snapshot carries no fixed `amount`. Present on 80 POST
     * endpoints today (Dune, Tavily, Grok, DeepSeek, …).
     */
    dynamic?: boolean
    /** Human range the merchant advertises, e.g. `"$0.05-$4"`. */
    amountHint?: string
  } | null
}

/**
 * Slug a path into an underscore-separated identifier suitable for
 * use as part of a route ID. Strips leading slashes and common
 * boilerplate prefixes (`api/`, `v1/`, etc), normalizes
 * placeholders, and lowercases.
 *
 * Examples:
 *   /api/search                  → search
 *   /v1/chat/completions         → chat_completions
 *   /fal-ai/flux/schnell         → fal-ai_flux_schnell
 *   /v1beta/models/{model}:gen   → models_model_gen
 *   /                            → root
 */
/**
 * Path segments to strip from the front of a path before slugifying.
 * These are noise prefixes that don't add information for the route
 * id and would otherwise produce ugly slugs like
 * `fal_fal-ai_flux_schnell`. After stripping, that becomes
 * `fal_flux_schnell` which matches operator intuition.
 *
 * Stripping is conservative: only the LEADING segment is dropped,
 * and only if it matches one of these literals (or matches the
 * common `v[0-9]+(beta|alpha)?` versioning pattern).
 */
const STRIPPABLE_LEADING_SEGMENTS = new Set([
  'api',
  'fal-ai',
  'xai',
])

function isVersionSegment(seg: string): boolean {
  return /^v\d+(?:[a-z]+)?$/.test(seg)
}

function slugifyPath(path: string): string {
  // Split into segments, strip noise leading segments, then re-join
  // and normalize.
  const segments = path
    .replace(/^\/+/, '')
    .split('/')
    .filter(s => s.length > 0)
  while (
    segments.length > 1 &&
    (STRIPPABLE_LEADING_SEGMENTS.has(segments[0]) ||
      isVersionSegment(segments[0]))
  ) {
    segments.shift()
  }
  let s = segments
    .join('_')
    .replace(/\{([^}]+)\}/g, '$1')
    .replace(/:([a-z_][a-z0-9_]*)/gi, '$1')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
  if (s === '') s = 'root'
  return s
}

/**
 * Compute the route id for a (service, endpoint) pair. Format:
 * `<serviceId>_<slugifiedPath>`. The HTTP method is appended only
 * when two endpoints on the same service would otherwise collide.
 */
function makeRouteId(serviceId: string, endpoint: MppEndpoint): string {
  return `${serviceId}_${slugifyPath(endpoint.path)}`
}

/**
 * The router's `resolveUpstreamPath` only understands `{name}`
 * placeholders. mpp.dev paths use `:name`. Rewrite `:name` → `{name}`
 * (only when the colon is followed by an identifier, NOT when it's
 * a literal segment like `/foo:bar`).
 *
 * Examples:
 *   /:network/v2                → /{network}/v2
 *   /:network/nft/v3/:endpoint  → /{network}/nft/v3/{endpoint}
 *   /v1beta/models/foo:gen      → /v1beta/models/foo:gen  (literal colon NOT rewritten)
 *
 * The distinction: `:name` only matches at the start of a path
 * segment, never in the middle. We use a regex with `(?:^|/)` to
 * enforce this.
 */
function rewritePathPlaceholders(path: string): string {
  return path.replace(/(^|\/):([a-z_][a-z0-9_]*)/gi, '$1{$2}')
}

/**
 * Derive the upstream host from `serviceUrl`. mpp.dev returns the
 * full origin (e.g. `https://fal.mpp.tempo.xyz`); the router's
 * `upstreamHost` field expects host-only (`fal.mpp.tempo.xyz`).
 */
function deriveHost(serviceUrl: string): string {
  try {
    return new URL(serviceUrl).host
  } catch {
    // serviceUrl was already host-only
    return serviceUrl
  }
}

/**
 * Should we append a billing unit to a merchant's `amountHint`?
 *
 * Only when the hint is a bare amount or range — "$0.05-$4",
 * "~$0.001–$0.02" — where "/request" adds the missing information.
 *
 * Anything else passes through untouched: already-qualified rates
 * ("$0.12/hr", "$0.01/result", "~$0.005 per 1,000 characters") and
 * prose ("Varies by TLD", "Model-dependent"). Appending unconditionally
 * produced "$0.12/hr/request" and "Varies by TLD/request" — six live
 * routes read that way, which is its own kind of lie about what a call
 * costs.
 *
 * Implemented as "strip the amounts and see what is left": if only
 * separators remain, the hint was pure amounts. Both the ASCII hyphen
 * and the en-dash appear in live hints.
 */
function hintNeedsUnit(hint: string): boolean {
  const remainder = hint
    .replace(/\$\s*[\d.,]+/g, '')
    .replace(/[-–—~\s]/g, '')
  return remainder === ''
}

/**
 * Pretty-format a Tempo USDC base-unit amount string into a
 * human-readable price. The router's `price` field has historically
 * been a free-form string; we keep it that way for backward
 * compatibility, but populate it from the snapshot's actual
 * payment.amount instead of hand-typed values that drift over time.
 */
function formatPrice(payment: MppEndpoint['payment']): string {
  if (!payment) return 'free'
  // Merchant quotes at call time. Historically this returned 'free',
  // which is a lie an agent acts on: Tavily search advertised "free"
  // while its live 402 asks $0.09, and Dune's "free" SQL execute
  // billed $4 on a `SELECT 1`. Say "dynamic" and pass the merchant's
  // own range through when it has one.
  if (payment.dynamic || !payment.amount) {
    if (payment.amountHint) {
      return `${payment.amountHint}${hintNeedsUnit(payment.amountHint) ? '/request' : ''} (dynamic)`
    }
    if (!payment.amount) return 'dynamic'
  }
  const decimals = payment.decimals ?? 6
  const raw = payment.amount
  try {
    const big = BigInt(raw)
    if (big === 0n) return 'free'
    // Exact decimal rendering. The previous `big * 1000n / divisor`
    // floored to 3dp, so $0.00375 (mapbox geocode) advertised as
    // "$0.003" and every sub-$0.001 route ($0.0001 alchemy/storage)
    // advertised as "$0.000" — indistinguishable from free.
    return `$${baseUnitsToPriceString(big, decimals)}/request`
  } catch {
    return 'unknown'
  }
}

/**
 * Render an integer base-unit amount as an exact decimal string with
 * no precision loss and no trailing-zero noise. Always at least 3
 * fractional digits so existing `$0.003/request` labels are stable.
 */
function baseUnitsToPriceString(amount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = amount / divisor
  const frac = (amount % divisor).toString().padStart(decimals, '0')
  const trimmed = frac.replace(/0+$/, '')
  const padded = trimmed.padEnd(3, '0')
  return `${whole}.${padded}`
}

/**
 * Determine which Tempo intent the router should use to forward
 * agent requests to this upstream. Charge if the service advertises
 * it (most do), session otherwise. Some services advertise BOTH;
 * for now we prefer charge because it doesn't require pre-opening
 * a KV channel via `scripts/admin/open-tempo-channel.ts`.
 */
function pickUpstreamPaymentMethod(
  service: MppService,
): 'tempo.charge' | 'tempo.session' {
  const intents = service.methods?.tempo?.intents ?? []
  if (intents.includes('charge')) return 'tempo.charge'
  if (intents.includes('session')) return 'tempo.session'
  // Default. Many services that don't advertise tempo.* intents at
  // all are still tempo.charge in practice — the router's runtime
  // dispatch on `parsed.intent` corrects this anyway.
  return 'tempo.charge'
}

/**
 * HTTP methods the proxy will build routes for. See the comment at
 * the filter site for why PUT/DELETE are excluded.
 */
const PROXYABLE_METHODS = new Set(['POST', 'GET'])

/**
 * Stable-sort endpoints so POST is processed before any other
 * method. This is load-bearing for backward compatibility, not
 * cosmetics: route ids and public paths are de-duplicated in
 * iteration order, so if a GET on the same path were seen first it
 * would claim the bare id (`storage_key`) and demote the existing,
 * already-published POST route to `storage_key_post`. Agents have
 * that id bookmarked. POST first ⇒ every pre-existing id and public
 * path is byte-identical to what shipped before GET support.
 */
function orderEndpointsPostFirst(endpoints: MppEndpoint[]): MppEndpoint[] {
  const post: MppEndpoint[] = []
  const rest: MppEndpoint[] = []
  for (const e of endpoints) {
    if ((e.method || 'POST').toUpperCase() === 'POST') post.push(e)
    else rest.push(e)
  }
  return [...post, ...rest]
}

/**
 * Build the full route table from a frozen mpp.dev snapshot plus an
 * operator overlay. Pure function — no I/O, no env access.
 */
export function buildRoutesFromMppSnapshot(
  snapshot: MppSnapshot,
  overlay: Record<string, PublicServiceRouteOverlay> = {},
  serviceOverlay: Record<string, PublicServiceRouteOverlay> = {},
): PublicServiceRoute[] {
  const routes: PublicServiceRoute[] = []
  const seenIds = new Set<string>()
  const seenPublicPaths = new Set<string>()

  for (const service of snapshot.services) {
    if (service.status && service.status !== 'active') continue
    const upstreamHost = deriveHost(service.serviceUrl)
    const upstreamPaymentMethod = pickUpstreamPaymentMethod(service)
    const categories = service.categories ?? []

    for (const endpoint of orderEndpointsPostFirst(service.endpoints ?? [])) {
      const method = (endpoint.method || 'POST').toUpperCase()
      // Only proxyable methods. GET was added 2026-07-31; the old
      // filter was `method !== 'POST'`, whose stated reason ("they
      // tend to be free management endpoints") the snapshot
      // disproves: 174 GET endpoints carry a `payment` block, and
      // they are systematically the *result-retrieval* half of
      // async APIs (Dune `GET /execution/:id/results`, Allium
      // `GET /query-runs/:id/results`). Dropping them meant an
      // agent could pay for a query it had no way to read.
      //
      // PUT/DELETE stay out deliberately. The only two in the
      // snapshot are `storage /:key`, i.e. mutations, and the
      // proxy's idempotency-replay and passthrough semantics have
      // not been reviewed for non-idempotent verbs. Narrowing, not
      // deleting, the guard.
      if (!PROXYABLE_METHODS.has(method)) continue

      // Skip free/non-paid endpoints. The router's pay-per-request
      // dispatch path doesn't have a "no payment needed" branch,
      // and these endpoints are rarely useful as proxied targets
      // anyway (they're usually internal service mgmt routes).
      if (!endpoint.payment) continue

      let id = makeRouteId(service.id, endpoint)
      // Disambiguate id collisions by appending the HTTP method.
      // Should be rare since we filter to POST only.
      if (seenIds.has(id)) {
        id = `${id}_${method.toLowerCase()}`
      }
      if (seenIds.has(id)) {
        // Still collides — append a counter. Logged as a warning
        // in test fixtures so we can rename in the snapshot
        // overlay if needed.
        let n = 2
        while (seenIds.has(`${id}_${n}`)) n += 1
        id = `${id}_${n}`
      }
      seenIds.add(id)

      const upstreamPath = rewritePathPlaceholders(endpoint.path)
      const publicPath = `/v1/services/${service.id}/${slugifyPath(endpoint.path)}`
      // Public path collisions get resolved the same way as IDs:
      // never silently overwrite, always rename. With 832 source
      // endpoints this is theoretically possible.
      //
      // Keyed by METHOD + path, not path alone. `GET /x` and
      // `POST /x` are not a collision — they are the case
      // `getRouteByPublicPath(path, method)` and the proxy's 405 +
      // `allowed_methods` response exist to serve. Renaming one to
      // `…_2` would break that contract and hand agents a URL that
      // does not match the catalog. Only a genuine same-method
      // clash gets renamed.
      let dedupedPublicPath = publicPath
      if (seenPublicPaths.has(`${method} ${dedupedPublicPath}`)) {
        let n = 2
        while (seenPublicPaths.has(`${method} ${publicPath}_${n}`)) n += 1
        dedupedPublicPath = `${publicPath}_${n}`
      }
      seenPublicPaths.add(`${method} ${dedupedPublicPath}`)

      const description =
        endpoint.description ?? service.description ?? `${service.name} ${endpoint.path}`
      const route: PublicServiceRoute = {
        id,
        service: service.id,
        operation: slugifyPath(endpoint.path),
        name:
          endpoint.description && endpoint.description.length < 60
            ? `${service.name} – ${endpoint.description}`
            : service.name,
        categories,
        description,
        method,
        price: formatPrice(endpoint.payment),
        paymentMethod: 'stellar',
        upstreamPaymentMethod,
        network: 'stellar-mainnet',
        asset: 'USDC',
        publicPath: dedupedPublicPath,
        upstreamHost,
        upstreamPath,
        ...(service.docs ? { docs: service.docs } : {}),
        // Newly-routable non-POST routes are built but NOT payable.
        //
        // The router's default is "payable unless proven broken"
        // (`verifiedMode === undefined` ⇒ payable, see the security
        // gate in proxy.ts). Inheriting that default here would add
        // ~176 never-probed routes to the payable set in one commit —
        // which is precisely how 45 dead Nansen routes came to be
        // advertised as available. So these start `false` and an
        // operator flips them per-route in OPERATOR_OVERLAY after a
        // real-money probe, using the method-qualified key
        // `service::GET::/path`.
        ...(method === 'POST'
          ? {}
          : {
              verifiedMode: false as const,
              verifiedNote:
                `${method} route is wired end-to-end but has not been real-money ` +
                'verified by Rozo yet. Enable per-route in OPERATOR_OVERLAY after a probe.',
            }),
      }
      // Service-level overlay first, so a whole-provider outage can be
      // handled with one entry instead of one per route. A per-route
      // entry below still wins on any field it sets.
      const serviceEntry = serviceOverlay[service.id]
      if (serviceEntry) {
        if (serviceEntry.verifiedMode !== undefined) {
          route.verifiedMode = serviceEntry.verifiedMode
        }
        if (serviceEntry.verifiedNote !== undefined) {
          route.verifiedNote = serviceEntry.verifiedNote
        }
      }

      // Overlay lookup. The historical key is `service::path`, which
      // predates non-POST routes and therefore cannot distinguish
      // `GET /{key}` from `POST /{key}`. A method-qualified key wins
      // when present; the bare key is honoured only for POST, so
      // every existing OPERATOR_OVERLAY entry keeps applying to
      // exactly the route it was written for and never leaks onto a
      // newly-added GET sibling.
      const overlayEntry =
        overlay[`${service.id}::${method}::${upstreamPath}`] ??
        (method === 'POST' ? overlay[`${service.id}::${upstreamPath}`] : undefined)
      if (overlayEntry) {
        if (overlayEntry.id) {
          // Honor the historical ID so existing client URL
          // bookmarks (`/v1/services/parallel/search`) keep working.
          // We also re-derive publicPath from the historical id
          // when the overlay specifies one.
          route.id = overlayEntry.id
          if (overlayEntry.publicPath) {
            route.publicPath = overlayEntry.publicPath
          }
        }
        if (overlayEntry.verifiedMode !== undefined) {
          route.verifiedMode = overlayEntry.verifiedMode
        }
        if (overlayEntry.verifiedNote !== undefined) {
          route.verifiedNote = overlayEntry.verifiedNote
        }
        if (overlayEntry.placeholderDefaults !== undefined) {
          route.placeholderDefaults = overlayEntry.placeholderDefaults
        }
        if (overlayEntry.upstreamPaymentMethod !== undefined) {
          // Operator override — e.g. the operator opened a session
          // channel for this merchant and wants the router to use
          // session dispatch.
          route.upstreamPaymentMethod = overlayEntry.upstreamPaymentMethod
        }
        // Per-mode real-money verification flags + timestamps (operator-only).
        if (overlayEntry.chargeVerified !== undefined) {
          route.chargeVerified = overlayEntry.chargeVerified
        }
        if (overlayEntry.chargeVerifiedAt !== undefined) {
          route.chargeVerifiedAt = overlayEntry.chargeVerifiedAt
        }
        if (overlayEntry.sessionVerified !== undefined) {
          route.sessionVerified = overlayEntry.sessionVerified
        }
        if (overlayEntry.sessionVerifiedAt !== undefined) {
          route.sessionVerifiedAt = overlayEntry.sessionVerifiedAt
        }
      }
      routes.push(route)
    }
  }

  return routes
}
