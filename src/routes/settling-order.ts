/**
 * Which Rozo order is paying a provider invoice?
 *
 * One provider invoice (Coinbase link, Stripe session) can have several Rozo
 * orders: a contract-mode supersede sibling, or a `__retryN` re-order after an
 * earlier order expired unfunded. They all share ONE fulfillment record, so
 * the invoice settles at most once, but the record used to keep whichever
 * Rozo id it saw first, which can be an expired order that never paid. The
 * delivered report and the stuck-order checks then looked at the wrong order.
 *
 * The record now follows the order whose payin / payout event drives
 * settlement, and a settlement event from a SECOND order is a double
 * payment: the payer of that order has to be refunded by hand, so it is
 * reported once instead of being silently absorbed.
 */
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'
import type { Env } from '../index'

export interface SettlingTrack {
  rozoPaymentId: string | null
  /** The Rozo order whose payin / payout event first drove settlement. */
  settlingRozoPaymentId?: string | null
  /** Other Rozo orders that also reported a payin / payout (refund needed). */
  duplicateRozoPaymentIds?: string[]
}

export type SettlingDecision =
  /** Not a settlement event, or no Rozo id on it. */
  | 'none'
  /** This order is now the settling order of the record. */
  | 'adopted'
  /** Same order as the one already settling. */
  | 'same'
  /** A second order paid the same invoice; first time we see it. */
  | 'duplicate'
  /** A second order, already reported. */
  | 'duplicate_seen'

/**
 * Mutates `rec`. `locked` = the record already entered a pay attempt or a
 * terminal state; for records written before `settlingRozoPaymentId` existed
 * the stored `rozoPaymentId` is then taken as the settling order.
 */
export function trackSettlingOrder(
  rec: SettlingTrack,
  incoming: string | null | undefined,
  settles: boolean,
  locked: boolean,
): SettlingDecision {
  if (!incoming) return 'none'
  if (!settles) {
    if (!rec.rozoPaymentId) rec.rozoPaymentId = incoming
    return 'none'
  }
  const settling = rec.settlingRozoPaymentId ?? (locked ? rec.rozoPaymentId : null)
  if (!settling) {
    rec.settlingRozoPaymentId = incoming
    rec.rozoPaymentId = incoming
    return 'adopted'
  }
  if (!rec.settlingRozoPaymentId) rec.settlingRozoPaymentId = settling
  if (settling === incoming) return 'same'
  const seen = rec.duplicateRozoPaymentIds ?? []
  if (seen.includes(incoming)) return 'duplicate_seen'
  rec.duplicateRozoPaymentIds = [...seen, incoming]
  return 'duplicate'
}

/** Merge the tracking fields of two copies of one record (guarded saves). */
export function mergeSettlingTrack(stored: SettlingTrack, next: SettlingTrack): SettlingTrack {
  const settling = stored.settlingRozoPaymentId ?? next.settlingRozoPaymentId ?? null
  // A concurrently adopted second settling order is a duplicate payment.
  const raced =
    stored.settlingRozoPaymentId && next.settlingRozoPaymentId &&
    stored.settlingRozoPaymentId !== next.settlingRozoPaymentId
      ? [next.settlingRozoPaymentId]
      : []
  const dups = Array.from(
    new Set([...(stored.duplicateRozoPaymentIds ?? []), ...(next.duplicateRozoPaymentIds ?? []), ...raced]),
  ).filter((id) => id !== settling)
  return {
    rozoPaymentId: settling ?? stored.rozoPaymentId ?? next.rozoPaymentId ?? null,
    settlingRozoPaymentId: settling,
    duplicateRozoPaymentIds: dups,
  }
}

function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : 'unknown'
}

/** Best-effort ops alert for a second paying order. Never throws. */
export async function sendDuplicatePaymentAlert(
  env: Env,
  params: {
    provider: 'coinbase' | 'stripe_crypto'
    invoiceRef: string
    settlingRozoPaymentId: string | null
    duplicateRozoPaymentId: string
    eventType: string
    amount: string | null
  },
): Promise<void> {
  const text = [
    '[MPP Router] 🚨 Second payment for one invoice: refund needed',
    `Provider: ${params.provider}; invoice: ${params.invoiceRef}`,
    `Settling Rozo order: ${shortId(params.settlingRozoPaymentId)}`,
    `Extra Rozo order: ${shortId(params.duplicateRozoPaymentId)} (${params.eventType}, ${params.amount ?? '?'} USDC)`,
    'The invoice is settled at most once. Refund the extra order by hand; never pay the invoice again.',
    `At: ${new Date().toISOString()}`,
  ].join('\n')
  try {
    if (!alertSinkConfigured(env)) {
      console.warn(`[settling-order] duplicate payment alert SKIPPED (no channel): ${text.replace(/\n/g, ' | ')}`)
      return
    }
    await sendAlert(env, redactForAlert(text))
  } catch (err) {
    console.warn(
      `[settling-order] duplicate payment alert error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
