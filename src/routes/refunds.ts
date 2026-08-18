import type { Env } from '../index'
import {
  completeRefund,
  leaseRefund,
  listRefunds,
  readRefund,
  readRefundByPublicId,
  refundIdForPaymentTx,
  requeueMalformedRefund,
  unparkRefund,
  type RefundRecord,
} from '../refund/refund'
import { hasSorobanTransactionData, isProvablyDeadEnvelope, validateSignedRefundXdr, verifyConfirmedRefund } from '../refund/stellar-proof'
import { ReceiptSigningUnavailable, signReceipt } from '../refund/receipt-signer'
import { rpc } from '@stellar/stellar-sdk'

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function authorized(request: Request, env: Env): boolean {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return !!supplied && (
    (!!env.REFUND_EXECUTOR_TOKEN && supplied === env.REFUND_EXECUTOR_TOKEN) ||
    (!!env.ADMIN_TOKEN && supplied === env.ADMIN_TOKEN)
  )
}

function signedReceipt(env: Env, record: NonNullable<Awaited<ReturnType<typeof readRefund>>>) {
  const receipt = {
    version: 1,
    payment_id: record.payment.paymentId,
    payment_tx: record.payment.paymentTx,
    merchant: record.merchant,
    amount: record.payment.amountAtomic,
    mode: record.payment.mode,
    outcome: BigInt(record.refundAmountAtomic) === BigInt(record.payment.amountAtomic)
      ? 'refunded_full' : 'refunded_partial',
    refund_tx: record.refundTx,
    refund_amount: record.refundAmountAtomic,
    reason: record.reason,
    confirmed_ledger: record.confirmedLedger,
    iat: record.createdAt,
    exp: new Date(Date.parse(record.createdAt) + 86_400_000).toISOString(),
  }
  return signReceipt(receipt, env.RECEIPT_SIGNING_SECRET)
}

export async function handleRefundStatus(env: Env, publicId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(publicId)) return json({ error: 'Not found' }, 404)
  const record = await readRefundByPublicId(env, publicId)
  if (!record) return json({ error: 'Not found' }, 404)
  if (record.state === 'confirmed') {
    try {
      return json(signedReceipt(env, record))
    } catch (error) {
      // Fail closed: an unsigned "receipt" would be indistinguishable from a
      // forgery, so we would rather return nothing than something unverifiable.
      if (error instanceof ReceiptSigningUnavailable) {
        return json({ error: 'Receipt signing unavailable' }, 503)
      }
      throw error
    }
  }
  return json({
    version: 1,
    refund_id: record.publicId,
    outcome: 'refund_pending',
    reason: record.reason,
    payment_tx: record.payment.paymentTx,
    refund_amount: record.refundAmountAtomic,
    merchant: record.merchant,
    iat: record.createdAt,
    confirmed_at: record.confirmedAt,
  })
}

/**
 * A refund is "stuck" once it has existed for longer than the pipeline could
 * plausibly need and still has not confirmed on chain. Ten minutes is ~10 cron
 * ticks and ~1 full envelope validity window: a healthy refund confirms in
 * well under a minute, so anything past this is a real fault, not slowness.
 */
export const STUCK_REFUND_THRESHOLD_MS = 10 * 60_000

export interface StuckRefund {
  refundId: string
  publicId: string
  state: string
  createdAt: string
  ageMs: number
  merchant: string
  refundAmountAtomic: string
  paymentTx: string
  orderId?: string
}

/**
 * Selects unconfirmed refunds older than the threshold, newest work last so an
 * operator reads the longest-stranded refund first.
 *
 * Deliberately driven off the refund records rather than the public order
 * ledger: a `refund_pending` ledger row is exactly the projection of a refund
 * record that has not reached `confirmed`, and scanning refunds is one DO scan
 * instead of a full KV keyspace walk every minute. The one case this cannot
 * see is an order row whose refund record was never created at all (the
 * non-atomic window in proxy.ts); that orphan sweep is tracked separately.
 */
export function selectStuckRefunds(
  records: RefundRecord[],
  now: number,
  thresholdMs: number = STUCK_REFUND_THRESHOLD_MS,
): StuckRefund[] {
  return records
    .filter((record) => record.state !== 'confirmed')
    .map((record) => ({ record, ageMs: now - Date.parse(record.createdAt) }))
    .filter(({ ageMs }) => Number.isFinite(ageMs) && ageMs >= thresholdMs)
    .sort((a, b) => b.ageMs - a.ageMs)
    .map(({ record, ageMs }) => ({
      refundId: record.refundId,
      publicId: record.publicId,
      state: record.state,
      createdAt: record.createdAt,
      ageMs,
      merchant: record.merchant,
      refundAmountAtomic: record.refundAmountAtomic,
      paymentTx: record.payment.paymentTx,
      ...(record.orderId ? { orderId: record.orderId } : {}),
    }))
}

