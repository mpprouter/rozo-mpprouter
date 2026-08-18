/**
 * GET /v1/ledger — the public, read-only settlement ledger.
 *
 * WHY THIS EXISTS: the SCF #44 application states that router activity is
 * "all visible on the ledger". Until now the per-call records written by
 * `src/services/order-ledger.ts` were only readable by an operator with KV
 * access, so the claim had no public surface. This endpoint is that surface:
 * one row per paid call, enough for a reviewer to count unique external
 * payers and to follow each row to the Stellar transaction that settled it.
 *
 * DELIBERATELY MINIMAL. No aggregation, no /v1/usage, no /v1/stats — those
 * are an analytics product and would have to be maintained against a moving
 * definition of "a useful metric". A raw, paginated, append-only list can be
 * re-aggregated by anyone downstream and never goes stale.
 *
 * WHAT IS NOT EXPOSED (privacy / security boundary, keep it this way):
 *   - `request_path`: the upstream path plus its query string. Query strings
 *     carry caller-supplied content (search terms, prompts, addresses being
 *     looked up) — user data, not settlement data. It stays internal.
 *   - anything about router-held upstream credentials, merchant payout
 *     addresses, or revenue split.
 *   - `order_id` is exposed, because it identifies a settlement record and
 *     nothing about who made it beyond what the payer field already says.
 *
 * `payer` IS exposed on purpose: it is a Stellar public address that already
 * appears in a public ledger transaction, and counting distinct payers is
 * exactly the SCF milestone check (>=150 unique external payers).
 *
 * Storage is the existing `mercury_order:*` KV keyspace — no new binding, no
 * new dependency. Order ids embed a base36 millisecond timestamp, so KV's
 * lexicographic key order is chronological and its native cursor is a valid
 * pagination cursor. Listing is therefore OLDEST-FIRST; documented, not a bug.
 */

import type { Env } from '../index'
import { orderKey, txIndexKey, type OrderLedgerEntry } from '../services/order-ledger'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

/**
 * Public, unauthenticated, so it needs a floor on how fast one source can pull
 * it. 1 request per second per IP: generous for a human or a reviewer's
 * script, useless for a scraper trying to enumerate the whole keyspace fast.
 *
 * Implemented as a last-seen timestamp rather than a counter because
 * Cloudflare KV refuses any `expirationTtl` under 60 seconds — a 1-second
 * counter window is simply not expressible. The 60s TTL here is only how long
 * the timestamp is remembered; the enforced spacing is MIN_INTERVAL_MS.
 */
const MIN_INTERVAL_MS = 1000
const LAST_SEEN_TTL_S = 60

