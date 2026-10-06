/**
 * Re-order guard: may a payment link get a NEW Rozo order after its earlier
 * order(s) expired?
 *
 * Upstream keeps an orderId taken forever, so before this guard an unpaid
 * order that expired dead-ended its payment link: every later create-invoice
 * answered 409 even though the Coinbase / Stripe link itself was still unpaid
 * and payable (2026-10-06, order 152b4e90). create-invoice now creates a
 * fresh order under a deterministic `__retryN` sibling orderId, but ONLY when
 * every earlier order for the link passes this guard:
 *
 *  1. upstream closed it as `payment_expired` (an order still `payment_unpaid`
 *     past expiresAt can still take a payment, up to ~2 hours, so it blocks);
 *  2. the order row carries no funding evidence on any rail (source tx,
 *     sender, received amount, confirmation, payout tx, refund / bounce state,
 *     merchant delivery marks);
 *  3. rozo-intents-api's read-only omni scan (tx-match ?q=<order id>, which
 *     reads the canonical USDC/USDT balance of EVERY EVM deposit address the
 *     order ever handed out, rotated-away legs included, on every recovery
 *     chain, and detects swept forwarders) answers `nothing_found`.
 *
 * Anything else fails closed. The guard never writes anything and never
 * touches the old order: late payments to it are still recognised by the
 * existing recovery paths (monitors, evm/sol/stellar payin rechecks,
 * tx-match), and because every sibling shares the one per-link fulfillment
 * record the provider invoice can still only be settled once.
 */
import type { Env } from '../index'

export const TX_MATCH_URL = 'https://intentapiv4.rozo.ai/functions/v1/tx-match'

const SCAN_TIMEOUT_MS = 10_000

export type RelinkBlockReason =
  /** Upstream has not closed the order as payment_expired yet. */
  | 'previous_order_not_closed'
  /** The order row itself records a payin, payout, refund or delivery. */
  | 'previous_order_funded'
  /** The on-chain scan found funds on (or swept from) one of its addresses. */
  | 'previous_order_funds_found'
  /** The scan could not give a definitive answer (rate limit, outage, shape). */
  | 'previous_order_unverifiable'

export type RelinkCheck =
  | { ok: true }
  | {
      ok: false
      reason: RelinkBlockReason
      rozoPaymentId: string | null
      status: string | null
      expiresAt: string | null
    }

function nonEmpty(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '' && v !== false
}

function positiveAmount(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false
  const n = Number(v)
  return !Number.isFinite(n) || n > 0
}

/**
 * Funding evidence recorded on a payment-api (v2 caller view) row, or null
 * when the row shows none. Pure; exported for tests.
 */
export function rowFundingEvidence(row: any): string | null {
  const src = row?.source ?? {}
  const dst = row?.destination ?? {}
  const checks: Array<[string, boolean]> = [
    ['source.txHash', nonEmpty(src.txHash ?? row?.source_tx_hash)],
    ['source.senderAddress', nonEmpty(src.senderAddress ?? row?.source_sender_address)],
    ['source.confirmedAt', nonEmpty(src.confirmedAt ?? row?.source_confirmed_at)],
    ['source.amountReceived', positiveAmount(src.amountReceived ?? row?.source_amount_received)],
    ['source.altToken', nonEmpty(src.altToken)],
    ['destination.txHash', nonEmpty(dst.txHash ?? row?.destination_tx_hash)],
    ['destination.confirmedAt', nonEmpty(dst.confirmedAt ?? row?.destination_confirmed_at)],
    ['refundStatus', nonEmpty(row?.refundStatus) && row.refundStatus !== 'none'],
    ['refundTxHash', nonEmpty(row?.refundTxHash)],
    ['bounceCode', nonEmpty(row?.bounceCode)],
    ['amountMismatch', nonEmpty(row?.amountMismatch)],
    ['customerNotice', nonEmpty(row?.customerNotice)],
    ['merchantNotifiedAt', nonEmpty(row?.merchantNotifiedAt)],
    ['merchantDeliveredAt', nonEmpty(row?.merchantDeliveredAt)],
  ]
  const hit = checks.find(([, present]) => present)
  return hit ? hit[0] : null
}

function blocked(row: any, reason: RelinkBlockReason): RelinkCheck {
  return {
    ok: false,
    reason,
    rozoPaymentId: typeof row?.id === 'string' ? row.id : null,
    status: row?.status ?? row?.payment_status ?? null,
    expiresAt: row?.expiresAt ?? null,
  }
}

/**
 * Ask tx-match for the on-chain verdict of one order. Returns the verdict
 * string, or null when no definitive single-order answer came back.
 */
async function scanVerdict(orderId: string): Promise<string | null> {
  let resp: Response
  try {
    resp = await fetch(`${TX_MATCH_URL}?q=${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    })
  } catch {
    return null
  }
  if (resp.status !== 200) return null
  const body: any = await resp.json().catch(() => null)
  const orders = Array.isArray(body?.orders) ? body.orders : null
  if (!orders || orders.length !== 1) return null
  const only = orders[0]
  if (only?.order_id !== orderId) return null
  // The scan reads the order's status too; it must still agree.
  if (only?.status !== 'payment_expired') return 'status_changed'
  return typeof only?.verdict === 'string' ? only.verdict : null
}

/** Guard one earlier order for the link. Never throws. */
export async function checkPreviousOrderUnfunded(_env: Env, row: any): Promise<RelinkCheck> {
  const status = row?.status ?? row?.payment_status ?? null
  const id = typeof row?.id === 'string' ? row.id : null
  if (status !== 'payment_expired' || !id) return blocked(row, 'previous_order_not_closed')
  if (rowFundingEvidence(row)) return blocked(row, 'previous_order_funded')
  const verdict = await scanVerdict(id)
  if (verdict === 'nothing_found') return { ok: true }
  if (verdict === null) return blocked(row, 'previous_order_unverifiable')
  if (verdict === 'status_changed') return blocked(row, 'previous_order_not_closed')
  return blocked(row, 'previous_order_funds_found')
}

/** Guard every earlier order; the first failure wins. Never throws. */
export async function checkPreviousOrdersUnfunded(env: Env, rows: any[]): Promise<RelinkCheck> {
  const results = await Promise.all(rows.map((r) => checkPreviousOrderUnfunded(env, r)))
  // Funded beats unverifiable beats not-closed: report the strongest reason.
  const rank: Record<RelinkBlockReason, number> = {
    previous_order_funds_found: 3,
    previous_order_funded: 3,
    previous_order_unverifiable: 2,
    previous_order_not_closed: 1,
  }
  let worst: RelinkCheck = { ok: true }
  for (const r of results) {
    if (r.ok) continue
    if (worst.ok || rank[r.reason] > rank[worst.reason]) worst = r
  }
  return worst
}

export const PREVIOUS_ORDER_FUNDED_MESSAGE =
  'An earlier order for this payment link received a payment. Do not pay again: ' +
  'check its status, or contact support with the order number.'

export const PREVIOUS_ORDER_PENDING_MESSAGE =
  'The previous order for this payment link has expired. If you already sent a payment, ' +
  'do not pay again: it can take up to 2 hours to be confirmed, and you can check its status. ' +
  'If you did not pay, try again in a few minutes.'
