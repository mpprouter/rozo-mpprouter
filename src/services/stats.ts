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
import { getRouteQuality, serviceIdFromRouteId, type MetricsWindow } from './route-metrics'
import type { Env } from '../index'

/**
 * Hard ceiling on ledger keys scanned per request. Lifetime volume is in the
 * tens, so this is headroom, not a limit we expect to hit — but an unbounded
 * KV walk behind a public URL is a denial-of-service primitive, so the scan
 * must terminate whatever the data does. `truncated` tells the caller the
 * page is showing a floor rather than a total.
 */
const MAX_LEDGER_KEYS = 5000

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
  /** Summed USDC, external payers only. String to avoid float drift. */
  volume_usd: string
  /** Distinct external payers. Computed server-side; no payer id is published. */
  buyers: number
  /** Epoch ms of the most recent external call, or null. */
  last_call_at: number | null
  /** ok / (ok + provider_fault), or null when nothing was served. */
  provider_success_rate: number | null
  latency_p50_ms: number | null
  refund_rate: number | null
  /** Per-day external call counts, oldest first, for the activity sparkline. */
  activity: number[]
}

export interface StatsPayload {
  window: MetricsWindow
  generated_at: string
  totals: {
    calls: number
    internal_calls: number
    volume_usd: string
    buyers: number
    provider_success_rate: number | null
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

function parseInternalPayers(env: Env): Set<string> {
  return new Set(
    (env.LEDGER_INTERNAL_PAYERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

async function readLedger(env: Env): Promise<{ entries: OrderLedgerEntry[]; truncated: boolean }> {
  const entries: OrderLedgerEntry[] = []
  let cursor: string | undefined
  let scanned = 0

  while (scanned < MAX_LEDGER_KEYS) {
    let listed: KVNamespaceListResult<unknown, string>
    try {
      listed = await env.MPP_STORE.list({ prefix: 'mercury_order:', limit: 1000, cursor })
    } catch {
      // A stats page must degrade, not 500.
      return { entries, truncated: true }
    }
    scanned += listed.keys.length
    const raws = await Promise.all(listed.keys.map((k) => env.MPP_STORE.get(k.name)))
    for (const raw of raws) {
      if (!raw) continue
      try {
        entries.push(JSON.parse(raw) as OrderLedgerEntry)
      } catch {
        // One unparseable record must not empty the whole page.
      }
    }
    if (listed.list_complete) return { entries, truncated: false }
    cursor = (listed as { cursor?: string }).cursor
    if (!cursor) return { entries, truncated: false }
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
  const internalPayers = parseInternalPayers(env)

  const { entries, truncated } = await readLedger(env)

  interface Acc {
    calls: number
    internal: number
    volume: string
    buyers: Set<string>
    last: number | null
    tss: number[]
  }
  const byService = new Map<string, Acc>()
  const acc = (id: string): Acc => {
    let a = byService.get(id)
    if (!a) {
      a = { calls: 0, internal: 0, volume: '0', buyers: new Set(), last: null, tss: [] }
      byService.set(id, a)
    }
    return a
  }

  for (const e of entries) {
    const ts = Date.parse(e.ts)
    if (Number.isNaN(ts) || ts < cutoff) continue
    const a = acc(serviceIdFromRouteId(e.route_id))

    if (e.payer && internalPayers.has(e.payer)) {
      a.internal += 1
      continue
    }

    a.calls += 1
    a.tss.push(ts)
    a.volume = addUsd(a.volume, e.amount_usd || '0')
    // A null payer is a real call whose payer we could not decode. It counts
    // as a call but not as a buyer: inventing a buyer for it would inflate
    // the exact number a reviewer is checking.
    if (e.payer) a.buyers.add(e.payer)
    a.last = a.last === null ? ts : Math.max(a.last, ts)
  }

  const services: ServiceStats[] = []
  for (const [serviceId, a] of byService) {
    const q = await getRouteQuality(env, serviceId)
    const w = q[window]
    services.push({
      service_id: serviceId,
      calls: a.calls,
      internal_calls: a.internal,
      volume_usd: a.volume,
      buyers: a.buyers.size,
      last_call_at: a.last,
      provider_success_rate: w.provider_success_rate,
      latency_p50_ms: w.latency_p50_ms,
      refund_rate: w.refund_rate,
      activity: activitySeries(a.tss, window, now),
    })
  }
  // Busiest first — the table's default sort in the reference layout.
  services.sort((x, y) => y.calls - x.calls)

  const allQuality = await getRouteQuality(env)
  const totalBuyers = new Set<string>()
  for (const e of entries) {
    const ts = Date.parse(e.ts)
    if (Number.isNaN(ts) || ts < cutoff) continue
    if (e.payer && !internalPayers.has(e.payer)) totalBuyers.add(e.payer)
  }

  return {
    window,
    generated_at: new Date(now).toISOString(),
    totals: {
      calls: services.reduce((n, s) => n + s.calls, 0),
      internal_calls: services.reduce((n, s) => n + s.internal_calls, 0),
      volume_usd: services.reduce((v, s) => addUsd(v, s.volume_usd), '0'),
      buyers: totalBuyers.size,
      provider_success_rate: allQuality[window].provider_success_rate,
    },
    services,
    truncated,
  }
}
