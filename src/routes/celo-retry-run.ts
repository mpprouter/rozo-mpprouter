// Cron re-drive of queued Celo settlements (celo-retry.ts). Rebuilds the event
// from Rozo's own payment record (never from stored caller input), exactly as
// the checkout backlog replay does, and hands it to the normal settle path.
// It never calls pay-invoice itself.

import type { Env } from '../index'
import { baseLinkIdOf } from '../mpp/contract-variant'
import { fetchRozoPaymentById, settleCoinbaseEvent } from './webhook'
import { handleStripeWebhookEvent } from './stripe-fulfillment'
import { PAYIN_LIKE } from './checkout-control-admin'
import { runCeloRetries, type CeloRetryEntry, type CeloRetryRunResult } from './celo-retry'

export async function redriveCeloEntry(
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
  const eventType =
    status === 'payment_payout_completed'
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
