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
 * Commerce counts only settled calls from payers outside
 * LEDGER_INTERNAL_PAYERS (2026-11-07). The page is public, and counting our
 * own E2E probes and calls whose settlement failed as paid customer calls
 * overstated calls, volume and buyers. Both are still published, as
 * `internal_calls` and `unsettled_calls`, rather than dropped. This reverses
 * #113, which counted every recorded call while the page was internal only.
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
  /** Settled paid calls from external payers in the window. */
  calls: number
  /**
   * External calls where the merchant was paid but the buyer was not
   * charged: settlement failed or is still unresolved. Not in `calls` or
   * `volume_usd`. Calls whose ledger row was never written (before #296)
   * cannot be counted here; see coverage.known_gaps.
   */
  unsettled_calls: number
  /** Calls from our own payers (LEDGER_INTERNAL_PAYERS), excluded from every commerce figure. */
  internal_calls: number
  /** Summed USDC, external payers only. String to avoid float drift. */
  volume_usd: string
  /** Distinct external payers. Computed server-side; no payer id is published. */
  buyers: number
  /** Epoch ms of the most recent external call, or null. */
  last_call_at: number | null
  /**
   * Epoch ms of the most recent call from our own payers
   * (LEDGER_INTERNAL_PAYERS) that settled, got a 2xx from the upstream and
   * was not refunded, or null. Looks back over the window or 90 days,
   * whichever is longer, so a 24h view still shows a recent verification.
   * The lookback fills this field for services the window already lists; it
   * does not add services, so each window keeps the same rows as before.
   * Internal calls stay out of every commerce figure; this only says when
   * we last proved the route delivers.
   */
  last_verified_at: number | null
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
  /**
   * Median upstream leg of successful calls: paying the provider and its
   * response. It excludes the buyer's own payment and Stellar settlement,
   * which add several seconds; it is not end-to-end latency.
   */
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
    unsettled_calls: number
    internal_calls: number
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
  unsettled: number
  internal: number
  volume_micros: number
  refunded: number
  buyers: number
  first_at: number
  last_at: number | null
}

interface Commerce {
  services: CommerceRow[]
  /** Newest verified internal call per service (see ServiceStats.last_verified_at). */
  verified: Map<string, number>
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
/** sha256 hex digests of LEDGER_INTERNAL_PAYERS, matching order_ledger_stats.payer_digest. */
async function internalPayerDigests(env: Env): Promise<string[]> {
  const list = (env.LEDGER_INTERNAL_PAYERS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const payer of list) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payer))
    out.push([...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''))
  }
  return out
}

