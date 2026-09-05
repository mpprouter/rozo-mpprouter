/**
 * Runtime provider registry — the self-serve half of the service catalog.
 *
 * ## Why this exists
 *
 * The catalog in `merchants.ts` is a compile-time constant:
 * `mpp-catalog-snapshot.json` is expanded by `buildRoutesFromMppSnapshot`
 * at module load. Adding a provider therefore means edit → commit →
 * `wrangler deploy`. That is fine for a curated import of mpp.dev, and it
 * is disqualifying for the thing this file is for: SCF Tranche 3 asks for
 * "self-serve onboarding **without manual approval**", and a design whose
 * only way to publish a route is a human running a deploy fails that by
 * construction, however fast the human is.
 *
 * So: a runtime table, read as an **overlay on top of** the snapshot.
 *
 * ## Overlay, not replacement — the backward-compatibility contract
 *
 * The snapshot keeps loading exactly as it does today and nothing in this
 * file can change one of its routes. Two rules make that mechanical rather
 * than aspirational:
 *
 *   1. Merge order is snapshot-first and snapshot-wins. `mergeRoutes`
 *      below drops any overlay row whose `publicPath` + `method` collides
 *      with a snapshot route, and `getRouteWithOverlay` consults the
 *      synchronous snapshot lookup before it touches KV. A registration
 *      cannot shadow, re-price, or re-point an existing route — the worst
 *      a hostile registration achieves is being ignored.
 *   2. Overlay routes always carry `operator`; snapshot routes never do.
 *      That field is the sole gate on the direct-settlement branch in
 *      `proxy.ts`, so the 674 existing routes cannot enter it.
 *
 * The synchronous exports of `merchants.ts` (`PUBLIC_SERVICE_ROUTES`,
 * `listPublicCatalog`, `getRouteByPublicPath`) are deliberately left
 * untouched and still return snapshot-only data. Callers that must see
 * providers use the async wrappers in `catalog-overlay.ts`. A future
 * "let's just migrate the old catalog to runtime too" change breaks rule 1
 * and needs its own review — it is explicitly out of scope here.
 *
 * ## Storage shape: records are authoritative, the index is derived
 *
 * `route-health.ts` keeps its whole state in one KV blob, and that is right
 * for an advisory signal it can afford to lose. This is not that: a lost
 * row is a provider who onboarded, passed a real-money verification, and
 * then silently vanished from the catalog. So there are two tiers:
 *
 *   - `provider:<id>` — one key per provider, the authoritative record.
 *     Written once per registration. A concurrent registration by someone
 *     else cannot touch it, because nobody else's write addresses that key.
 *   - `providerIndex:v1` — a derived blob holding every published provider,
 *     so the catalog costs ONE KV read rather than a list plus N gets.
 *     Rebuilt from the records after each publish.
 *
 * If an index write is lost to a race, the records survive and
 * `rebuildIndex` reconstructs it from a `list()`. The reverse — index-only
 * storage — has no such recovery, which is why it is not what this does.
 *
 * ## What this file does NOT decide
 *
 * Nothing here moves money or authorises anything. It stores what a
 * provider claimed, after `provider-verification.ts` proved the claims.
 * Registration writes a record with `status: 'pending'`, and only the
 * verification gates promote it to `published`. An unpublished record is
 * invisible to every public surface.
 */

import type { Env } from '../index'
import type {
  PublicServiceRoute,
  RouteOperator,
  RouteOperatorPayout,
} from './merchants-types'

// ---------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------

const RECORD_PREFIX = 'provider:'
const INDEX_KEY = 'providerIndex:v1'

/** How long the index blob is reused before re-reading KV. */
const CACHE_MS = 10_000

