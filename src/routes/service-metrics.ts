/**
 * GET /v1/services/metrics            — quality stats for every service.
 * GET /v1/services/:serviceId/metrics — quality stats for one service.
 *
 * The public answer to SCF #44 reviewer feedback (2026-08-31): "we were
 * unable to locate public per-provider service-quality metrics."
 *
 * Every response carries all five windows (24h / 7d / 30d / 90d / all) so a
 * reader can see both current behaviour and lifetime behaviour without
 * choosing a flattering one for them — at our volume the difference between
 * "quiet this week" and "never worked" matters, and only showing 30d hides it.
 *
 * Honesty rules baked into the shape, not left to the page:
 *   - `provider_success_rate` is null, never 0, when nothing was served.
 *   - Caller errors and our own router faults are reported separately and
 *     excluded from the provider's success rate.
 *   - `methodology` ships with the data so the numbers cannot be quoted
 *     without their definition.
 */

import { getRouteQuality, type MetricsWindow, type RouteQualityStats } from '../services/route-metrics'
import { listPublicCatalog } from '../services/merchants'
import type { Env } from '../index'

/**
 * Published alongside every response. A reviewer reading a success rate must
 * be able to see what was counted without reading our source.
 */
const METHODOLOGY = {
  counts: 'One record per paid upstream call, written at the single proxy chokepoint that handles every payment branch.',
  provider_success_rate:
    'ok / (ok + provider_fault). Calls rejected because the request itself was malformed (caller_error) and calls that failed on our own credentials or configuration (router_fault) are reported separately and excluded from this denominator, because neither says anything about whether the provider served.',
  provider_fault: 'Upstream returned 5xx, 408 or 429, or the call timed out or threw with no upstream response.',
  caller_error: 'Upstream returned a 4xx describing a bad request (not 401/403 on a route where the router holds the credential).',
  router_fault: 'Upstream rejected our own credentials (401/403) on a route where the router, not the caller, presents them.',
  latency: 'Wall-clock milliseconds for the paid upstream leg, over SUCCESSFUL calls only, so a fast error cannot flatter the percentiles. Percentiles are exact (nearest-rank over stored per-call values), not histogram estimates. Calls whose duration was not measured are excluded rather than counted as 0ms.',
  refunds: 'Not reported here: a metric row is written once at call time and a refund confirms later, so any refund figure on this endpoint could only ever be zero. See /v1/stats, whose refund rate comes from the order ledger.',
  null_values: 'null means "no data in this window", never zero. A service with no traffic is not a service with a 0% success rate.',
  coverage: 'Recording began when this endpoint shipped; earlier calls appear only where they were backfilled from the per-call order ledger. `first_call_at` shows how far back the data actually reaches.',
} as const

/**
 * Refund fields are stripped from this endpoint on purpose.
 *
 * A metric row is written once, at call time, and never revisited; a refund
 * confirms later and updates only the KV order ledger. So `refunded` here
 * would read 0 forever no matter how many refunds were actually paid, and a
 * published 0.0% refund rate that can never move is worse than no number.
 * The refund rate on /v1/stats is derived from the ledger and is real.
 */
function stripUnmaintainedFields(s: RouteQualityStats) {
  const { refunded: _refunded, refund_rate: _refundRate, ...rest } = s
  return rest
}

function windowsPayload(q: Record<MetricsWindow, RouteQualityStats>) {
  return {
    '24h': stripUnmaintainedFields(q['24h']),
    '7d': stripUnmaintainedFields(q['7d']),
    '30d': stripUnmaintainedFields(q['30d']),
    '90d': stripUnmaintainedFields(q['90d']),
    all: stripUnmaintainedFields(q.all),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Public, cacheable for a minute: this is a dashboard feed, and an
      // uncached read would put a D1 range scan on every page view.
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export async function handleAllServiceMetrics(env: Env): Promise<Response> {
  const q = await getRouteQuality(env)
  return json({
    version: 1,
    generated_at: new Date().toISOString(),
    scope: 'all_services',
    methodology: METHODOLOGY,
    windows: windowsPayload(q),
  })
}

export async function handleServiceMetrics(env: Env, serviceId: string): Promise<Response> {
  // Only answer for ids that exist in the catalog. Echoing an arbitrary id
  // back with a zeroed body would let anyone mint a plausible-looking
  // "service" page for a provider we do not serve.
  const known = new Set(listPublicCatalog(env).map((s) => String(s.id).split('_')[0]))
  if (!known.has(serviceId)) {
    return json({ error: 'unknown_service', service_id: serviceId }, 404)
  }

  const q = await getRouteQuality(env, serviceId)
  return json({
    version: 1,
    generated_at: new Date().toISOString(),
    scope: 'service',
    service_id: serviceId,
    methodology: METHODOLOGY,
    windows: windowsPayload(q),
  })
}
