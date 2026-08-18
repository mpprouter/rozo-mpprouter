import type { Env } from '../index'
import { doAtomicParams } from '../mpp/kv-atomic-store'
import { updateOrderRefundStatus } from '../services/order-ledger'

export type RefundReason = 'timeout' | 'upstream_5xx' | 'non_fulfillment' | 'empty_response'
export type RefundState = 'pending' | 'leased' | 'submitted' | 'confirmed' | 'manual_review'

export interface PaymentProof {
  paymentId: string
  paymentTx: string
  payer: string
  recipient: string
  asset: string
  amountAtomic: string
  mode: 'charge' | 'channel'
}

export interface RefundRecord {
  version: 1
  refundId: string
  /** Random capability used by the public status endpoint. */
  publicId: string
  state: RefundState
  reason: RefundReason
  payment: PaymentProof
  merchant: string
  routeId: string
  /**
   * Order-ledger row this refund belongs to, so the public ledger row can be
   * moved from `refund_pending` to `refunded` when the return confirms.
   * Optional: refunds enqueued before this field existed, and any future
   * caller that has no ledger row, simply skip the write-back.
   */
  orderId?: string
  refundAmountAtomic: string
  createdAt: string
  lease?: { id: string; until: string }
  refundTx?: string
  signedXdr?: string
  confirmedLedger?: number
  confirmedAt?: string
}

const PREFIX = 'refund:v1:'

export function refundAmountAtomic(input: {
  mode: 'charge' | 'channel'
  paidAtomic: bigint
  deliveredAtomic?: bigint
}): bigint {
  if (input.mode === 'charge') return input.paidAtomic
  const delivered = input.deliveredAtomic ?? 0n
  return delivered >= input.paidAtomic ? 0n : input.paidAtomic - delivered
}

function parseRecord(raw: string | null): RefundRecord | null {
  if (!raw) return null
  return JSON.parse(raw) as RefundRecord
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function payerAccount(source: string): string {
  const account = source.split(':').at(-1) || ''
  if (!/^G[A-Z2-7]{55}$/.test(account)) throw new Error('Verified payer DID has no Stellar G account')
  return account
}

export async function enqueueRefund(
  env: Env,
  input: {
    proof: PaymentProof
    reason: RefundReason
    merchant: string
    routeId: string
    orderId?: string
  },
): Promise<RefundRecord> {
  if (!/^[0-9]+$/.test(input.proof.amountAtomic) || BigInt(input.proof.amountAtomic) <= 0n) {
    throw new Error('Refund amount must be positive atomic units')
  }
  const refundId = await sha256(`refund-v1:${input.proof.paymentTx}:full`)
  const publicId = crypto.randomUUID()
  const store = doAtomicParams(env.ATOMIC_STORE)
  const record = await store.update(`${PREFIX}${refundId}`, (current) => {
    const existing = parseRecord(current)
    if (existing) return { op: 'noop', result: existing }
    const created: RefundRecord = {
      version: 1,
      refundId,
      publicId,
      state: 'pending',
      reason: input.reason,
      payment: input.proof,
      merchant: input.merchant,
      routeId: input.routeId,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      refundAmountAtomic: input.proof.amountAtomic,
      createdAt: new Date().toISOString(),
    }
    return { op: 'set', value: JSON.stringify(created), result: created }
  })
  // A separate random capability prevents public status enumeration. Re-run
  // this idempotent write even when the payment record already existed so a
  // transient failure between the two keys self-repairs on request retry.
  await store.put(`refund:public:${record.publicId}`, record.refundId)
  return record
}

export async function listRefunds(env: Env): Promise<RefundRecord[]> {
  const stub = env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('mppx'))
  const response = await stub.fetch(new Request('https://atomic.internal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: PREFIX }),
  }))
  if (!response.ok) throw new Error(`Refund scan failed: ${response.status}`)
  const body = await response.json() as { values: string[] }
  return body.values.map((value) => parseRecord(value)).filter((value): value is RefundRecord => !!value)
}

export async function readRefundByPublicId(env: Env, publicId: string): Promise<RefundRecord | null> {
  const store = doAtomicParams(env.ATOMIC_STORE)
  const refundId = await store.get(`refund:public:${publicId}`) as string | null
  return refundId ? readRefund(env, refundId) : null
}

