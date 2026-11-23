// Cron re-drive of queued Celo settlements (celo-retry.ts). Rebuilds the event
// from Rozo's own payment record (never from stored caller input), exactly as
// the checkout backlog replay does, and hands it to the normal settle path.
// It never calls pay-invoice itself.

import type { Env } from '../index'
import { baseLinkIdOf } from '../mpp/contract-variant'
import { fetchRozoPaymentById, loadRecord, settleCoinbaseEvent } from './webhook'
import { handleStripeWebhookEvent, invoiceKeyFromOrderId, loadStripeRecordForStatus } from './stripe-fulfillment'
import { PAYIN_LIKE } from './checkout-control-admin'
import { runCeloRetries, type CeloRetryEntry, type CeloRetryRunResult } from './celo-retry'

// Pre-pay statuses in which nothing was sent and no human was paged: the
// order still needs a trigger, so the queue keeps it (a Celo deferral may have
// consumed the payout webhook that would normally have driven it).
// failed_insufficient_balance is excluded: the settle path already paged a
// human with "top up, then replay", and re-driving it would page every run.
const KEEP_COINBASE: ReadonlySet<string> = new Set(['payin_seen'])
const KEEP_STRIPE: ReadonlySet<string> = new Set(['rozo_payment_created', 'payin_seen', 'payout_seen'])

/**
 * Re-drives one entry, then reports whether the queue must keep it
 * (`celoRetryKeep`): true while the order's record is still in a pre-pay
 * state with no human hand-off; false once it is paid, in flight, terminal,
 * parked for a human, or owned by the checkout-pause backlog.
 */
export async function redriveCeloEntry(
  env: Env,
  entry: CeloRetryEntry,
  eventId: string,
): Promise<Record<string, unknown>> {
  const summary = await redriveOnce(env, entry, eventId)
  if (summary.deferred === 'celo_finality' || summary.deferred === 'rozo_unreadable') return summary
  if (summary.deferred === 'checkout_paused') return { ...summary, celoRetryKeep: false }
  let status: string | null = null
  try {
    if (entry.provider === 'stripe') {
      status = (await loadStripeRecordForStatus(env, invoiceKeyFromOrderId(entry.ref)))?.status ?? null
    } else {
      status = (await loadRecord(env, entry.ref))?.status ?? null
    }
  } catch {
    return { ...summary, celoRetryKeep: true }
  }
  const keep = status === null || (entry.provider === 'stripe' ? KEEP_STRIPE : KEEP_COINBASE).has(status)
  return { ...summary, celoRetryKeep: keep, celoRetryRecordStatus: status }
}

async function redriveOnce(
  env: Env,
  entry: CeloRetryEntry,
  eventId: string,
): Promise<Record<string, unknown>> {
  if (!entry.rozoPaymentId) return { deferred: 'rozo_unreadable', reason: 'no Rozo payment id' }
  const rozo = await fetchRozoPaymentById(env, entry.rozoPaymentId)
  if (!rozo || typeof rozo !== 'object') return { deferred: 'rozo_unreadable', reason: 'Rozo payment unreadable' }
  const orderId = typeof rozo.orderId === 'string' ? rozo.orderId : ''
  const matches = entry.provider === 'stripe' ? orderId === entry.ref : baseLinkIdOf(orderId) === entry.ref
  if (!matches) return { deferred: 'rozo_unreadable', reason: 'Rozo payment orderId does not match the entry' }
  const status = typeof rozo.status === 'string' ? rozo.status : ''
  // payment_completed is a terminal "paid out" status too (same as
  // ROZO_ORDER_PAID_STATUSES / Bitrefill ORDER_PAID_OUT): drive it as the
  // confirmed payout event, so a deferred order whose Rozo row moved on is
  // still settled once finalized instead of retrying until the give-up alert.
  const eventType =
    status === 'payment_payout_completed' || status === 'payment_completed'
      ? 'payment_payout_completed'
      : PAYIN_LIKE.has(status)
        ? 'payment_payin_completed'
        : null
  if (!eventType) return { deferred: 'rozo_unreadable', reason: `Rozo status ${status || 'unknown'} not payable` }

  if (entry.provider === 'stripe') {
    return handleStripeWebhookEvent(
      env,
      {
        eventId,
        eventType,
        orderId: entry.ref,
        rozoPaymentId: entry.rozoPaymentId,
        invoiceAmountStr: rozo.destination?.amount ?? rozo.source?.amount ?? null,
        sourceChainId: rozo.source?.chainId ?? rozo.source_chain_id,
        sourceTxHash: rozo.source?.txHash ?? null,
      },
      new Date(),
    )
  }
  // Coinbase and Bitrefill: settleCoinbaseEvent routes Bitrefill ids itself.
  return settleCoinbaseEvent(env, {
    eventId,
    eventType,
    plId: entry.ref,
    rozoPaymentId: entry.rozoPaymentId,
    evt: {
      event_id: eventId,
      type: eventType,
      data: {
        id: entry.rozoPaymentId,
        appId: rozo.appId,
        orderId,
        status,
        source: rozo.source,
        destination: rozo.destination,
      },
    },
    now: Date.now(),
  })
}

/** Cron entry point (2-minute cron). Never throws. */
export async function sweepCeloRetries(env: Env, now: Date = new Date()): Promise<CeloRetryRunResult[]> {
  try {
    return await runCeloRetries(env, redriveCeloEntry, now)
  } catch (err) {
    console.warn(`[celo-retry] run failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
