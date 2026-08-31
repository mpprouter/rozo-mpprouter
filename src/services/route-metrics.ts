/**
 * Per-provider service-quality metrics.
 *
 * SCF #44 reviewers (2026-08-31) could not locate public per-provider
 * service-quality metrics. `route-health.ts` cannot supply them: it counts
 * only CONSECUTIVE failures, writes nothing on success and prunes after
 * 15 minutes, so it has a numerator and no denominator. This module is the
 * denominator — one durable row per paid upstream call, queried into
 * 24h / 7d / 30d / 90d / all-time windows.
 *
 * It sits beside `recordRouteFailure`/`recordRouteSuccess` at the single
 * chokepoint in `routes/proxy.ts`, and follows the same rules: fire and
 * forget via `ctx.waitUntil`, never let a metrics failure fail a paid call,
 * and never record anything that is unsafe to publish.
 *
 * Storage is D1 rather than KV because these rows are queried by range and
 * grouped; the order ledger's KV keyspace has to be listed and fetched key
 * by key to answer the same question.
 */

import type { Env } from '../index'

/**
 * Whose fault a call was — deliberately not "did it work".
 *
 * A raw success rate charges providers for our own bad requests: in the
 * order ledger on 2026-08-31, 19 of 47 lifetime calls were non-2xx, many of
 * them 4xx from malformed parameters we sent. Only `provider_fault` counts
 * against a provider — but see classifyOutcome for which statuses actually
 * qualify, because guessing that wrong hides real outages instead.
 */
export type CallOutcome = 'ok' | 'provider_fault' | 'caller_error' | 'router_fault'

export interface RouteCallMetric {
  routeId: string
  method: string
  outcome: CallOutcome
  reason?: string
  upstreamStatus?: number
  /** Omit when unmeasured. Never pass 0 as a stand-in — see classify note. */
  latencyMs?: number
  refunded?: boolean
}

/**
 * Catalog route ids are `<service>_<endpoint>` (`mercury_txs_by_hash`).
 * The service id is the first segment, matching `GET /services` and the
 * landing page's `/services/<id>` route.
 */
export function serviceIdFromRouteId(routeId: string): string {
  const i = routeId.indexOf('_')
  return i === -1 ? routeId : routeId.slice(0, i)
}

/**
 * Attribute an upstream result to a party.
 *
 * `routerHoldsCredential` splits 401/403 between us and the provider. It is
 * never the caller: their Authorization header does not reach the upstream.
 * Getting this wrong in either direction corrupts the published rate —
 * blaming the provider for our expired key, or (as the first version did)
 * excluding a provider's refusals from its own success rate.
 */
export function classifyOutcome(
  upstreamStatus: number | undefined,
  opts: {
    routerHoldsCredential?: boolean
    routerSideFailure?: boolean
    /**
     * The delivery failed even though a status may look fine. An upstream
     * that returns 200 with an empty body refunds the payer, and must not
     * be recorded as a success.
     */
    deliveryFailed?: boolean
  } = {},
): CallOutcome {
  // A failure we already know is ours — a missing router-owned session
  // channel, for example — must not be charged to the provider just because
  // no upstream status came back.
  if (opts.routerSideFailure) return 'router_fault'

  // No status at all: transport failure, timeout or throw. Nothing reached
  // us from the provider, so it is the provider leg that failed.
  if (upstreamStatus === undefined) return 'provider_fault'
  if (upstreamStatus >= 200 && upstreamStatus < 300) {
    // A 2xx we could not deliver is the provider's failure, not a success:
    // the caller got an error and their money back.
    return opts.deliveryFailed ? 'provider_fault' : 'ok'
  }

  // 401/403 is NEVER the caller's fault on this rail. The agent's own
  // Authorization header is stripped before we call upstream (see
  // forwardHeaders in routes/proxy.ts) — the caller authenticates to US by
  // paying, and whatever credential the upstream sees is either ours or the
  // merchant's. So an auth rejection is our misconfiguration on routes where
  // we hold the credential, and the provider's problem everywhere else.
  //
  // The earlier version of this function called it `caller_error`, which
  // would have removed real provider failures (the historical Anthropic 403s
  // among them) from the denominator and published 100% for a provider that
  // was refusing to serve. That is precisely the number this table exists to
  // make trustworthy.
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return opts.routerHoldsCredential ? 'router_fault' : 'provider_fault'
  }

  // 408 and 429 are 4xx but describe the upstream refusing to serve, not a
  // malformed request.
  if (upstreamStatus === 408 || upstreamStatus === 429) return 'provider_fault'

  // A FINAL 402 means the merchant rejected the payment we presented after
  // retrying its challenge. That is a payment-protocol failure between the
  // router and the merchant; the caller's own request may be perfectly
  // valid, so booking it as caller_error would quietly drop a real failure
  // out of the published denominator.
  if (upstreamStatus === 402) {
    return opts.routerHoldsCredential ? 'router_fault' : 'provider_fault'
  }
  if (upstreamStatus >= 400 && upstreamStatus < 500) return 'caller_error'
  return 'provider_fault'
}

