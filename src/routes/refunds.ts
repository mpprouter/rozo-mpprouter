import type { Env } from '../index'
import { completeRefund, leaseRefund, listRefunds, readRefund, readRefundByPublicId, requeueMalformedRefund } from '../refund/refund'
import { hasSorobanTransactionData, validateSignedRefundXdr, verifyConfirmedRefund } from '../refund/stellar-proof'
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

async function signedReceipt(env: Env, record: NonNullable<Awaited<ReturnType<typeof readRefund>>>) {
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
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.MPP_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(receipt)))
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { receipt, signature: encoded, algorithm: 'HS256' }
}

export async function handleRefundStatus(env: Env, publicId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(publicId)) return json({ error: 'Not found' }, 404)
  const record = await readRefundByPublicId(env, publicId)
  if (!record) return json({ error: 'Not found' }, 404)
  if (record.state === 'confirmed') return json(await signedReceipt(env, record))
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

export async function handleRefundAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401)
  if (url.pathname === '/admin/refunds/pending' && request.method === 'GET') {
    const jobs = (await listRefunds(env)).filter((job) =>
      job.state === 'pending' || job.state === 'leased' || job.state === 'submitted')
    return json({ jobs })
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
    if (hasSorobanTransactionData(current.signedXdr, env.STELLAR_NETWORK)) {
      return json({ error: 'Refusing to replace a structurally valid Soroban transaction' }, 409)
    }
    const result = await new rpc.Server(env.STELLAR_RPC_URL).getTransaction(current.refundTx)
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return json({ error: `Refusing to replace transaction in state ${result.status}` }, 409)
    }
    const job = await requeueMalformedRefund(env, body.refundId, body.leaseId, current.refundTx)
    return job ? json({ job }) : json({ error: 'Refund changed during recovery' }, 409)
  }
  return json({ error: 'Not found' }, 404)
}
