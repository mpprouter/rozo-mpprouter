import { Credential } from 'mppx'
import type { Env } from '../index'
import { doAtomicParams } from './kv-atomic-store'

export type RefundReason =
  | 'upstream_timeout'
  | 'upstream_5xx'
  | 'upstream_refused'
  | 'malformed_after_charge'
  | 'duplicate_payment'

export type RefundMode = 'charge' | 'channel'

export type RefundDecision =
  | { eligible: false; amountRaw: '0'; outcome: 'delivered' | 'rejected_no_charge' }
  | { eligible: true; amountRaw: string; outcome: 'refunded_full' | 'refunded_partial' }

const INTEGER = /^\d+$/

function raw(value: string, field: string): bigint {
  if (!INTEGER.test(value)) throw new Error(`${field} must be a non-negative integer string`)
  return BigInt(value)
}

export function decimalToRaw(value: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error('invalid decimal amount')
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw new Error(`amount exceeds ${decimals}-decimal precision`)
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString()
}

/** Pure policy shared by the Worker, the offline executor, and CI tests. */
export function decideRefund(input: {
  mode: RefundMode
  paymentSettled: boolean
  delivered: boolean
  amountRaw: string
  depositCapRaw?: string
  cumulativeDeliveredRaw?: string
}): RefundDecision {
  const amount = raw(input.amountRaw, 'amountRaw')
  if (!input.paymentSettled) return { eligible: false, amountRaw: '0', outcome: 'rejected_no_charge' }
  if (input.delivered) return { eligible: false, amountRaw: '0', outcome: 'delivered' }

  if (input.mode === 'charge') {
    if (amount === 0n) throw new Error('settled charge amount must be greater than zero')
    return { eligible: true, amountRaw: amount.toString(), outcome: 'refunded_full' }
  }

  if (input.depositCapRaw === undefined || input.cumulativeDeliveredRaw === undefined) {
    throw new Error('channel refund requires depositCapRaw and cumulativeDeliveredRaw')
  }
  const cap = raw(input.depositCapRaw, 'depositCapRaw')
  const delivered = raw(input.cumulativeDeliveredRaw, 'cumulativeDeliveredRaw')
  if (delivered > cap) throw new Error('cumulativeDeliveredRaw exceeds depositCapRaw')
  const remainder = cap - delivered
  if (remainder === 0n) return { eligible: false, amountRaw: '0', outcome: 'delivered' }
  return {
    eligible: true,
    amountRaw: remainder.toString(),
    outcome: delivered === 0n ? 'refunded_full' : 'refunded_partial',
  }
}

export type PendingRefund = {
  version: 1
  status: 'pending_manual'
  paymentId: string
  paymentTx?: string
  payer: string
  merchant: string
  amountRaw: string
  mode: RefundMode
  reason: RefundReason
  detectedAt: string
  reportBy: string
}

function parseCredential(authHeader: string): { paymentId: string; paymentTx?: string; payer: string; amountRaw: string } {
  const credential = Credential.deserialize(authHeader) as {
    challenge?: { id?: string; method?: string; intent?: string; request?: { amount?: string } }
    source?: string
    payload?: { hash?: string }
  }
  const paymentId = credential.challenge?.id
  const payer = credential.source?.match(/^did:pkh:stellar:[^:]+:(G[A-Z2-7]{55})$/)?.[1]
  const amountRaw = credential.challenge?.request?.amount
  if (credential.challenge?.method !== 'stellar' || credential.challenge?.intent !== 'charge') {
    throw new Error('manual refund queue accepts only stellar.charge credentials')
  }
  if (!paymentId || !payer || !amountRaw || !INTEGER.test(amountRaw)) {
    throw new Error('refund requires a valid Stellar charge credential')
  }
  const paymentTx = credential.payload?.hash
  return { paymentId, payer, amountRaw, ...(paymentTx ? { paymentTx: paymentTx.toLowerCase() } : {}) }
}

/**
 * Atomically records that an offline operator refund is owed. This function
 * never claims that money moved and never has access to the operator key.
 */
export async function enqueueManualRefund(env: Env, input: {
  authHeader: string
  merchant: string
  amountRaw: string
  mode: RefundMode
  reason: RefundReason
  now?: Date
}): Promise<{ record: PendingRefund; created: boolean }> {
  raw(input.amountRaw, 'amountRaw')
  if (BigInt(input.amountRaw) <= 0n) throw new Error('refund amount must be greater than zero')
  const payment = parseCredential(input.authHeader)
  if (payment.amountRaw !== input.amountRaw) {
    throw new Error('refund amount does not match the verified payment challenge')
  }
  const now = input.now ?? new Date()
  const record: PendingRefund = {
    version: 1,
    status: 'pending_manual',
    paymentId: payment.paymentId,
    payer: payment.payer,
    ...(payment.paymentTx ? { paymentTx: payment.paymentTx } : {}),
    merchant: input.merchant,
    amountRaw: input.amountRaw,
    mode: input.mode,
    reason: input.reason,
    detectedAt: now.toISOString(),
    reportBy: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }
  const store = doAtomicParams(env.ATOMIC_STORE)
  const result = await store.update(`refund:v1:${payment.paymentId}`, current => {
    if (current) {
      const existing = JSON.parse(current) as PendingRefund
      const sameDebt = existing.paymentId === record.paymentId &&
        existing.payer === record.payer && existing.merchant === record.merchant &&
        existing.amountRaw === record.amountRaw && existing.mode === record.mode &&
        existing.reason === record.reason && existing.paymentTx === record.paymentTx
      if (!sameDebt) throw new Error('refund idempotency conflict: stored debt differs')
      return { op: 'noop', result: { record: existing, created: false } }
    }
    return { op: 'set', value: JSON.stringify(record), result: { record, created: true } }
  })
  return result
}
