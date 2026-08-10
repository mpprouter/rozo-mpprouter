import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
} from '@stellar/stellar-sdk'

export interface Env {
  ROUTER_URL: string
  STELLAR_RPC_URL: string
  AUTO_REFUND_MAX_ATOMIC: string
  REFUND_ALERT_THRESHOLD_ATOMIC: string
  ROUTER_SIGNING_SECRET: string
  REFUND_EXECUTOR_TOKEN: string
  DINGTALK_ACCESS_TOKEN: string
}

export interface RefundJob {
  refundId: string
  publicId: string
  state: 'pending' | 'leased' | 'submitted'
  refundAmountAtomic: string
  reason: string
  merchant: string
  refundTx?: string
  signedXdr?: string
  lease?: { id: string; until: string }
  payment: {
    payer: string
    recipient: string
    asset: string
    paymentTx: string
    amountAtomic: string
  }
}

export interface RefundSignerRpc {
  getAccount: rpc.Server['getAccount']
  prepareTransaction: rpc.Server['prepareTransaction']
  sendTransaction: rpc.Server['sendTransaction']
  getTransaction: rpc.Server['getTransaction']
}

export type RefundPolicy = 'auto' | 'auto_alert' | 'hold_alert'

const PUBLIC_USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const POLL_INTERVAL_MS = 1_000
const POLL_ATTEMPTS = 25
const HARD_AUTO_REFUND_MAX_ATOMIC = 1_000_000_000n
const HARD_ALERT_THRESHOLD_ATOMIC = 100_000_000n
const HARD_MAX_FEE_STROOPS = 10_000_000n

export interface RefundLedger {
  reserve(job: RefundJob, paidAtomic: bigint): Promise<void>
  markConfirmed(refundId: string): Promise<void>
  enqueueAlert(key: string, content: string): Promise<void>
}

function parsePositiveAtomic(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${name} must be positive atomic units`)
  return BigInt(value)
}

function formatUsdc(amount: bigint): string {
  const whole = amount / 10_000_000n
  const fraction = (amount % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

export function classifyRefund(amount: bigint, max: bigint, alertThreshold: bigint): RefundPolicy {
  if (amount >= max) return 'hold_alert'
  if (amount > alertThreshold) return 'auto_alert'
  return 'auto'
}

export function assertRefundWithinPaid(reserved: bigint, amount: bigint, paid: bigint): void {
  if (reserved < 0n || amount <= 0n || paid <= 0n || reserved + amount > paid) {
    throw new Error('cumulative refunds exceed original payment')
  }
}

async function routerApi<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${env.ROUTER_URL.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.REFUND_EXECUTOR_TOKEN}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`)
  return value as T
}

function validateTransfer(tx: Transaction, expected: {
  from: string; to: string; asset: string; amount: bigint
}): void {
  if (tx.operations.length !== 1) throw new Error('transaction must contain exactly one operation')
  const op = tx.operations[0]
  if (op.type !== 'invokeHostFunction') throw new Error('transaction must invoke the SAC')
  const invocation = op.func.invokeContract()
  const actualAsset = Address.fromScAddress(invocation.contractAddress()).toString()
  const args = invocation.args().map((value) => scValToNative(value))
  if (actualAsset !== expected.asset || invocation.functionName().toString() !== 'transfer') {
    throw new Error('transaction is not the expected SAC transfer')
  }
  if (args[0] !== expected.from || args[1] !== expected.to || args[2] !== expected.amount) {
    throw new Error('transaction transfer fields do not match refund proof')
  }
}

