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
 * Internal ROZO traffic (probes, e2e, dogfood — LEDGER_INTERNAL_PAYERS) is
 * excluded from volume and buyer counts, because those are the figures a
 * grant reviewer is being asked to trust. It is reported separately as
 * `internal_calls` rather than silently dropped.
 */

import type { OrderLedgerEntry } from './order-ledger'
import {
  getQualityServiceIds,
  getRouteQuality,
  getRouteQualityWithAvailability,
  serviceIdFromRouteId,
  type MetricsWindow,
} from './route-metrics'
import type { Env } from '../index'

/**
 * Hard ceiling on ledger keys scanned per request.
 *
 * Every key costs one KV read, and a Worker invocation has a hard subrequest
 * budget (1000 on the paid plan). The previous 5000 would not merely be slow
 * — it would throw partway through and take the endpoint down. 400 leaves
 * room for the list calls, the D1 queries and the rate limiter, and still
 * clears lifetime volume by an order of magnitude.
 *
 * An unbounded walk behind a public URL is also a denial-of-service
 * primitive, so the scan must terminate whatever the data does. `truncated`
 * tells the caller the page is a floor rather than a total. When volume
 * genuinely approaches this, the answer is a rollup table, not a bigger cap.
 */
const MAX_LEDGER_KEYS = 400

const WINDOW_MS: Record<Exclude<MetricsWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}

export interface ServiceStats {
  service_id: string
  /** Paid calls from external payers in the window. */
  calls: number
  /** Calls from ROZO's own test/dogfood wallets, reported, never hidden. */
  internal_calls: number
  /**
   * Calls from Rozo-adjacent payers we cannot clear as external. Neither
   * claimed as ours nor counted as demand — the ambiguity is published
   * rather than resolved in our favour.
   */
  unresolved_calls: number
  /**
   * Calls whose payer could not be decoded. Not external, not ours — the
   * ledger's attribution contract refuses to guess, and so does this.
   */
  unknown_calls: number
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
    internal_calls: number
    unresolved_calls: number
    unknown_calls: number
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
  /** True when the ledger scan hit MAX_LEDGER_KEYS; figures are then a floor. */
  truncated: boolean
}

