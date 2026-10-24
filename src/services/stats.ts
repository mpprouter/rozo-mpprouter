/**
 * Per-service statistics for the public /stats page.
 *
 * Deliberately joins TWO sources rather than duplicating either:
 *
 *   - Quality (success rate by fault, latency, refunds) comes from
 *     `route_metric_calls` (services/route-metrics.ts). That table is
 *     published verbatim, so it holds no payer, address or amount.
 *   - Commerce (volume, distinct buyers) comes from the per-call order
 *     ledger (services/order-ledger.ts, KV `mercury_order:*`), which
 *     already holds payer and amount behind the existing internal/external
 *     attribution lists.
 *
 * Copying payers into the published table would have been the shorter path
 * and the wrong one: even a keyed digest, once published, lets anyone link
 * one buyer's calls across every service they bought from. Aggregating on
 * the server and publishing only counts leaks nothing.
 *
 * Every recorded call is counted, whoever paid. The page is an internal
 * operating view for now, so splitting traffic by payer classification
 * added a distinction nobody was reading and three counters to keep true.
 */

import {
  getQualityServiceIds,
  getRouteQuality,
  getRouteQualityWithAvailability,
  serviceIdFromRouteId,
  type MetricsWindow,
} from './route-metrics'
import { listPublishedProviders } from './provider-registry'
import type { Env } from '../index'

const WINDOW_MS: Record<Exclude<MetricsWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}

export interface ServiceStats {
  service_id: string
  /**
   * Third-party provider running this service, when there is one.
   *
   * Present only for directly-settled providers; absent for every pooled
   * ROZO route, so an existing consumer sees no new key. `settlement`
   * makes the money path explicit rather than leaving it inferred from
   * the presence of `operator`.
   */
  operator?: { id: string; name: string }
  settlement?: 'direct'
  /** Paid calls from external payers in the window. */
  calls: number
  /** Summed USDC, external payers only. String to avoid float drift. */
  volume_usd: string
  /** Distinct external payers. Computed server-side; no payer id is published. */
  buyers: number
  /** Epoch ms of the most recent external call, or null. */
  last_call_at: number | null
  /** ok / (ok + provider_fault), or null when nothing was served. */
  /**
   * Null — not 0 — whenever quality storage could not be read. Zeroes here
   * would state that a provider had no faults, which is a claim, while the
   * truth is that we could not look.
   */
  provider_success_rate: number | null
  /**
   * Calls excluded from `provider_success_rate` and why. Published, not
   * merely documented: the first backfill produced 28 ok and 19 caller
   * errors, so the rate reads 100% while 40% of calls sit outside the
   * denominator. A bare 100% with no visible exclusion count is
   * indistinguishable from cherry-picking, and a reviewer is right to
   * treat it that way.
   */
  caller_error: number | null
  router_fault: number | null
  /** Async calls accepted but not yet resolved. Never counted as success. */
  pending: number | null
  latency_p50_ms: number | null
  /**
   * Refunded external calls over external calls, from the ORDER LEDGER, not
   * from the quality table. The ledger's refund_status is updated when a
   * refund actually confirms; the metrics row is written once at call time
   * and never revisited, so a rate derived from it would read 0.0% forever
   * no matter how many refunds were paid.
   */
  refunded: number
  refund_rate: number | null
  /** Per-day external call counts, oldest first, for the activity sparkline. */
  activity: number[]
}

export interface StatsPayload {
  window: MetricsWindow
  generated_at: string
  /**
   * Stated limits of these figures, published with them.
   *
   * The commerce columns (volume, buyers, calls) come from the order ledger,
   * and a successful ASYNC purchase returns via handleAsyncJob before the
   * success-path recordOrder runs — so those orders are missing from the
   * ledger and therefore from volume and buyer counts. Quality figures are
   * unaffected: they are written at the proxy chokepoint, which every async
   * call still passes through. Saying so is the honest option while the
   * async leg is fixed separately; a footnote is better than a total that
   * quietly understates itself.
   */
  coverage: {
    commerce_source: string
    quality_source: string
    /**
     * 'ok', 'not_provisioned' or 'read_failed'. When it is not 'ok' the
     * quality columns are absent data, NOT zero — a consumer must not
     * render them as a 0% success rate.
     */
    quality_availability: string
    known_gaps: string[]
  }
  totals: {
    calls: number
    volume_usd: string
    buyers: number
    provider_success_rate: number | null
    caller_error: number | null
    router_fault: number | null
    pending: number | null
    refunded: number
    refund_rate: number | null
  }
  services: ServiceStats[]
  /** True when the commerce rollup could not be read; commerce figures are then absent, not zero. */
  truncated: boolean
}

