/**
 * Live route health — the catalog's "is this working *right now*" signal.
 *
 * ## Why this exists
 *
 * `charge_rozo_verified` / `payment_status` are **provenance**: a human ran
 * a real paid call on some date and wrote down what happened. They are not
 * health. During the 2026-08-12 Tempo RPC rate-limit incident,
 * `firecrawl_scrape` stayed `payment_status: "verified"`,
 * `charge_rozo_verified: true` (stamped 2026-04-11) while failing 100% of
 * calls for two days, because nothing about a April verification changes
 * when August breaks. A paying customer asked for exactly this field so
 * they could gate automatically instead of discovering it per-402.
 *
 * The existing outage control (`PLAYGROUND_CHAT_MODELS_DISABLED`, see
 * `playground/models.ts`) is manual and playground-scoped: an operator has
 * to notice, edit a var, and redeploy. That is the mechanism that did not
 * fire for two days here. This one observes what the proxy already knows.
 *
 * ## Shape: only unhealthy routes are stored
 *
 * One KV key holds a map of *incidents*. Healthy routes are simply absent,
 * so the blob stays tiny (the catalog has ~674 entries; a bad day has a
 * handful) and the catalog needs exactly one KV read rather than a list
 * over every route.
 *
 * ## Cost: the success path does no KV work at all
 *
 * A module-scope cache (isolate-lived, like the block/balance caches) lets
 * `recordRouteSuccess` return immediately when the route is not currently
 * in an incident — which is the overwhelmingly common case. KV is touched
 * on failures, and on the single success that clears an incident.
 *
 * ## Accuracy: advisory, not authoritative
 *
 * KV is eventually consistent and the read-modify-write below can drop a
 * concurrent update. That is deliberate and acceptable: this field gates
 * clients and informs operators, it never decides whether to move money.
 * The payment path's own guards (balance pre-flight, verify-before-settle
 * ordering, refunds) are what protect funds, and none of them consult this.
 */

import type { Env } from '../index'

const INCIDENTS_KEY = 'routeHealth:incidents'

/**
 * Consecutive upstream failures before a route is called degraded.
 *
 * Not 1: a single 502 is usually the merchant having a bad second, and
 * flapping the public catalog on one data point would make the field noise
 * rather than signal. Not 10: the incident this exists for failed *every*
 * call, so anything a client would want to gate on shows up almost at once.
 */
const FAILS_FOR_DEGRADED = 3

/**
 * How long after its last failure an incident is considered stale.
 *
 * Evaluated at READ time rather than by a cleanup job, so a route that
 * simply stops being called recovers on its own instead of being pinned
 * "degraded" forever by a burst that has long since passed.
 */
const INCIDENT_TTL_MS = 15 * 60_000

/** How long the incidents blob is reused before re-reading KV. */
const CACHE_MS = 10_000

export type RouteIncident = {
  /** Consecutive failures observed. */
  fails: number
  /** Epoch ms of the first failure in this run. */
  since: number
  /** Epoch ms of the most recent failure. */
  lastAt: number
  /** Short, non-sensitive reason — surfaced publicly, so no internals. */
  reason: string
}

type IncidentMap = Record<string, RouteIncident>

let cache: { value: IncidentMap; expiresAt: number } | null = null
let inFlight: Promise<IncidentMap> | null = null

/** Test seam: drop the isolate-level cache. Not used in production code. */
export function resetRouteHealthCache(): void {
  cache = null
  inFlight = null
}

async function readIncidents(env: Env): Promise<IncidentMap> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const raw = await env.MPP_STORE.get(INCIDENTS_KEY)
      const parsed = raw ? (JSON.parse(raw) as IncidentMap) : {}
      const value = parsed && typeof parsed === 'object' ? parsed : {}
      cache = { value, expiresAt: Date.now() + CACHE_MS }
      return value
    } catch {
      // A health signal must never take the catalog down with it.
      const value: IncidentMap = {}
      cache = { value, expiresAt: Date.now() + CACHE_MS }
      return value
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

async function writeIncidents(env: Env, next: IncidentMap): Promise<void> {
  cache = { value: next, expiresAt: Date.now() + CACHE_MS }
  try {
    await env.MPP_STORE.put(INCIDENTS_KEY, JSON.stringify(next))
  } catch {
    // Best effort. The isolate still has the update in cache.
  }
}

/** Drop incidents whose last failure is older than the TTL. */
function prune(map: IncidentMap, now: number): IncidentMap {
  const out: IncidentMap = {}
  for (const [id, inc] of Object.entries(map)) {
    if (now - inc.lastAt < INCIDENT_TTL_MS) out[id] = inc
  }
  return out
}

/**
 * Record that a proxied call to `routeId` failed upstream.
 *
 * `reason` is echoed to the PUBLIC catalog, so pass a coarse category
 * (the proxy's `RefundReason`), never an upstream error body — those carry
 * provider URLs, request payloads and occasionally keys. The incident that
 * prompted this field is itself the example: the 502 detail we returned
 * quoted our own RPC URL and request body back to the caller.
 */
export function recordRouteFailure(
  env: Env,
  ctx: { waitUntil: (p: Promise<any>) => void },
  routeId: string,
  reason: string,
): void {
  ctx.waitUntil(
    (async () => {
      const now = Date.now()
      const current = prune(await readIncidents(env), now)
      const prev = current[routeId]
      const next: IncidentMap = {
        ...current,
        [routeId]: {
          fails: (prev?.fails ?? 0) + 1,
          since: prev?.since ?? now,
          lastAt: now,
          reason,
        },
      }
      await writeIncidents(env, next)
    })().catch(() => {}),
  )
}

/**
 * Record that a proxied call to `routeId` succeeded, clearing any incident.
 *
 * Returns without touching KV when the route has no incident cached, which
 * is the normal case — success must not cost a write.
 */
export function recordRouteSuccess(
  env: Env,
  ctx: { waitUntil: (p: Promise<any>) => void },
  routeId: string,
): void {
  if (cache && cache.expiresAt > Date.now() && !cache.value[routeId]) return

  ctx.waitUntil(
    (async () => {
      const now = Date.now()
      const current = prune(await readIncidents(env), now)
      if (!current[routeId]) return
      const next = { ...current }
      delete next[routeId]
      await writeIncidents(env, next)
    })().catch(() => {}),
  )
}

export type LiveStatus = {
  live_status: 'ok' | 'degraded'
  live_status_reason?: string
  live_status_since?: string
}

/**
 * Current incident view, keyed by route id, for the catalog to merge in.
 * Routes below the threshold are omitted — they are not yet a story a
 * client should act on.
 */
export async function getDegradedRoutes(env: Env): Promise<Record<string, LiveStatus>> {
  const now = Date.now()
  const incidents = prune(await readIncidents(env), now)

  const out: Record<string, LiveStatus> = {}
  for (const [id, inc] of Object.entries(incidents)) {
    if (inc.fails < FAILS_FOR_DEGRADED) continue
    out[id] = {
      live_status: 'degraded',
      live_status_reason:
        `${inc.fails} consecutive upstream failures (${inc.reason}); ` +
        `last at ${new Date(inc.lastAt).toISOString()}. ` +
        `Automatically clears after ${INCIDENT_TTL_MS / 60_000} minutes without a failure, ` +
        `or on the next successful call.`,
      live_status_since: new Date(inc.since).toISOString(),
    }
  }
  return out
}