/**
 * Ceiling on providers held in the index blob.
 *
 * A KV value is capped at 25 MB and a Worker has a fixed CPU budget per
 * request, so an unbounded registry behind a public, unauthenticated
 * `/services` read is a denial-of-service primitive against the same
 * namespace that carries payment state (the reasoning `stats.ts` already
 * applies to its ledger scan). 500 providers is ~100× the number this has
 * to hold to clear the grant, and when it is genuinely approached the
 * answer is pagination, not a bigger number.
 */
const MAX_PROVIDERS = 500

/** Ceiling on chargeable routes one provider may register. */
const MAX_ROUTES_PER_PROVIDER = 25

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/**
 * One chargeable endpoint the provider offers, as submitted to
 * `POST /v1/providers/register`.
 */
export interface ProviderRouteSpec {
  /**
   * Operation slug, unique within the provider. Becomes the second half
   * of the public path: `/v1/services/<providerId>/<operation>`.
   */
  operation: string
  /** HTTP method the provider's endpoint expects. */
  method: 'GET' | 'POST'
  /** Path on the provider's own server, e.g. `/v1/summarize`. */
  upstreamPath: string
  /** Decimal USD per request, e.g. "0.01". */
  priceUsd: string
  /** One-line description for the catalog. */
  description?: string
  /** Category tags for the catalog. Defaults to `['other']`. */
  categories?: string[]
}

/** Verification evidence, written by the gates in `provider-verification.ts`. */
export interface ProviderVerification {
  /** The 402 challenge was well-formed and matched the registration. */
  probe402At?: string
  /** A real minimal payment settled to the PROVIDER and returned 200. */
  paidCallAt?: string
  /** Transaction hash of that payment. Public data; safe to surface. */
  paidCallTxHash?: string
  /** Network the paid call settled on. */
  paidCallNetwork?: string
  /** Last failure reason, for a provider retrying `/verify`. */
  lastError?: string
  lastAttemptAt?: string
  domainVerifiedAt?: string
  /**
   * Which ownership proof the registration passed. Surfaced publicly so a
   * buyer can tell "the provider signed with the payout key" apart from
   * "the provider's own endpoint advertises this address" — both are
   * accepted, they are not the same claim.
   */
  ownershipProof?: 'wallet_signature' | 'well_known' | 'x402_pay_to'
  lastReachableAt?: string
  healthStatus?: 'pending' | 'healthy' | 'degraded' | 'offline'
  consecutiveProbeFailures?: number
  checks?: ProviderCheck[]
}

export interface ProviderCheck {
  key: 'website_reachable' | 'service_discovered' | 'payment_configured' | 'ownership_confirmed' | 'paid_call_works'
  label: 'Website reachable' | 'Service discovered' | 'Payment configured' | 'Ownership confirmed' | 'Paid call works'
  status: 'passed' | 'failed' | 'pending'
  detail: string
  checkedAt?: string
}

export interface ProviderDiscovery {
  submissionStatus: 'not_submitted' | 'submitted' | 'failed'
  submittedAt?: string
  submissionId?: string
  resourceId?: string
  discoveryUrl?: string
  lastAttemptAt?: string
  lastError?: string
  nextAttemptAt?: string
}

export interface ProviderRecord {
  /** Slug-shaped provider id; also the catalog service id. */
  id: string
  name: string
  /**
   * Contact email, for notifications and recovery only. Never a substitute
   * for the wallet signature — see `provider-auth.ts`.
   */
  email: string
  /** Base URL of the provider's own server. Origin they control. */
  apiBaseUrl: string
  /** Signature-verified settlement addresses, one per chain. */
  payouts: RouteOperatorPayout[]
  routes: ProviderRouteSpec[]
  /**
   * `pending` — registered, not yet verified. Invisible to every public
   * surface, unpayable.
   * `published` — passed both gates; appears in the catalog and is payable
   * on the direct-settlement path.
   * `suspended` — withdrawn by us or by the provider. Invisible again. The
   * record is kept rather than deleted so a re-registration of the same id
   * cannot silently inherit a stranger's history.
   */
  status: 'pending' | 'published' | 'suspended'
  verification: ProviderVerification
  createdAt: string
  updatedAt: string
  /**
   * The address that signed the registration challenge, and on which
   * network. Any later mutation of this record must be signed by the same
   * key — email alone never authorises a payout-address change.
   */
  ownerKey: {
    network: string
    address: string
    /**
     * Which proof established this record (2026-09-05). Absent on records
     * written before ownership proofs were pluralised; those were all
     * wallet signatures, and `assertNoProofDowngrade` treats an absent
     * value as "not a signature" deliberately — an old record can still be
     * updated with a signature, and upgrading a proof is never the risk.
     */
    proof?: 'wallet_signature' | 'well_known' | 'x402_pay_to'
  }
  /** Canonical signed-registration digest. Changes only on signed re-register. */
  registrationVersion?: string
  /** SHA-256 only. The bearer token is returned once after signed registration. */
  dashboardTokenHash?: string
  discovery?: ProviderDiscovery
}