/** Integer micro-USDC -> decimal string, trailing zeros trimmed. */
function microsToUsd(micros: number | bigint): string {
  const total = BigInt(micros)
  const whole = total / 1000000n
  const frac = (total % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

interface CommerceRow {
  service_id: string
  calls: number
  volume_micros: number
  refunded: number
  buyers: number
  first_at: number
  last_at: number
}

interface Commerce {
  services: CommerceRow[]
  /** Hourly call counts per service, for the activity sparkline. */
  hourly: Map<string, { hour_start: number; n: number }[]>
  total_buyers: number
  ok: boolean
}

/**
 * Commerce aggregates from the D1 rollup `order_ledger_stats`
 * (migrations-metrics/0002), written alongside every order-ledger record.
 * Three queries, no per-key KV reads, independent of order volume. Any
 * failure degrades to empty figures with `ok: false`, which the payload
 * reports as `truncated` rather than publishing a confident zero.
 */
async function readCommerce(env: Env, cutoff: number): Promise<Commerce> {
  const empty: Commerce = { services: [], hourly: new Map(), total_buyers: 0, ok: false }
  const db = env.ROUTE_METRICS_DB
  if (!db) return empty
  try {
    const [perService, perHour, buyers] = await db.batch([
      db
        .prepare(
          `SELECT service_id, COUNT(*) AS calls, COALESCE(SUM(amount_micros), 0) AS volume_micros,
                  COALESCE(SUM(refunded), 0) AS refunded, COUNT(DISTINCT payer_digest) AS buyers,
                  MIN(created_at) AS first_at, MAX(created_at) AS last_at
             FROM order_ledger_stats WHERE created_at >= ? GROUP BY service_id`,
        )
        .bind(cutoff),
      db
        .prepare(
          `SELECT service_id, (created_at / 3600000) * 3600000 AS hour_start, COUNT(*) AS n
             FROM order_ledger_stats WHERE created_at >= ? GROUP BY service_id, hour_start`,
        )
        .bind(cutoff),
      db
        .prepare(
          'SELECT COUNT(DISTINCT payer_digest) AS n FROM order_ledger_stats WHERE created_at >= ?',
        )
        .bind(cutoff),
    ])
    const hourly = new Map<string, { hour_start: number; n: number }[]>()
    for (const r of (perHour.results ?? []) as any[]) {
      const list = hourly.get(r.service_id) ?? []
      list.push({ hour_start: Number(r.hour_start), n: Number(r.n) })
      hourly.set(r.service_id, list)
    }
    return {
      services: ((perService.results ?? []) as any[]).map((r) => ({
        service_id: String(r.service_id),
        calls: Number(r.calls),
        volume_micros: Number(r.volume_micros),
        refunded: Number(r.refunded),
        buyers: Number(r.buyers),
        first_at: Number(r.first_at),
        last_at: Number(r.last_at),
      })),
      hourly,
      total_buyers: Number(((buyers.results ?? [])[0] as any)?.n ?? 0),
      ok: true,
    }
  } catch (err: any) {
    console.error(`[stats] commerce rollup read failed: ${err.message}`)
    return empty
  }
}

/**
 * Per-day counts across the window, oldest first, from hourly buckets. An
 * hour is placed by its start (clamped to the window start), so a call can
 * shift by under an hour across a bucket edge, invisible on a sparkline.
 */
function activitySeries(
  hours: { hour_start: number; n: number }[],
  firstAt: number,
  window: MetricsWindow,
  now: number,
): number[] {
  if (hours.length === 0) return []
  const spanMs = window === 'all' ? now - firstAt : WINDOW_MS[window]
  const days = Math.max(1, Math.ceil(spanMs / 86400000))
  // Cap the series so an all-time view of a long-lived service still renders
  // as a sparkline rather than several hundred one-pixel bars.
  const buckets = Math.min(days, 90)
  const bucketMs = Math.max(1, spanMs) / buckets
  const start = now - spanMs
  const out = new Array(buckets).fill(0)
  for (const h of hours) {
    const ts = Math.max(h.hour_start, start)
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((ts - start) / bucketMs)))
    out[i] += h.n
  }
  return out
}