function json(status: number, payload: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Public data, safe to read from anywhere — a reviewer pasting this into
      // a browser tool should not hit a CORS wall.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

/**
 * Returns true when the caller may proceed. Fails OPEN on a KV error: a KV
 * outage must not take down a read-only transparency endpoint.
 */
export async function ledgerRateLimitOk(env: Env, ip: string, now: number = Date.now()): Promise<boolean> {
  const key = `ratelimit:ledger:${ip}`
  try {
    const raw = await env.MPP_STORE.get(key)
    const last = raw ? parseInt(raw, 10) : 0
    if (Number.isFinite(last) && last > 0 && now - last < MIN_INTERVAL_MS) return false
    await env.MPP_STORE.put(key, String(now), { expirationTtl: LAST_SEEN_TTL_S })
    return true
  } catch {
    return true
  }
}

export interface PublicLedgerRow {
  order_id: string
  ts: string
  /** Service slug, e.g. `firecrawl_scrape` — matches `id` in /v1/services/catalog. */
  service: string
  /** Stellar G... address of the payer, or null when the payment dialect did not expose it. */
  payer: string | null
  /** Amount quoted and charged for this call, in USD, as a decimal string. */
  amount_usd: string
  /** Stellar transaction hash of the settlement, or null if settlement did not produce one. */
  settlement_tx: string | null
  /** delivered | failed | refund_pending | refund_unknown — see toPublicRow. */
  status: string
  /** HTTP status the upstream merchant returned. */
  upstream_status: number
  /**
   * Whether this row is our own probe/test traffic rather than an external
   * user. `null` means UNKNOWN, and today it is null for every row: the
   * records carry no internal/test marker, and none was invented for this
   * endpoint. Set LEDGER_INTERNAL_PAYERS (comma-separated G... addresses) to
   * start classifying; rows with a payer then become true/false honestly.
   */
  internal: boolean | null
}

/** Maps the stored entry onto the public shape, dropping the internal-only fields. */
export function toPublicRow(entry: OrderLedgerEntry, internalPayers: Set<string>): PublicLedgerRow {
  let status: string
  if (entry.refund_status === 'pending') status = 'refund_pending'
  else if (entry.refund_status === 'unknown') status = 'refund_unknown'
  else if (entry.upstream_status >= 200 && entry.upstream_status < 300) status = 'delivered'
  else status = 'failed'

  let internal: boolean | null = null
  if (internalPayers.size > 0 && entry.payer) internal = internalPayers.has(entry.payer)

  return {
    order_id: entry.order_id,
    ts: entry.ts,
    service: entry.route_id,
    payer: entry.payer,
    amount_usd: entry.amount_usd,
    settlement_tx: entry.settlement_ref,
    status,
    upstream_status: entry.upstream_status,
    internal,
  }
}

function internalPayerSet(env: Env): Set<string> {
  const raw = (env as unknown as { LEDGER_INTERNAL_PAYERS?: string }).LEDGER_INTERNAL_PAYERS
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

async function readEntry(env: Env, orderId: string): Promise<OrderLedgerEntry | null> {
  const raw = await env.MPP_STORE.get(orderKey(orderId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OrderLedgerEntry
  } catch {
    return null
  }
}

/**
 * Single-row lookup by settlement transaction hash. Served from the
 * `mercury_order_tx:*` index written alongside each record — a KV list scan
 * would be O(whole keyspace) per request on a public endpoint.
 *
 * Rows written before that index existed are not findable this way and
 * return 404; they are still reachable by paging the list.
 */
async function handleByTx(env: Env, tx: string): Promise<Response> {
  const orderId = await env.MPP_STORE.get(txIndexKey(tx))
  if (!orderId) return json(404, { ok: false, error: 'No ledger entry for that transaction hash.' })
  const entry = await readEntry(env, orderId)
  if (!entry) return json(404, { ok: false, error: 'No ledger entry for that transaction hash.' })
  return json(200, { ok: true, entry: toPublicRow(entry, internalPayerSet(env)) })
}

export async function handleLedger(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (!(await ledgerRateLimitOk(env, ip))) {
    return json(429, { ok: false, error: 'Rate limit exceeded: 1 request per second.' }, { 'Retry-After': '1' })
  }

  const tx = url.searchParams.get('tx')
  if (tx) {
    // Stellar tx hashes are 64 hex chars. Reject anything else before it can
    // be concatenated into a KV key.
    if (!/^[0-9a-fA-F]{64}$/.test(tx)) {
      return json(400, { ok: false, error: 'tx must be a 64-character hex transaction hash.' })
    }
    return handleByTx(env, tx.toLowerCase())
  }

  const limitRaw = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return json(400, { ok: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}.` })
    }
    limit = Math.min(parsed, MAX_LIMIT)
  }

  const cursor = url.searchParams.get('cursor') ?? undefined

  let listed: KVNamespaceListResult<unknown, string>
  try {
    listed = await env.MPP_STORE.list({ prefix: 'mercury_order:', limit, cursor })
  } catch {
    return json(503, { ok: false, error: 'Ledger storage temporarily unavailable.' })
  }

  const internalPayers = internalPayerSet(env)
  const raws = await Promise.all(listed.keys.map((k) => env.MPP_STORE.get(k.name)))
  const entries: PublicLedgerRow[] = []
  for (const raw of raws) {
    if (!raw) continue
    try {
      entries.push(toPublicRow(JSON.parse(raw) as OrderLedgerEntry, internalPayers))
    } catch {
      // A single unparseable record must not 500 the whole page.
    }
  }

  return json(200, {
    ok: true,
    count: entries.length,
    // Oldest first — see the file header. `next_cursor` is null on the last page.
    order: 'ts_asc',
    entries,
    next_cursor: listed.list_complete ? null : ((listed as { cursor?: string }).cursor ?? null),
  })
}