/** Sum decimal USDC strings without going through a float. */
function addUsd(a: string, b: string): string {
  const scale = (s: string) => {
    const [i, f = ''] = s.split('.')
    return BigInt(i || '0') * 1000000n + BigInt((f + '000000').slice(0, 6))
  }
  const total = scale(a) + scale(b)
  const whole = total / 1000000n
  const frac = (total % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

function parseAddressList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/**
 * Payers that must not be counted as external demand.
 *
 * Two lists, not one, mirroring the contract in routes/ledger.ts:
 * LEDGER_INTERNAL_PAYERS is ours (probes, e2e, dogfood), while
 * LEDGER_UNRESOLVED_PAYERS is Rozo-adjacent and cannot be cleared as
 * external. Counting the second group as external would inflate the exact
 * buyer and volume figures a reviewer is checking, and the ledger endpoint
 * already refuses to make that claim.
 */
function parseExcludedPayers(env: Env): { internal: Set<string>; unresolved: Set<string> } {
  return {
    internal: parseAddressList(env.LEDGER_INTERNAL_PAYERS),
    unresolved: parseAddressList(env.LEDGER_UNRESOLVED_PAYERS),
  }
}

async function readLedger(env: Env): Promise<{ entries: OrderLedgerEntry[]; truncated: boolean }> {
  const entries: OrderLedgerEntry[] = []
  let cursor: string | undefined
  let scanned = 0
  // Reads that failed or would not parse. Any of them makes the result a
  // floor rather than a total.
  let lostReads = 0

  while (scanned < MAX_LEDGER_KEYS) {
    let listed: KVNamespaceListResult<unknown, string>
    try {
      // Page size is bounded by what is left of the budget, not a flat
      // 1000: the very first page would otherwise issue 1000 KV reads and
      // blow the Worker subrequest cap before MAX_LEDGER_KEYS was ever
      // consulted.
      const remaining = MAX_LEDGER_KEYS - scanned
      listed = await env.MPP_STORE.list({
        prefix: 'mercury_order:',
        limit: Math.min(remaining, 1000),
        cursor,
      })
    } catch {
      // A stats page must degrade, not 500.
      return { entries, truncated: true }
    }
    scanned += listed.keys.length
    // Each get() is caught individually: a bare Promise.all would reject
    // outside the try above on a single transient KV failure and turn the
    // whole endpoint into a 500, when the contract here is to degrade and
    // say so via `truncated`.
    let raws: (string | null)[]
    try {
      raws = await Promise.all(
        listed.keys.map((k) =>
          env.MPP_STORE.get(k.name).catch(() => {
            // Count it. Swallowing the failure into a null would let the
            // endpoint undercount while still claiming a complete result —
            // the same "confident zero from a broken read" this page exists
            // to avoid.
            lostReads += 1
            return null
          }),
        ),
      )
    } catch {
      return { entries, truncated: true }
    }
    for (const raw of raws) {
      if (!raw) continue
      try {
        entries.push(JSON.parse(raw) as OrderLedgerEntry)
      } catch {
        // One unparseable record must not empty the whole page — but it is
        // still data we failed to read, so the result is a floor, not a
        // total, and must say so.
        lostReads += 1
      }
    }
    if (listed.list_complete) return { entries, truncated: lostReads > 0 }
    cursor = (listed as { cursor?: string }).cursor
    if (!cursor) return { entries, truncated: lostReads > 0 }
  }
  return { entries, truncated: true }
}

/** Per-day counts across the window, oldest first. */
function activitySeries(timestamps: number[], window: MetricsWindow, now: number): number[] {
  if (timestamps.length === 0) return []
  const spanMs = window === 'all' ? now - Math.min(...timestamps) : WINDOW_MS[window]
  const days = Math.max(1, Math.ceil(spanMs / 86400000))
  // Cap the series so an all-time view of a long-lived service still renders
  // as a sparkline rather than several hundred one-pixel bars.
  const buckets = Math.min(days, 90)
  const bucketMs = spanMs / buckets
  const start = now - spanMs
  const out = new Array(buckets).fill(0)
  for (const ts of timestamps) {
    if (ts < start) continue
    const i = Math.min(buckets - 1, Math.floor((ts - start) / bucketMs))
    out[i] += 1
  }
  return out
}

export async function getStats(env: Env, window: MetricsWindow): Promise<StatsPayload> {
  const now = Date.now()
  const cutoff = window === 'all' ? 0 : now - WINDOW_MS[window]
  const excluded = parseExcludedPayers(env)

  const { entries, truncated } = await readLedger(env)

  interface Acc {
    calls: number
    internal: number
    unresolved: number
    unknown: number
    refunded: number
    volume: string
    buyers: Set<string>
    last: number | null
    tss: number[]
  }
  const byService = new Map<string, Acc>()
  const acc = (id: string): Acc => {
    let a = byService.get(id)
    if (!a) {
      a = {
        calls: 0,
        internal: 0,
        unresolved: 0,
        unknown: 0,
        refunded: 0,
        volume: '0',
        buyers: new Set(),
        last: null,
        tss: [],
      }
      byService.set(id, a)
    }
    return a
  }

  for (const e of entries) {
    const ts = Date.parse(e.ts)
    if (Number.isNaN(ts) || ts < cutoff) continue
    const a = acc(serviceIdFromRouteId(e.route_id))

    if (e.payer && excluded.internal.has(e.payer)) {
      a.internal += 1
      continue
    }
    if (e.payer && excluded.unresolved.has(e.payer)) {
      a.unresolved += 1
      continue
    }

    // A call whose payer we could not decode is 'unknown', and the ledger's
    // own four-way attribution is explicit that unknown is NOT external.
    // Counting it toward external calls and volume while refusing to count
    // it as a buyer asserted demand we cannot evidence — in the direction
    // that flatters us — so it is reported in its own bucket instead.
    if (!e.payer) {
      a.unknown += 1
      continue
    }

    a.calls += 1
    if (e.refund_status === 'refunded') a.refunded += 1
    a.tss.push(ts)
    a.volume = addUsd(a.volume, e.amount_usd || '0')
    a.buyers.add(e.payer)
    a.last = a.last === null ? ts : Math.max(a.last, ts)
  }

  // Seed from the quality table as well as the ledger. A service whose calls
  // all failed before an order was written — or all succeeded asynchronously —
  // has quality rows and no ledger rows, and would otherwise disappear from
  // the page. Dropping a provider's failures from a page about provider
  // quality is the worst available failure mode.
  const allQualityRows = await getQualityServiceIds(env, cutoff)
  for (const id of allQualityRows) acc(id)

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
    services.push({
      service_id: serviceId,
      calls: a.calls,
      internal_calls: a.internal,
      unresolved_calls: a.unresolved,
      unknown_calls: a.unknown,
      volume_usd: a.volume,
      buyers: a.buyers.size,
      last_call_at: a.last,
      // Absent data, not zero, when the store could not be read.
      provider_success_rate: qualityReadable ? w.provider_success_rate : null,
      caller_error: qualityReadable ? w.caller_error : null,
      router_fault: qualityReadable ? w.router_fault : null,
      pending: qualityReadable ? w.pending : null,
      latency_p50_ms: qualityReadable ? w.latency_p50_ms : null,
      refunded: a.refunded,
      refund_rate: a.calls === 0 ? null : Math.round((a.refunded / a.calls) * 10000) / 10000,
      activity: activitySeries(a.tss, window, now),
    })
  }
  // Busiest first — the table's default sort in the reference layout.
  services.sort((x, y) => y.calls - x.calls)

  const { stats: allQuality, availability: qualityAvailability } =
    await getRouteQualityWithAvailability(env)
  const totalBuyers = new Set<string>()
  for (const e of entries) {
    const ts = Date.parse(e.ts)
    if (Number.isNaN(ts) || ts < cutoff) continue
    if (!e.payer) continue
    if (excluded.internal.has(e.payer) || excluded.unresolved.has(e.payer)) continue
    totalBuyers.add(e.payer)
  }

  return {
    window,
    generated_at: new Date(now).toISOString(),
    coverage: {
      commerce_source:
        'Per-call order ledger (KV). Volume, buyers and calls are settled orders only.',
      quality_source:
        'route_metric_calls (D1), written at the proxy chokepoint every paid call passes through.',
      quality_availability:
        anyQualityReadFailed && qualityAvailability === 'ok'
          ? 'read_failed'
          : qualityAvailability,
      known_gaps: [
        'Successful asynchronous (202) purchases return before the order ledger is written, so they are absent from volume, buyer and call counts. Their quality outcome IS recorded.',
        'Quality figures include ROZO test traffic; the payer is unknown where those rows are written. Volume and buyer counts exclude it.',
        'An x402 payment whose settlement fails after the merchant already answered 2xx still writes an order row, so volume can overstate settled commerce during facilitator or chain incidents. The settlement outcome is not yet persisted per order.',
        'Order-ledger records expire after 400 days, so the "all" window is a trailing 400 days for volume, buyers and refunds rather than true all-time. Quality history in D1 does not expire.',
      ],
    },
    totals: {
      calls: services.reduce((n, s) => n + s.calls, 0),
      internal_calls: services.reduce((n, s) => n + s.internal_calls, 0),
      unresolved_calls: services.reduce((n, s) => n + s.unresolved_calls, 0),
      unknown_calls: services.reduce((n, s) => n + s.unknown_calls, 0),
      volume_usd: services.reduce((v, s) => addUsd(v, s.volume_usd), '0'),
      buyers: totalBuyers.size,
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