async function readCommerce(env: Env, cutoff: number, verifiedCutoff: number): Promise<Commerce> {
  const empty: Commerce = { services: [], verified: new Map(), hourly: new Map(), total_buyers: 0, ok: false }
  const db = env.ROUTE_METRICS_DB
  if (!db) return empty
  try {
    const internal = await internalPayerDigests(env)
    // `internal` is bound, never interpolated. With no list configured the
    // predicate is a literal false: `IN (NULL)` would evaluate to NULL, and
    // NOT NULL would silently drop every row from the counts.
    const isInternal = internal.length
      ? `(payer_digest IS NOT NULL AND payer_digest IN (${internal.map(() => '?').join(', ')}))`
      : '(0 = 1)'
    const counted = `settled = 1 AND NOT ${isInternal}`
    const verifiedCall = `${isInternal} AND upstream_ok = 1 AND refunded = 0 AND settled = 1`
    const [perService, perHour, buyers, verified] = await db.batch([
      db
        .prepare(
          `SELECT service_id,
                  SUM(CASE WHEN ${counted} THEN 1 ELSE 0 END) AS calls,
                  SUM(CASE WHEN settled = 0 AND NOT ${isInternal} THEN 1 ELSE 0 END) AS unsettled,
                  SUM(CASE WHEN ${isInternal} THEN 1 ELSE 0 END) AS internal,
                  COALESCE(SUM(CASE WHEN ${counted} THEN amount_micros ELSE 0 END), 0) AS volume_micros,
                  COALESCE(SUM(CASE WHEN ${counted} THEN refunded ELSE 0 END), 0) AS refunded,
                  COUNT(DISTINCT CASE WHEN ${counted} THEN payer_digest END) AS buyers,
                  MIN(created_at) AS first_at,
                  MAX(CASE WHEN ${counted} THEN created_at END) AS last_at
             FROM order_ledger_stats WHERE created_at >= ? GROUP BY service_id`,
        )
        .bind(...internal, ...internal, ...internal, ...internal, ...internal, ...internal, ...internal, cutoff),
      db
        .prepare(
          `SELECT service_id, (created_at / 3600000) * 3600000 AS hour_start, COUNT(*) AS n
             FROM order_ledger_stats WHERE created_at >= ? AND ${counted} GROUP BY service_id, hour_start`,
        )
        .bind(cutoff, ...internal),
      db
        .prepare(
          `SELECT COUNT(DISTINCT payer_digest) AS n FROM order_ledger_stats WHERE created_at >= ? AND ${counted}`,
        )
        .bind(cutoff, ...internal),
      db
        .prepare(
          `SELECT service_id, MAX(created_at) AS last_verified_at
             FROM order_ledger_stats WHERE created_at >= ? AND ${verifiedCall} GROUP BY service_id`,
        )
        .bind(verifiedCutoff, ...internal),
    ])
    const hourly = new Map<string, { hour_start: number; n: number }[]>()
    for (const r of (perHour.results ?? []) as any[]) {
      const list = hourly.get(r.service_id) ?? []
      list.push({ hour_start: Number(r.hour_start), n: Number(r.n) })
      hourly.set(r.service_id, list)
    }
    const verifiedAt = new Map<string, number>()
    for (const r of (verified.results ?? []) as any[]) {
      if (r.last_verified_at !== null && r.last_verified_at !== undefined) {
        verifiedAt.set(String(r.service_id), Number(r.last_verified_at))
      }
    }
    return {
      verified: verifiedAt,
      services: ((perService.results ?? []) as any[]).map((r) => ({
        service_id: String(r.service_id),
        calls: Number(r.calls ?? 0),
        unsettled: Number(r.unsettled ?? 0),
        internal: Number(r.internal ?? 0),
        volume_micros: Number(r.volume_micros),
        refunded: Number(r.refunded),
        buyers: Number(r.buyers),
        first_at: Number(r.first_at),
        last_at: r.last_at === null || r.last_at === undefined ? null : Number(r.last_at),
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

  // Verification looks back at least 90 days: "last verified" is a property
  // of the route, not of the window, and a 24h view should still show it.
  const verifiedCutoff = Math.min(cutoff, now - WINDOW_MS['90d'])
  const commerce = await readCommerce(env, cutoff, verifiedCutoff)
  const truncated = !commerce.ok

  interface Acc {
    calls: number
    unsettled: number
    internal: number
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
      a = { calls: 0, unsettled: 0, internal: 0, refunded: 0, volume_micros: 0, buyers: 0, first: now, last: null }
      byService.set(id, a)
    }
    return a
  }
  for (const r of commerce.services) {
    const a = acc(r.service_id)
    a.calls = r.calls
    a.unsettled = r.unsettled
    a.internal = r.internal
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
      unsettled_calls: a.unsettled,
      internal_calls: a.internal,
      volume_usd: microsToUsd(a.volume_micros),
      buyers: a.buyers,
      last_call_at: a.last,
      last_verified_at: commerce.verified.get(serviceId) ?? null,
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
        'Per-call order ledger, aggregated from its D1 rollup (order_ledger_stats). Calls, volume and buyers are settled orders from external payers only. Our own test and monitoring payers are counted separately as internal_calls; calls whose settlement failed or is unresolved are counted as unsettled_calls. last_verified_at is the newest internal call that settled, got a 2xx upstream and was not refunded, over the window or 90 days, whichever is longer.',
      quality_source:
        'route_metric_calls (D1), written at the proxy chokepoint every paid call passes through. Success is the provider answering correctly, not the buyer settling. Latency is the upstream leg only and excludes Stellar settlement.',
      quality_availability:
        anyQualityReadFailed && qualityAvailability === 'ok'
          ? 'read_failed'
          : qualityAvailability,
      known_gaps: [
        'Successful asynchronous (202) purchases return before the order ledger is written, so they are absent from volume, buyer and call counts. Their quality outcome IS recorded.',
        'Before 2026-11-07, an x402 call whose settlement never completed could leave no order row at all (23 deepseek_chat calls on 2026-11-06). Those calls appear in the quality figures but in neither calls nor unsettled_calls.',
        'Order-ledger records expire after 400 days, so the "all" window is a trailing 400 days for volume, buyers and refunds rather than true all-time. Quality history in D1 does not expire.',
      ],
    },
    totals: {
      calls: services.reduce((n, s) => n + s.calls, 0),
      unsettled_calls: services.reduce((n, s) => n + s.unsettled_calls, 0),
      internal_calls: services.reduce((n, s) => n + s.internal_calls, 0),
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
