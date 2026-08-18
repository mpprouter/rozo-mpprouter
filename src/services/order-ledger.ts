/**
 * Per-call order ledger (design: ainative todos/20260811-mercury-mpp-
 * router-integration-design.md §2.9). One record per call answers four
 * needs: user 30-day billing, provider analytics, session-mode dispute-
 * proofing, daily reconciliation.
 *
 * v1 scope: router-held-credential routes only (currently: mercury).
 * Storage: `MPP_STORE` KV — the repo's existing least-new-infrastructure
 * option (no new DO, no D1). Separate keyspace (`mercury_order:*` /
 * `mercury_order_index:*`) from ops-event data (rate-limit counters, W4
 * uptime probes, token rotation events) per the design doc — those don't
 * have payer/amount/settlement fields and would pollute order counts if
 * mixed into this table.
 *
 * v1 stores order METADATA only — never response bodies (size +
 * data-sovereignty, per design doc).
 *
 * Durability: written via `ctx.waitUntil` after the response is sent
 * (zero added latency). A dropped write is not silently invisible: for
 * charge-mode settlements the Stellar tx is the source of truth and a
 * nightly backfill job (not built in this MVP; tracked as a follow-up)
 * can reconcile from chain history.
 */

import type { Env } from '../index'

/**
 * `none`     — nothing to refund (the call was delivered).
 * `pending`  — the merchant leg failed after the agent's payment settled and a
 *              refund is queued; the on-chain return has not confirmed yet.
 * `refunded` — the queued refund confirmed on chain.
 * `unknown`  — the agent paid, the merchant leg failed, and no refund could be
 *              queued (e.g. a channel voucher rollback that needs manual
 *              review). Deliberately distinct from `pending`: it means nobody
 *              has committed to returning the money.
 */
export type RefundStatus = 'none' | 'pending' | 'refunded' | 'unknown'

export interface OrderLedgerEntry {
  order_id: string
  ts: string
  route_id: string
  /** Stellar G... address, or null when not extractable (see settlement_ref note). */
  payer: string | null
  amount_usd: string
  /**
   * Charge mode: Stellar tx hash. Session mode: channel id + voucher
   * sequence (not used by any Mercury route in v1 — Mercury is
   * fixed-price charge-only — but the field name stays generic).
   */
  settlement_ref: string | null
  /** Path + query actually sent upstream (post placeholder-resolution). Never the response body. */
  request_path: string
  upstream_status: number
  latency_ms: number
  refund_status: RefundStatus
}

export function orderKey(orderId: string): string {
  return `mercury_order:${orderId}`
}

/**
 * Secondary index: settlement tx hash -> order id. Exists so the public
 * `GET /v1/ledger?tx=<hash>` lookup is one KV read instead of a scan over
 * the entire order keyspace. Lowercased so a caller's casing never decides
 * whether the row is found.
 */
export function txIndexKey(tx: string): string {
  return `mercury_order_tx:${tx.toLowerCase()}`
}

/** Best-effort id — collision risk is irrelevant for an append-only audit log keyed by its own id. */
export function newOrderId(): string {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Write one order-ledger record. Intended to be called inside
 * `ctx.waitUntil(...)` so it never adds latency to the agent-facing
 * response. Swallows its own errors (logs only) — a dropped ledger write
 * must never turn into a 500 for a call the agent already paid for and
 * received.
 */
export async function recordOrder(env: Env, entry: OrderLedgerEntry): Promise<void> {
  try {
    await env.MPP_STORE.put(orderKey(entry.order_id), JSON.stringify(entry), {
      // 400 days — comfortably covers the "past 30 days" user view (§2.9
      // W5) plus slack for provider weekly-report backfill runs.
      expirationTtl: 400 * 24 * 60 * 60,
    })
    // Secondary index for GET /v1/ledger?tx=<hash>. Same TTL as the record it
    // points at, so the index can never outlive its target and hand out a
    // dangling id. Written second and in the same try: if it fails the record
    // itself still exists and is reachable by paging.
    if (entry.settlement_ref) {
      await env.MPP_STORE.put(txIndexKey(entry.settlement_ref), entry.order_id, {
        expirationTtl: 400 * 24 * 60 * 60,
      })
    }
  } catch (err: any) {
    console.error(`[order-ledger] write failed for ${entry.order_id}: ${err.message}`)
  }
}

/**
 * Move an existing order row to a new refund state (pending -> refunded).
 *
 * Called when the refund queue confirms the on-chain return, so the public
 * ledger stops showing a settled-then-failed call as `refund_pending`
 * forever. Read-modify-write on KV: the only writer of `refund_status` after
 * the initial record is the refund executor, one write per refund, so there
 * is no concurrent-update hazard worth a DO for.
 *
 * Best-effort like `recordOrder`: a missing row (write dropped, or TTL
 * expired) or a KV failure logs and returns false rather than failing the
 * refund itself — the refund record in ATOMIC_STORE remains the source of
 * truth for whether the money went back.
 */
export async function updateOrderRefundStatus(
  env: Env,
  orderId: string,
  refundStatus: RefundStatus,
): Promise<boolean> {
  try {
    const raw = await env.MPP_STORE.get(orderKey(orderId))
    if (!raw) {
      console.error(`[order-ledger] refund status update: no order row ${orderId}`)
      return false
    }
    const entry = JSON.parse(raw) as OrderLedgerEntry
    if (entry.refund_status === refundStatus) return true
    await env.MPP_STORE.put(
      orderKey(orderId),
      JSON.stringify({ ...entry, refund_status: refundStatus }),
      { expirationTtl: 400 * 24 * 60 * 60 },
    )
    return true
  } catch (err: any) {
    console.error(`[order-ledger] refund status update failed for ${orderId}: ${err.message}`)
    return false
  }
}