export async function handleRefundAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401)
  if (url.pathname === '/admin/refunds/pending' && request.method === 'GET') {
    const jobs = (await listRefunds(env)).filter((job) =>
      job.state === 'pending' || job.state === 'leased' || job.state === 'submitted')
    return json({ jobs })
  }
  if (url.pathname === '/admin/refunds/stuck' && request.method === 'GET') {
    const minutesRaw = url.searchParams.get('minutes')
    let thresholdMs = STUCK_REFUND_THRESHOLD_MS
    if (minutesRaw !== null) {
      const minutes = Number(minutesRaw)
      if (!Number.isFinite(minutes) || minutes < 0) return json({ error: 'minutes must be a non-negative number' }, 400)
      thresholdMs = minutes * 60_000
    }
    return json({ jobs: selectStuckRefunds(await listRefunds(env), Date.now(), thresholdMs) })
  }
  // Unpark is addressable by the on-chain payment hash, because that is the
  // only identifier an operator can read off the public ledger row. Parsed
  // ahead of the shared body guard below, which requires a leaseId that an
  // out-of-band recovery has no way to hold.
  if (url.pathname === '/admin/refunds/unpark' && request.method === 'POST') {
    const payload = await request.json().catch(() => null) as any
    const paymentTx = typeof payload?.paymentTx === 'string' ? payload.paymentTx.toLowerCase() : null
    if (paymentTx !== null && !/^[0-9a-f]{64}$/.test(paymentTx)) {
      return json({ error: 'paymentTx must be a 64-character hex transaction hash' }, 400)
    }
    const refundId = typeof payload?.refundId === 'string' && /^[0-9a-f]{64}$/.test(payload.refundId)
      ? payload.refundId
      : paymentTx ? await refundIdForPaymentTx(paymentTx) : null
    if (!refundId) return json({ error: 'refundId or paymentTx required' }, 400)
    const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 200) : undefined
    const outcome = await unparkRefund(env, refundId, reason)
    if (!outcome.ok) {
      return outcome.error === 'not_found'
        ? json({ error: 'Refund not found' }, 404)
        : json({ error: `Refusing to unpark a refund in state ${outcome.state}` }, 409)
    }
    console.log(JSON.stringify({
      event: 'refund_unparked', refundId, changed: outcome.changed, state: outcome.record.state,
    }))
    return json({ ok: true, changed: outcome.changed, job: outcome.record })
  }
  const body = await request.json().catch(() => null) as any
  if (!body?.refundId || !body?.leaseId) return json({ error: 'refundId and leaseId required' }, 400)
  if (url.pathname === '/admin/refunds/lease' && request.method === 'POST') {
    const job = await leaseRefund(env, body.refundId, body.leaseId)
    return job ? json({ job }) : json({ error: 'Not available' }, 409)
  }
  if (url.pathname === '/admin/refunds/complete' && request.method === 'POST') {
    if (!['submitted', 'manual_review'].includes(body.state) || !body.refundTx) {
      return json({ error: 'Valid non-final state and refundTx required' }, 400)
    }
    const current = await readRefund(env, body.refundId)
    if (!current || current.lease?.id !== body.leaseId) return json({ error: 'Lease mismatch' }, 409)
    if (body.state === 'submitted') {
      if (typeof body.signedXdr !== 'string') return json({ error: 'signedXdr required' }, 400)
      const computed = validateSignedRefundXdr(current, body.signedXdr, env.STELLAR_NETWORK)
      if (computed !== body.refundTx) return json({ error: 'refundTx does not match signedXdr' }, 400)
      if (!hasSorobanTransactionData(body.signedXdr, env.STELLAR_NETWORK)) {
        return json({ error: 'Refund transaction is missing Soroban resource data' }, 400)
      }
    }
    const job = await completeRefund(env, body.refundId, body.leaseId, {
      state: body.state,
      refundTx: body.refundTx,
      signedXdr: body.signedXdr,
    })
    return job ? json({ job }) : json({ error: 'Lease mismatch' }, 409)
  }
  if (url.pathname === '/admin/refunds/confirm' && request.method === 'POST') {
    const current = await readRefund(env, body.refundId)
    if (!current || current.lease?.id !== body.leaseId || !current.signedXdr || !current.refundTx) {
      return json({ error: 'Submitted refund not found or lease mismatch' }, 409)
    }
    try {
      const proof = await verifyConfirmedRefund(current, current.signedXdr, env.STELLAR_NETWORK, env.STELLAR_RPC_URL)
      const job = await completeRefund(env, body.refundId, body.leaseId, {
        state: 'confirmed', refundTx: proof.txHash, confirmedLedger: proof.ledger,
      })
      return json({ job })
    } catch (error: any) {
      return json({ error: error.message }, 409)
    }
  }
  if (url.pathname === '/admin/refunds/requeue-malformed' && request.method === 'POST') {
    const current = await readRefund(env, body.refundId)
    if (!current || current.state !== 'submitted' || current.lease?.id !== body.leaseId ||
        !current.signedXdr || !current.refundTx) {
      return json({ error: 'Submitted refund not found or lease mismatch' }, 409)
    }
    const computed = validateSignedRefundXdr(current, current.signedXdr, env.STELLAR_NETWORK)
    if (computed !== current.refundTx) return json({ error: 'Stored refund proof mismatch' }, 409)
    const result = await new rpc.Server(env.STELLAR_RPC_URL).getTransaction(current.refundTx)
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return json({ error: `Refusing to replace transaction in state ${result.status}` }, 409)
    }
    // A structurally valid envelope may only be replaced once it is PROVABLY
    // dead: a closed ledger past its time bound AND retained RPC history
    // covering its whole inclusion window — all taken from the same response
    // that reported NOT_FOUND. Anything less (unexpired, or possibly pruned
    // history) is refused and stays for manual review, because the original
    // may still land or may already have landed.
    const r = result as { latestLedgerCloseTime?: number | string; oldestLedgerCloseTime?: number | string }
    if (hasSorobanTransactionData(current.signedXdr, env.STELLAR_NETWORK) &&
        !isProvablyDeadEnvelope(current.signedXdr, env.STELLAR_NETWORK,
          Number(r.latestLedgerCloseTime ?? 0), Number(r.oldestLedgerCloseTime ?? 0))) {
      return json({ error: 'Refusing to replace: envelope not provably dead (unexpired, or RPC history may be pruned)' }, 409)
    }
    const job = await requeueMalformedRefund(env, body.refundId, body.leaseId, current.refundTx)
    return job ? json({ job }) : json({ error: 'Refund changed during recovery' }, 409)
  }
  return json({ error: 'Not found' }, 404)
}