export async function readRefund(env: Env, refundId: string): Promise<RefundRecord | null> {
  const store = doAtomicParams(env.ATOMIC_STORE)
  return parseRecord(await store.get(`${PREFIX}${refundId}`) as string | null)
}

export async function leaseRefund(env: Env, refundId: string, leaseId: string): Promise<RefundRecord | null> {
  const store = doAtomicParams(env.ATOMIC_STORE)
  const now = Date.now()
  return store.update(`${PREFIX}${refundId}`, (current) => {
    const record = parseRecord(current)
    if (!record) return { op: 'noop', result: null }
    const active = record.state === 'leased' && record.lease && Date.parse(record.lease.until) > now
    if (record.state !== 'pending' && active) return { op: 'noop', result: null }
    if (record.state !== 'pending' && record.state !== 'leased') return { op: 'noop', result: null }
    const leased: RefundRecord = {
      ...record,
      state: 'leased',
      lease: { id: leaseId, until: new Date(now + 60_000).toISOString() },
    }
    return { op: 'set', value: JSON.stringify(leased), result: leased }
  })
}

export async function completeRefund(
  env: Env,
  refundId: string,
  leaseId: string,
  update: {
    state: 'submitted' | 'confirmed' | 'manual_review'
    refundTx: string
    signedXdr?: string
    confirmedLedger?: number
  },
): Promise<RefundRecord | null> {
  const store = doAtomicParams(env.ATOMIC_STORE)
  const result = await store.update(`${PREFIX}${refundId}`, (current) => {
    const record = parseRecord(current)
    if (!record) return { op: 'noop', result: null }
    if (record.state === 'confirmed') return { op: 'noop', result: record }
    if (record.lease?.id !== leaseId) return { op: 'noop', result: null }
    if (record.state === 'submitted' && update.state !== 'confirmed') {
      const identical = record.refundTx === update.refundTx &&
        (update.signedXdr === undefined || record.signedXdr === update.signedXdr)
      if (update.state === 'submitted') return { op: 'noop', result: identical ? record : null }
      if (!identical) return { op: 'noop', result: null }
      const reviewed: RefundRecord = { ...record, state: 'manual_review' }
      return { op: 'set', value: JSON.stringify(reviewed), result: reviewed }
    }
    if (update.state === 'confirmed' && record.state !== 'submitted') {
      return { op: 'noop', result: null }
    }
    if (update.state === 'submitted' && (!update.signedXdr || record.state !== 'leased')) {
      return { op: 'noop', result: null }
    }
    const next: RefundRecord = {
      ...record,
      state: update.state,
      refundTx: update.refundTx,
      signedXdr: update.signedXdr ?? record.signedXdr,
      confirmedLedger: update.confirmedLedger ?? record.confirmedLedger,
      ...(update.state === 'confirmed' ? { confirmedAt: new Date().toISOString() } : {}),
    }
    return { op: 'set', value: JSON.stringify(next), result: next }
  })
  // Close the loop on the public ledger: the order row was written as
  // `refund_pending` when the merchant leg failed, and stays that way until
  // the return is confirmed on chain. Only `confirmed` flips it — `submitted`
  // means a tx exists but has not been included, and `manual_review` means it
  // may never be. Best-effort by design (see updateOrderRefundStatus): the
  // refund record here, not the KV ledger row, is the source of truth for
  // whether the money went back, so a KV hiccup must not fail the refund.
  if (result && result.state === 'confirmed' && result.orderId) {
    await updateOrderRefundStatus(env, result.orderId, 'refunded')
  }
  return result
}

export async function requeueMalformedRefund(
  env: Env,
  refundId: string,
  leaseId: string,
  expectedTx: string,
): Promise<RefundRecord | null> {
  const store = doAtomicParams(env.ATOMIC_STORE)
  return store.update(`${PREFIX}${refundId}`, (current) => {
    const record = parseRecord(current)
    if (!record || record.state !== 'submitted' || record.lease?.id !== leaseId) {
      return { op: 'noop', result: null }
    }
    if (record.refundTx !== expectedTx || !record.signedXdr) {
      return { op: 'noop', result: null }
    }
    const { refundTx: _refundTx, signedXdr: _signedXdr, lease: _lease, ...rest } = record
    const pending: RefundRecord = { ...rest, state: 'pending' }
    return { op: 'set', value: JSON.stringify(pending), result: pending }
  })
}