/**
 * Record one paid upstream call.
 *
 * Never throws and never awaits on the request path: a metrics write must
 * not be able to fail a call the payer has already settled.
 */
export function recordRouteCall(
  env: Env,
  ctx: { waitUntil: (p: Promise<any>) => void },
  metric: RouteCallMetric,
): void {
  const db = env.ROUTE_METRICS_DB
  // Optional binding so the Worker still runs anywhere the database has not
  // been provisioned yet (staged rollout, local dev, preview).
  if (!db) return

  ctx.waitUntil(
    (async () => {
      await db
        .prepare(
          `INSERT INTO route_metric_calls
             (call_id, created_at, service_id, route_id, method,
              outcome, reason, upstream_status, latency_ms, refunded)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(call_id) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          Date.now(),
          serviceIdFromRouteId(metric.routeId),
          metric.routeId,
          metric.method,
          metric.outcome,
          metric.reason ?? null,
          metric.upstreamStatus ?? null,
          // Preserve "unmeasured" as NULL. Storing 0 would drag published
          // percentiles toward zero, which is how the pre-existing order
          // ledger came to report a p50 of 0ms.
          metric.latencyMs ?? null,
          metric.refunded ? 1 : 0,
        )
        .run()
    })().catch(() => {}),
  )
}

export type MetricsWindow = '24h' | '7d' | '30d' | '90d' | 'all'

const WINDOW_MS: Record<Exclude<MetricsWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}

export const ALL_WINDOWS: MetricsWindow[] = ['24h', '7d', '30d', '90d', 'all']

export function isMetricsWindow(v: string): v is MetricsWindow {
  return (ALL_WINDOWS as string[]).includes(v)
}

export interface RouteQualityStats {
  window: MetricsWindow
  /** Every call in the window, whatever the outcome. */
  calls: number
  ok: number
  provider_fault: number
  caller_error: number
  router_fault: number
  /**
   * ok / (ok + provider_fault), rounded to 4 decimals. Caller errors and
   * router faults are excluded from the denominator: neither says anything
   * about whether the provider served. Null when that denominator is 0 —
   * "no data" must never render as 0%.
   */
  provider_success_rate: number | null
  refunded: number
  /** refunded / calls, or null when there were no calls. */
  refund_rate: number | null
  /** Successful calls that carried a measured duration. */
  latency_samples: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
  /** Epoch ms of the newest call in the window; null when there are none. */
  last_call_at: number | null
}

interface RawRow {
  outcome: string
  refunded: number
  latency_ms: number | null
  created_at: number
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

function summarize(window: MetricsWindow, rows: RawRow[]): RouteQualityStats {
  const count = (o: string) => rows.filter((r) => r.outcome === o).length
  const ok = count('ok')
  const providerFault = count('provider_fault')
  const refunded = rows.filter((r) => r.refunded === 1).length
  const served = ok + providerFault

  // Latency is reported over successful calls only: a fast 502 would
  // otherwise flatter the numbers we are asking reviewers to trust.
  const latencies = rows
    .filter((r) => r.outcome === 'ok' && r.latency_ms !== null)
    .map((r) => r.latency_ms as number)
    .sort((a, b) => a - b)

  return {
    window,
    calls: rows.length,
    ok,
    provider_fault: providerFault,
    caller_error: count('caller_error'),
    router_fault: count('router_fault'),
    provider_success_rate: served === 0 ? null : Math.round((ok / served) * 10000) / 10000,
    refunded,
    refund_rate: rows.length === 0 ? null : Math.round((refunded / rows.length) * 10000) / 10000,
    latency_samples: latencies.length,
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    last_call_at: rows.length === 0 ? null : Math.max(...rows.map((r) => r.created_at)),
  }
}

/**
 * Quality stats for one service (or, with `serviceId` omitted, all services)
 * across every window in one pass.
 *
 * Reads the widest window once and slices it in memory rather than issuing
 * five range queries: at this volume the whole history is a few dozen rows,
 * and one read keeps the five windows mutually consistent — five separate
 * queries can straddle an inbound call and report a 24h count larger than
 * the 7d count.
 *
 * NOTE ON INTERNAL TRAFFIC: these quality figures include ROZO's own test
 * calls. The payer is not known at the proxy chokepoint where rows are
 * written, so this table cannot attribute them, and a column that is always
 * zero would be a promise we do not keep. Internal exclusion is applied in
 * services/stats.ts, which reads the order ledger where the payer IS
 * recorded — and quality is the figure least distorted by our own traffic
 * anyway, since a test call fails or succeeds for the same reasons.
 */
export async function getRouteQuality(
  env: Env,
  serviceId?: string,
): Promise<Record<MetricsWindow, RouteQualityStats>> {
  const db = env.ROUTE_METRICS_DB
  const empty = Object.fromEntries(
    ALL_WINDOWS.map((w) => [w, summarize(w, [])]),
  ) as Record<MetricsWindow, RouteQualityStats>
  if (!db) return empty

  const sql = serviceId
    ? `SELECT outcome, refunded, latency_ms, created_at FROM route_metric_calls
         WHERE service_id = ?`
    : `SELECT outcome, refunded, latency_ms, created_at FROM route_metric_calls`
  const stmt = serviceId ? db.prepare(sql).bind(serviceId) : db.prepare(sql)

  let rows: RawRow[]
  try {
    const res = await stmt.all<RawRow>()
    rows = res.results ?? []
  } catch {
    // A metrics read must not take down the catalog it is attached to.
    return empty
  }

  const now = Date.now()
  return Object.fromEntries(
    ALL_WINDOWS.map((w) => [
      w,
      summarize(w, w === 'all' ? rows : rows.filter((r) => r.created_at >= now - WINDOW_MS[w])),
    ]),
  ) as Record<MetricsWindow, RouteQualityStats>
}

/**
 * Service ids with at least one quality row in the window.
 *
 * Used by services/stats.ts to seed its service list: a provider whose calls
 * never reached the order ledger (all failed, or all succeeded
 * asynchronously) would otherwise be absent from a page about provider
 * quality, which is precisely when its numbers matter most.
 */
export async function getQualityServiceIds(env: Env, sinceMs: number): Promise<string[]> {
  const db = env.ROUTE_METRICS_DB
  if (!db) return []
  try {
    const res = await db
      .prepare(
        `SELECT DISTINCT service_id FROM route_metric_calls WHERE created_at >= ?`,
      )
      .bind(sinceMs)
      .all<{ service_id: string }>()
    return (res.results ?? []).map((r) => r.service_id)
  } catch {
    // Never let this degrade the page into an error; the ledger-derived
    // services still render.
    return []
  }
}