async function verifyOriginalPayment(server: RefundSignerRpc, job: RefundJob): Promise<bigint> {
  if (!/^[0-9a-f]{64}$/.test(job.payment.paymentTx)) throw new Error('invalid payment transaction hash')
  const result = await server.getTransaction(job.payment.paymentTx)
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`original payment is not confirmed: ${result.status}`)
  const tx = TransactionBuilder.fromXDR(result.envelopeXdr, Networks.PUBLIC) as Transaction
  if (tx.hash().toString('hex') !== job.payment.paymentTx) throw new Error('original payment envelope hash mismatch')
  const paidAtomic = parsePositiveAtomic(job.payment.amountAtomic, 'original payment amount')
  validateTransfer(tx, {
    from: job.payment.payer, to: job.payment.recipient,
    asset: job.payment.asset, amount: paidAtomic,
  })
  if (BigInt(job.refundAmountAtomic) > paidAtomic) throw new Error('refund exceeds original payment')
  return paidAtomic
}

function validateJob(job: RefundJob, signer: Keypair): bigint {
  const amount = parsePositiveAtomic(job.refundAmountAtomic, 'refund amount')
  if (job.payment.recipient !== signer.publicKey()) throw new Error('refund signer is not original recipient')
  if (job.payment.asset !== PUBLIC_USDC_SAC) throw new Error('refund asset is not pubnet USDC SAC')
  if (!/^G[A-Z2-7]{55}$/.test(job.payment.payer)) throw new Error('refund payer is not a Stellar account')
  return amount
}

function assertLeasedJobMatches(job: RefundJob, leased: RefundJob): void {
  const originalProof = JSON.stringify({
    refundId: job.refundId,
    publicId: job.publicId,
    refundAmountAtomic: job.refundAmountAtomic,
    reason: job.reason,
    merchant: job.merchant,
    payment: job.payment,
  })
  const leasedProof = JSON.stringify({
    refundId: leased.refundId,
    publicId: leased.publicId,
    refundAmountAtomic: leased.refundAmountAtomic,
    reason: leased.reason,
    merchant: leased.merchant,
    payment: leased.payment,
  })
  if (originalProof !== leasedProof) throw new Error('leased refund proof changed')
}

async function waitForTransaction(server: RefundSignerRpc, hash: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const result = await server.getTransaction(hash)
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`refund transaction failed: ${hash}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`refund transaction confirmation timed out: ${hash}`)
}

export async function sendAlert(env: Env, content: string): Promise<void> {
  const response = await fetch(`https://oapi.dingtalk.com/robot/send?access_token=${env.DINGTALK_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
  })
  if (!response.ok) throw new Error(`DingTalk alert failed: ${response.status}`)
  const result = await response.json() as { errcode?: number; errmsg?: string }
  if (result.errcode !== 0) {
    throw new Error(`DingTalk alert rejected: ${result.errcode ?? 'missing'} ${result.errmsg ?? ''}`.trim())
  }
}

async function buildSignedRefund(
  server: RefundSignerRpc,
  signer: Keypair,
  job: RefundJob,
  amount: bigint,
): Promise<{ prepared: Transaction; signedXdr: string; refundTx: string }> {
  const account = await server.getAccount(signer.publicKey())
  const base = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(job.payment.asset).call(
      'transfer',
      Address.fromString(signer.publicKey()).toScVal(),
      Address.fromString(job.payment.payer).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    ))
    .setTimeout(60)
    .build()
  const prepared = await server.prepareTransaction(base)
  if (prepared.source !== signer.publicKey()) throw new Error('prepared refund source mismatch')
  if (prepared.toEnvelope().v1().tx().ext().switch() !== 1) throw new Error('prepared refund lacks Soroban resources')
  if (BigInt(prepared.fee) > HARD_MAX_FEE_STROOPS) throw new Error('prepared refund fee exceeds hard limit')
  validateTransfer(prepared, {
    from: signer.publicKey(), to: job.payment.payer,
    asset: job.payment.asset, amount,
  })
  prepared.sign(signer)
  if (prepared.signatures.length !== 1) throw new Error('prepared refund must have exactly one signature')
  return { prepared, signedXdr: prepared.toXDR(), refundTx: prepared.hash().toString('hex') }
}