/** The derived index: published providers only. */
type ProviderIndex = { providers: ProviderRecord[]; builtAt: string }

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/
const OPERATION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const PRICE_PATTERN = /^\d+(?:\.\d{1,7})?$/

/**
 * Provider ids that would collide with an existing router surface.
 *
 * `/v1/services/<id>/<operation>` shares a namespace with the snapshot
 * catalog, and a provider who registered as `firecrawl` would produce
 * paths that look like ours to every client that reads the catalog as a
 * flat list. Merge order already prevents them from *shadowing* a real
 * route (see the header), so this is about the impersonation rather than
 * the routing: nobody gets to publish `/v1/services/openai/chat` under
 * their own payout address.
 */
const RESERVED_IDS = new Set([
  'rozo', 'mpp', 'mpprouter', 'router', 'admin', 'internal', 'system',
  'stellar', 'x402', 'playground', 'partner', 'coupon', 'health', 'stats',
])

export class ProviderValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
    this.name = 'ProviderValidationError'
  }
}

function fail(field: string, message: string): never {
  throw new ProviderValidationError(field, message)
}

/**
 * Validate a provider's API base URL.
 *
 * This value is later fetched by the verification gates from inside our
 * Worker, which makes a careless version of this function an SSRF: a
 * registration naming `http://localhost` or a cloud metadata address would
 * have us make authenticated-looking requests into our own infrastructure
 * and hand the response back to the registrant. HTTPS-only plus a
 * literal-address ban and strict same-origin secondary fetches reduce the
 * reachable surface. Workers do not expose a general DNS-pinning primitive,
 * so this must not be described as complete protection against DNS rebinding.
 */