export async function getStats(env: Env, window: MetricsWindow): Promise<StatsPayload> {
  const now = Date.now()
  const cutoff = window === 'all' ? 0 : now - WINDOW_MS[window]

  const commerce = await readCommerce(env, cutoff)
  const truncated = !commerce.ok

  interface Acc {
    calls: number
    refunded: number
    volume_micros: number
    buyers: number
    first: number
    last: number | null
  }
  const byService = new Map<string, Acc>()
  const acc = (id: string): Acc => {
    let a = byService.get(id)
    if (!a) {
      a = { calls: 0, refunded: 0, volume_micros: 0, buyers: 0, first: now, last: null }
      byService.set(id, a)
    }
    return a
  }
  for (const r of commerce.services) {
    const a = acc(r.service_id)
    a.calls = r.calls
    a.refunded = r.refunded
    a.volume_micros = r.volume_micros
    a.buyers = r.buyers
    a.first = r.first_at
    a.last = r.last_at
  }

  // Seed from the quality table as well as the ledger. A service whose calls
  // all failed before an order was written — or all succeeded asynchronously —
  // has quality rows and no ledger rows, and would otherwise disappear from
  // the page. Dropping a provider's failures from a page about provider
  // quality is the worst available failure mode.
  const allQualityRows = await getQualityServiceIds(env, cutoff)
  for (const id of allQualityRows) acc(id)

  // Which service ids belong to third-party providers. The registry keys
  // on provider id and `serviceIdFromRouteId` yields exactly that for
  // overlay routes (`<provider>_<operation>` → `<provider>`), so the two
  // line up without a second lookup table to keep in sync.
  const operatorById = new Map(
    (await listPublishedProviders(env)).map(p => [p.id, { id: p.id, name: p.name }]),
  )

  const services: ServiceStats[] = []
  let anyQualityReadFailed = false
  for (const [serviceId, a] of byService) {
    const { stats: q, availability } = await getRouteQualityWithAvailability(env, serviceId)
    // One service's failed read would otherwise publish that provider as
    // having zero faults and a null rate, indistinguishable from a clean
    // record.
    if (availability !== 'ok') anyQualityReadFailed = true
    const qualityReadable = availability === 'ok'
    const w = q[window]
    const operator = operatorById.get(serviceId)
    services.push({
      service_id: serviceId,
      ...(operator ? { operator, settlement: 'direct' as const } : {}),
      calls: a.calls,
      volume_usd: microsToUsd(a.volume_micros),
      buyers: a.buyers,
      last_call_at: a.last,
      // Absent data, not zero, when the store could not be read.
      provider_success_rate: qualityReadable ? w.provider_success_rate : null,
      caller_error: qualityReadable ? w.caller_error : null,
      router_fault: qualityReadable ? w.router_fault : null,
      pending: qualityReadable ? w.pending : null,
      latency_p50_ms: qualityReadable ? w.latency_p50_ms : null,
      refunded: a.refunded,
      refund_rate: a.calls === 0 ? null : Math.round((a.refunded / a.calls) * 10000) / 10000,
      activity: activitySeries(commerce.hourly.get(serviceId) ?? [], a.first, window, now),
    })
  }
  // Busiest first — the table's default sort in the reference layout.
  services.sort((x, y) => y.calls - x.calls)

  const { stats: allQuality, availability: qualityAvailability } =
    await getRouteQualityWithAvailability(env)
  return {
    window,
    generated_at: new Date(now).toISOString(),
    coverage: {
      commerce_source:
        'Per-call order ledger, aggregated from its D1 rollup (order_ledger_stats). Volume, buyers and calls are settled orders only.',
      quality_source:
        'route_metric_calls (D1), written at the proxy chokepoint every paid call passes through.',
      quality_availability:
        anyQualityReadFailed && qualityAvailability === 'ok'
          ? 'read_failed'
          : qualityAvailability,
      known_gaps: [
        'Successful asynchronous (202) purchases return before the order ledger is written, so they are absent from volume, buyer and call counts. Their quality outcome IS recorded.',
        'An x402 payment whose settlement fails after the merchant already answered 2xx still writes an order row, so volume can overstate settled commerce during facilitator or chain incidents. The settlement outcome is not yet persisted per order.',
        'Order-ledger records expire after 400 days, so the "all" window is a trailing 400 days for volume, buyers and refunds rather than true all-time. Quality history in D1 does not expire.',
      ],
    },
    totals: {
      calls: services.reduce((n, s) => n + s.calls, 0),
      volume_usd: microsToUsd([...byService.values()].reduce((v, a) => v + BigInt(a.volume_micros), 0n)),
      buyers: commerce.total_buyers,
      provider_success_rate:
        qualityAvailability === 'ok' ? allQuality[window].provider_success_rate : null,
      caller_error: qualityAvailability === 'ok' ? allQuality[window].caller_error : null,
      router_fault: qualityAvailability === 'ok' ? allQuality[window].router_fault : null,
      pending: qualityAvailability === 'ok' ? allQuality[window].pending : null,
      refunded: services.reduce((n, x) => n + x.refunded, 0),
      refund_rate: (() => {
        const calls = services.reduce((n, x) => n + x.calls, 0)
        const refunded = services.reduce((n, x) => n + x.refunded, 0)
        return calls === 0 ? null : Math.round((refunded / calls) * 10000) / 10000
      })(),
    },
    services,
    truncated,
  }
}