async function confirmSubmitted(
  env: Env,
  server: RefundSignerRpc,
  signer: Keypair,
  job: RefundJob,
  beforeRouterConfirm: (refundTx: string) => Promise<void>,
  onRejected: (refundTx: string, detail?: string) => Promise<void>,
): Promise<string> {
  if (!job.signedXdr || !job.refundTx || !job.lease?.id) throw new Error('submitted refund is incomplete')
  const leaseId = job.lease.id
  const tx = TransactionBuilder.fromXDR(job.signedXdr, Networks.PUBLIC) as Transaction
  if (tx.hash().toString('hex') !== job.refundTx) throw new Error('submitted refund hash mismatch')
  if (tx.source !== job.payment.recipient || tx.toEnvelope().v1().tx().ext().switch() !== 1) {
    throw new Error('submitted refund envelope is structurally invalid')
  }
  if (BigInt(tx.fee) > HARD_MAX_FEE_STROOPS || tx.signatures.length !== 1) {
    throw new Error('submitted refund exceeds fee or signature limits')
  }
  validateTransfer(tx, {
    from: job.payment.recipient, to: job.payment.payer,
    asset: job.payment.asset, amount: BigInt(job.refundAmountAtomic),
  })
  const refundTx = job.refundTx
  // A prior invocation may have landed this tx (or died before submitting it).
  // If it already succeeded on chain, just confirm; never re-send.
  const existing = await server.getTransaction(refundTx)
  if (existing.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    // The stored envelope was signed with a 60s time bound. If that window
    // has passed and the tx is not on chain, re-sending the same XDR can
    // only ever be rejected (txTooLate) — the old failure mode that parked
    // every retried refund into manual_review. The expired envelope is
    // unusable by anyone, so signing a replacement cannot double-pay.
    const maxTime = BigInt(tx.timeBounds?.maxTime ?? '0')
    const expired = maxTime > 0n && maxTime < BigInt(Math.floor(Date.now() / 1000))
    if (expired && existing.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      // The Router's submitted state is immutable by design — a submitted
      // record's refundTx/signedXdr can never be overwritten. The sanctioned
      // recovery is requeue: the Router independently re-verifies that the
      // stored envelope is expired and absent on chain, then strips it and
      // returns the job to pending, from which the normal pending path signs
      // a fresh envelope under a fresh lease.
      await routerApi(env, '/admin/refunds/requeue-malformed', {
        method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
      })
      const requeued: RefundJob = { ...job, state: 'pending' }
      delete requeued.refundTx
      delete requeued.signedXdr
      delete requeued.lease
      return executePending(env, server, signer, requeued, beforeRouterConfirm, onRejected)
    }
    const send = await server.sendTransaction(tx)
    if (send.status === 'ERROR') {
      await parkRejected(env, job, refundTx)
      await onRejected(refundTx, String(send.errorResult ?? send.status))
      throw new Error(`submitted refund rejected and parked: ${refundTx}`)
    }
    await waitForTransaction(server, refundTx)
  }
  await beforeRouterConfirm(refundTx)
  await routerApi(env, '/admin/refunds/confirm', {
    method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
  })
  return refundTx
}

async function parkRejected(env: Env, job: RefundJob, refundTx: string): Promise<void> {
  if (!job.lease?.id) throw new Error('cannot park rejected refund without lease')
  await routerApi(env, '/admin/refunds/complete', {
    method: 'POST',
    body: JSON.stringify({ refundId: job.refundId, leaseId: job.lease.id, state: 'manual_review', refundTx }),
  })
}