export function validateApiBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('api_base_url', 'Not a valid absolute URL.')
  }
  if (url.protocol !== 'https:') {
    fail('api_base_url', 'Must be https. Money is being routed to this origin.')
  }
  if (url.username || url.password) {
    fail('api_base_url', 'Must not embed credentials.')
  }
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    // Literal IPs: a real provider has a hostname, and every private range
    // worth blocking is a literal. Blocking all of them avoids maintaining
    // a CIDR list that would be wrong the first time IPv6 shows up.
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[')
  ) {
    fail('api_base_url', 'Must be a public hostname, not a literal or internal address.')
  }
  // Normalise: no trailing slash, no query, no fragment. Upstream paths are
  // appended to this, and `https://x.com/?a=1` + `/v1/y` is not a URL.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export function validateRegistration(input: unknown): {
  id: string
  name: string
  email: string
  apiBaseUrl: string
  payouts: RouteOperatorPayout[]
  routes: ProviderRouteSpec[]
} {
  if (!input || typeof input !== 'object') fail('body', 'Expected a JSON object.')
  const b = input as Record<string, unknown>

  const id = String(b.id ?? '').trim().toLowerCase()
  if (!ID_PATTERN.test(id)) {
    fail('id', 'Must be 3-32 chars, lowercase letters, digits and hyphens, not starting or ending with a hyphen.')
  }
  if (RESERVED_IDS.has(id)) fail('id', 'This id is reserved.')

  const name = String(b.name ?? '').trim()
  if (name.length < 2 || name.length > 64) fail('name', 'Must be 2-64 characters.')

  const email = String(b.email ?? '').trim()
  // Deliberately loose. A strict RFC 5322 regex rejects valid addresses and
  // this field is for notifications, not authentication — the wallet
  // signature is what proves anything.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 254) {
    fail('email', 'Must be a valid email address.')
  }

  const apiBaseUrl = validateApiBaseUrl(String(b.api_base_url ?? ''))

  const rawPayouts = b.payouts
  if (!Array.isArray(rawPayouts) || rawPayouts.length === 0) {
    fail('payouts', 'At least one payout address is required.')
  }
  const payouts: RouteOperatorPayout[] = []
  const seenNetworks = new Set<string>()
  for (const entry of rawPayouts) {
    if (!entry || typeof entry !== 'object') fail('payouts', 'Each entry must be an object.')
    const e = entry as Record<string, unknown>
    const network = String(e.network ?? '').trim()
    const payTo = String(e.pay_to ?? '').trim()
    if (!network) fail('payouts', 'Each entry needs a network.')
    if (seenNetworks.has(network)) {
      fail('payouts', `Two payout addresses for ${network}. One address per chain.`)
    }
    seenNetworks.add(network)
    if (!payTo) fail('payouts', `Missing pay_to for ${network}.`)
    payouts.push({ network, payTo, asset: String(e.asset ?? 'USDC').trim() || 'USDC' })
  }

  const rawRoutes = b.routes
  if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) {
    fail('routes', 'At least one chargeable route is required.')
  }
  if (rawRoutes.length > MAX_ROUTES_PER_PROVIDER) {
    fail('routes', `At most ${MAX_ROUTES_PER_PROVIDER} routes per provider.`)
  }
  const routes: ProviderRouteSpec[] = []
  const seenOps = new Set<string>()
  for (const entry of rawRoutes) {
    if (!entry || typeof entry !== 'object') fail('routes', 'Each entry must be an object.')
    const e = entry as Record<string, unknown>
    const operation = String(e.operation ?? '').trim().toLowerCase()
    if (!OPERATION_PATTERN.test(operation)) {
      fail('routes', `Invalid operation "${operation}": lowercase letters, digits and hyphens.`)
    }
    if (seenOps.has(operation)) fail('routes', `Duplicate operation "${operation}".`)
    seenOps.add(operation)

    const method = String(e.method ?? 'POST').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      fail('routes', `Unsupported method "${method}". GET or POST.`)
    }

    const upstreamPath = String(e.upstream_path ?? '').trim()
    if (!upstreamPath.startsWith('/') || upstreamPath.includes('..') || /\s/.test(upstreamPath)) {
      fail('routes', `Invalid upstream_path "${upstreamPath}": must start with / and contain no traversal.`)
    }

    const priceUsd = String(e.price_usd ?? '').trim()
    if (!PRICE_PATTERN.test(priceUsd)) {
      fail('routes', `Invalid price_usd "${priceUsd}": decimal USD, up to 7 dp.`)
    }
    if (Number(priceUsd) <= 0) {
      // A free route has nothing to settle and would sit in the catalog
      // advertising a payment path that never fires.
      fail('routes', 'price_usd must be greater than zero.')
    }

    const categories = Array.isArray(e.categories)
      ? e.categories.map(c => String(c).trim().toLowerCase()).filter(Boolean).slice(0, 5)
      : []

    routes.push({
      operation,
      method,
      upstreamPath,
      priceUsd,
      description: e.description ? String(e.description).slice(0, 280) : undefined,
      categories: categories.length > 0 ? categories : ['other'],
    })
  }

  return { id, name, email, apiBaseUrl, payouts, routes }
}