async function executePending(
  env: Env,
  server: RefundSignerRpc,
  signer: Keypair,
  job: RefundJob,
  beforeRouterConfirm: (refundTx: string) => Promise<void>,
  onRejected: (refundTx: string, detail?: string) => Promise<void>,
): Promise<string> {
  const leaseId = crypto.randomUUID()
  const leased = await routerApi<{ job: RefundJob }>(env, '/admin/refunds/lease', {
    method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
  })
  assertLeasedJobMatches(job, leased.job)
  const amount = validateJob(leased.job, signer)
  const { prepared, signedXdr, refundTx } = await buildSignedRefund(server, signer, leased.job, amount)

  await routerApi(env, '/admin/refunds/complete', {
    method: 'POST',
    body: JSON.stringify({ refundId: job.refundId, leaseId, state: 'submitted', refundTx, signedXdr }),
  })
  const send = await server.sendTransaction(prepared)
  if (send.status === 'ERROR') {
    await parkRejected(env, leased.job, refundTx)
    await onRejected(refundTx, String(send.errorResult ?? send.status))
    throw new Error(`refund transaction rejected and parked: ${refundTx}`)
  }
  await waitForTransaction(server, refundTx)
  await beforeRouterConfirm(refundTx)
  await routerApi(env, '/admin/refunds/confirm', {
    method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
  })
  return refundTx
}

export async function runRefundSigner(
  env: Env,
  ledger: RefundLedger,
  serverOverride?: RefundSignerRpc,
): Promise<void> {
  const signer = Keypair.fromSecret(env.ROUTER_SIGNING_SECRET)
  const max = parsePositiveAtomic(env.AUTO_REFUND_MAX_ATOMIC, 'automatic refund max')
  const alertThreshold = parsePositiveAtomic(env.REFUND_ALERT_THRESHOLD_ATOMIC, 'refund alert threshold')
  if (max !== HARD_AUTO_REFUND_MAX_ATOMIC || alertThreshold !== HARD_ALERT_THRESHOLD_ATOMIC) {
    throw new Error('refund policy configuration does not match hard-coded safety limits')
  }
  const server = serverOverride ?? new rpc.Server(env.STELLAR_RPC_URL)
  const pending = await routerApi<{ jobs: RefundJob[] }>(env, '/admin/refunds/pending')

  for (const job of pending.jobs) {
    try {
      const amount = validateJob(job, signer)
      const paidAtomic = await verifyOriginalPayment(server, job)
      const policy = classifyRefund(amount, max, alertThreshold)
      if (policy === 'hold_alert') {
        await ledger.enqueueAlert(`held:${job.refundId}`, `MPP refund held for review: $${formatUsdc(amount)} (${job.publicId})`)
        continue
      }
      await ledger.reserve(job, paidAtomic)
      const beforeRouterConfirm = async (refundTx: string): Promise<void> => {
        if (policy === 'auto_alert') {
          await ledger.enqueueAlert(`large:${job.refundId}`, `MPP automatic refund completed: $${formatUsdc(amount)}, tx ${refundTx}`)
        }
      }
      const rejectedAlert = async (refundTx: string, detail?: string): Promise<void> => {
        await ledger.enqueueAlert(
          `rejected:${job.refundId}`,
          `MPP automatic refund requires manual review: $${formatUsdc(amount)}, merchant ${job.merchant}, ` +
            `payer ${job.payment.payer.slice(0, 6)}…${job.payment.payer.slice(-4)}, ` +
            `payment tx ${job.payment.paymentTx}, refund tx ${refundTx}` +
            (detail ? `, rpc: ${detail}` : ''),
        )
      }
      let refundTx: string
      if (job.state === 'submitted') {
        refundTx = await confirmSubmitted(env, server, signer, job, beforeRouterConfirm, rejectedAlert)
      } else if (job.state === 'pending' || job.state === 'leased') {
        refundTx = await executePending(env, server, signer, job, beforeRouterConfirm, rejectedAlert)
      } else {
        continue
      }
      await ledger.markConfirmed(job.refundId)
      console.log(JSON.stringify({ event: 'refund_confirmed', refundId: job.refundId, refundTx }))
    } catch (error: unknown) {
      console.error(JSON.stringify({
        event: 'refund_signer_job_failed', refundId: job.refundId,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
}