// ---------------------------------------------------------------------
// Record storage
// ---------------------------------------------------------------------

export async function getProviderRecord(
  env: Env,
  id: string,
): Promise<ProviderRecord | null> {
  try {
    const raw = await env.MPP_STORE.get(RECORD_PREFIX + id)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ProviderRecord
    return parsed && typeof parsed === 'object' && parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist a record and, when it is published, refresh the derived index.
 *
 * Order matters: the record is written first. If the index write then
 * fails, the provider exists and the next publish (or `rebuildIndex`)
 * picks them up — they are late, not lost. Writing the index first would
 * publish a provider whose record might not exist.
 */
export async function putProviderRecord(env: Env, record: ProviderRecord): Promise<void> {
  await env.MPP_STORE.put(RECORD_PREFIX + record.id, JSON.stringify(record))
  await refreshIndex(env, record)
}

/**
 * Rebuild the index from the authoritative records.
 *
 * The recovery path for a lost index write, and the only place that pays
 * for a `list()`. Not on any request path.
 */
export async function rebuildIndex(env: Env): Promise<ProviderIndex> {
  const providers: ProviderRecord[] = []
  let cursor: string | undefined
  do {
    const page = await env.MPP_STORE.list({ prefix: RECORD_PREFIX, cursor })
    for (const key of page.keys) {
      if (providers.length >= MAX_PROVIDERS) break
      const rec = await getProviderRecord(env, key.name.slice(RECORD_PREFIX.length))
      if (rec && rec.status === 'published') providers.push(rec)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor && providers.length < MAX_PROVIDERS)

  const index: ProviderIndex = { providers, builtAt: new Date().toISOString() }
  await writeIndex(env, index)
  return index
}

/**
 * Splice one record into the index without a full rebuild.
 *
 * Read-modify-write on a shared blob, so a simultaneous registration by a
 * second provider can be dropped. That is survivable exactly because the
 * records are authoritative: the dropped provider is missing from the
 * catalog until the next write or a `rebuildIndex`, not gone. Making this
 * linearizable would mean routing every registration through the
 * `ATOMIC_STORE` DO, which is the correct fix if registration volume ever
 * makes the race likely — at the current rate (single digits per week) it
 * would be machinery guarding an event that does not happen.
 */
async function refreshIndex(env: Env, changed: ProviderRecord): Promise<void> {
  const current = await readIndex(env)
  const others = current.providers.filter(p => p.id !== changed.id)
  const next =
    changed.status === 'published' ? [...others, changed] : others
  if (next.length > MAX_PROVIDERS) {
    throw new ProviderValidationError('id', 'Provider registry is full.')
  }
  await writeIndex(env, { providers: next, builtAt: new Date().toISOString() })
}

// ---------------------------------------------------------------------
// Index read path (hot: every /services, /llms.txt, proxy miss)
// ---------------------------------------------------------------------

let cache: { value: ProviderIndex; expiresAt: number } | null = null
let inFlight: Promise<ProviderIndex> | null = null

/** Test seam: drop the isolate-level cache. Not used in production code. */
export function resetProviderCache(): void {
  cache = null
  inFlight = null
}

const EMPTY_INDEX: ProviderIndex = { providers: [], builtAt: '1970-01-01T00:00:00.000Z' }

async function readIndex(env: Env | undefined): Promise<ProviderIndex> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      // `env?.` and not just `env.MPP_STORE?.` — a catalog surface may be
      // rendered with no bindings at all (the /llms.txt unit tests do
      // exactly that), and the correct answer there is the same as for an
      // unreadable KV: no overlay, snapshot only.
      const raw = await env?.MPP_STORE?.get(INDEX_KEY)
      const parsed = raw ? (JSON.parse(raw) as ProviderIndex) : EMPTY_INDEX
      const value =
        parsed && Array.isArray(parsed.providers) ? parsed : EMPTY_INDEX
      cache = { value, expiresAt: Date.now() + CACHE_MS }
      return value
    } catch {
      // A registry read must never take the catalog down with it. An empty
      // overlay degrades to exactly today's behaviour: 674 snapshot routes.
      cache = { value: EMPTY_INDEX, expiresAt: Date.now() + CACHE_MS }
      return EMPTY_INDEX
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

async function writeIndex(env: Env, index: ProviderIndex): Promise<void> {
  cache = { value: index, expiresAt: Date.now() + CACHE_MS }
  await env.MPP_STORE.put(INDEX_KEY, JSON.stringify(index))
}

/** Every published provider. Snapshot routes are not included. */
export async function listPublishedProviders(env: Env | undefined): Promise<ProviderRecord[]> {
  return (await readIndex(env)).providers
}

// ---------------------------------------------------------------------
// Record → catalog route
// ---------------------------------------------------------------------

export function publicPathFor(providerId: string, operation: string): string {
  return `/v1/services/${providerId}/${operation}`
}

export function toRouteOperator(record: ProviderRecord): RouteOperator {
  return {
    id: record.id,
    name: record.name,
    payouts: record.payouts,
    ...(record.verification.paidCallAt ? { verifiedAt: record.verification.paidCallAt } : {}),
  }
}

/**
 * Expand a published provider into catalog routes.
 *
 * The result is shaped exactly like a snapshot route so every existing
 * consumer (`listPublicCatalog`, the proxy's upstream-path resolver, the
 * 402 builder) works on it unchanged — with two deliberate differences:
 *
 *   - `operator` is set, which is what routes it onto direct settlement.
 *   - `fixedPricing` is set from the provider's declared price. A
 *     third-party route has no Tempo merchant for us to probe for a price,
 *     and the router must know what to charge before it issues the 402.
 *     This reuses the Mercury fixed-price path rather than adding a second
 *     way to price a route.
 */
export function routesForProvider(record: ProviderRecord): PublicServiceRoute[] {
  const operator = toRouteOperator(record)
  const host = new URL(record.apiBaseUrl).host
  const basePath = new URL(record.apiBaseUrl).pathname.replace(/\/+$/, '')

  return record.routes.map(spec => ({
    id: `${record.id}_${spec.operation.replace(/-/g, '_')}`,
    service: record.id,
    operation: spec.operation,
    name: `${record.name} — ${spec.operation}`,
    categories: spec.categories ?? ['other'],
    description: spec.description ?? `${spec.operation} on ${record.name}.`,
    method: spec.method,
    price: `$${spec.priceUsd}/request`,
    paymentMethod: 'stellar' as const,
    // Informational only for direct routes: we never pay this upstream
    // ourselves, so no Tempo intent is ever formed. Set to the single-shot
    // value because that is what the shape of the call resembles.
    upstreamPaymentMethod: 'tempo.charge' as const,
    network: 'stellar-mainnet' as const,
    asset: 'USDC' as const,
    publicPath: publicPathFor(record.id, spec.operation),
    upstreamHost: host,
    upstreamPath: `${basePath}${spec.upstreamPath}`,
    // Published implies both gates passed, including a real paid call that
    // landed in the provider's wallet. That is a stronger claim than the
    // operator flag usually carries, and it is the honest one here.
    verifiedMode: 'charge' as const,
    chargeVerified: true,
    chargeVerifiedAt: record.verification.paidCallAt ?? null,
    sessionVerified: null,
    sessionVerifiedAt: null,
    fixedPricing: { amountUsd: spec.priceUsd },
    operator,
  }))
}

/** Every catalog route contributed by the runtime overlay. */
export async function listOverlayRoutes(env: Env | undefined): Promise<PublicServiceRoute[]> {
  const providers = await listPublishedProviders(env)
  const out: PublicServiceRoute[] = []
  for (const p of providers) {
    try {
      out.push(...routesForProvider(p))
    } catch {
      // One malformed stored record must not blank the catalog for everyone.
    }
  }
  return out
}
