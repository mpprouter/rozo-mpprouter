import {
  Account,
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
import type { RedactedAlert } from './utils/alert-redaction'

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

/**
 * Backwards grace on `minTime`, absorbing modest clock skew between this
 * worker and the network without widening the inclusion window materially.
 */
export const REFUND_TX_MIN_TIME_GRACE_SECONDS = 60

/**
 * Forward validity of a signed refund envelope.
 *
 * WAS 60 seconds, which was shorter than this pipeline's own retry loop:
 * `waitForTransaction` alone polls for up to 25s, the cron granularity is
 * 60s, and a submission that fails once cannot be retried before the envelope
 * is already past `maxTime`. From there every re-send returns `txTooLate` ->
 * `ERROR` -> `parkRejected` -> `manual_review`, which until now was terminal.
 * One transient RPC hiccup therefore stranded a customer refund permanently
 * (investigation: docs/reports/refund-stuck-investigation-2026-08-18.md).
 *
 * Ten minutes covers ~10 cron ticks with room for several confirmation polls,
 * and also makes the "provably dead envelope" retention check satisfiable by
 * an RPC with a short history window. Widening it is safe: the envelope is
 * single-use (one sequence number), amount-bound, source-bound and
 * destination-bound, so a longer window cannot change what it can pay, only
 * for how long it may still be included.
 */
export const REFUND_TX_VALIDITY_SECONDS = 600

/**
 * Keeps one refund's source-account sequence from colliding with the next
 * refund's in the same cron run.
 *
 * `runRefundSigner` processes jobs sequentially from a SINGLE source account,
 * re-reading it with `getAccount` before each signature. Soroban RPC does not
 * guarantee that read reflects a transaction submitted moments earlier, so
 * refund #2 could be built on refund #1's already-consumed sequence, get
 * `txBadSeq` on submit, and be parked into `manual_review` on its very first
 * attempt — the observed "first refund fine, second refund dead" asymmetry.
 *
 * The guard only ever moves the sequence FORWARD, and only records a sequence
 * that the network actually accepted. A rejected submission consumes nothing,
 * so nothing is recorded and no gap is created for the next job.
 */
export class RefundSequenceGuard {
  private lastAccepted?: bigint

  /** Returns a source account no older than the last sequence the network accepted. */
  advance(account: Account): Account {
    const fetched = BigInt(account.sequenceNumber())
    if (this.lastAccepted !== undefined && fetched < this.lastAccepted) {
      return new Account(account.accountId(), this.lastAccepted.toString())
    }
    return account
  }

  /** Records a sequence the network actually consumed. See `consumesSequence`. */
  recordAccepted(sequence: string | bigint): void {
    const value = BigInt(sequence)
    if (this.lastAccepted === undefined || value > this.lastAccepted) this.lastAccepted = value
  }
}

/**
 * Whether a `sendTransaction` status means the network took the sequence
 * number, which is a narrower question than "did this fail".
 *
 * `PENDING` and `DUPLICATE` consumed it. `ERROR` did not, and neither does
 * `TRY_AGAIN_LATER` — that is backpressure, the transaction was never
 * accepted, and advancing on it would leave a GAP: the next refund would be
 * signed one sequence too high and be rejected until the skipped envelope
 * finally lands. Defaulting to false keeps any future status the SDK adds on
 * the safe side, since a stale sequence is retried while a gap wedges the run.
 */
export function consumesSequence(status: string): boolean {
  return status === 'PENDING' || status === 'DUPLICATE'
}

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

/**
 * `content` is a `RedactedAlert`; see `utils/alert-redaction.ts` (threat
 * `Info.1`). This signer holds its own Stellar secret key, so an alert built
 * from a caught error here is the single highest-risk disclosure path in the
 * codebase.
 */
export async function sendAlert(env: Env, content: RedactedAlert): Promise<void> {
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
  sequence: RefundSequenceGuard,
): Promise<{ prepared: Transaction; signedXdr: string; refundTx: string }> {
  const account = sequence.advance(await server.getAccount(signer.publicKey()))
  const base = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(job.payment.asset).call(
      'transfer',
      Address.fromString(signer.publicKey()).toScVal(),
      Address.fromString(job.payment.payer).toScVal(),
      nativeToScVal(amount, { type: 'i128' }),
    ))
    // Explicit minTime: the network enforces it (no ledger with an earlier
    // close time can include this tx), giving the dead-envelope recovery a
    // clock-independent lower bound for its retention check. See
    // REFUND_TX_VALIDITY_SECONDS for why maxTime is 10 minutes, not 60s.
    .setTimebounds(
      Math.floor(Date.now() / 1000) - REFUND_TX_MIN_TIME_GRACE_SECONDS,
      Math.floor(Date.now() / 1000) + REFUND_TX_VALIDITY_SECONDS,
    )
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
  sequence: RefundSequenceGuard,
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
    // Dead-envelope trigger mirrors the Router's authoritative check: a
    // closed ledger past maxTime AND retained history covering the inclusion
    // window, all from the same NOT_FOUND response — never the local clock.
    // The Router independently re-verifies before allowing the requeue.
    const ex = existing as { latestLedgerCloseTime?: number | string; oldestLedgerCloseTime?: number | string }
    const ledgerClose = BigInt(Math.floor(Number(ex.latestLedgerCloseTime ?? 0)))
    const oldestClose = BigInt(Math.floor(Number(ex.oldestLedgerCloseTime ?? 0)))
    const minTime = BigInt(tx.timeBounds?.minTime ?? '0')
    const expired = maxTime > 0n && minTime > 0n && ledgerClose > 0n && maxTime < ledgerClose &&
      oldestClose > 0n && oldestClose <= minTime
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
      return executePending(env, server, signer, requeued, beforeRouterConfirm, onRejected, sequence)
    }
    const send = await server.sendTransaction(tx)
    if (send.status === 'ERROR') {
      await parkRejected(env, job, refundTx)
      await onRejected(refundTx, String(send.errorResult ?? send.status))
      throw new Error(`submitted refund rejected and parked: ${refundTx}`)
    }
    if (consumesSequence(send.status)) sequence.recordAccepted(tx.sequence)
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
  sequence: RefundSequenceGuard,
): Promise<string> {
  const leaseId = crypto.randomUUID()
  const leased = await routerApi<{ job: RefundJob }>(env, '/admin/refunds/lease', {
    method: 'POST', body: JSON.stringify({ refundId: job.refundId, leaseId }),
  })
  assertLeasedJobMatches(job, leased.job)
  const amount = validateJob(leased.job, signer)
  const { prepared, signedXdr, refundTx } = await buildSignedRefund(server, signer, leased.job, amount, sequence)

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
  if (consumesSequence(send.status)) sequence.recordAccepted(prepared.sequence)
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
  // One guard per run: the jobs below are signed sequentially from this one
  // account, and only a same-run collision is ours to prevent (across runs the
  // network has long since caught up).
  const sequence = new RefundSequenceGuard()

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
        refundTx = await confirmSubmitted(env, server, signer, job, beforeRouterConfirm, rejectedAlert, sequence)
      } else if (job.state === 'pending' || job.state === 'leased') {
        refundTx = await executePending(env, server, signer, job, beforeRouterConfirm, rejectedAlert, sequence)
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

  await reportStuckRefunds(env, ledger)
}

export interface StuckRefund {
  refundId: string
  publicId: string
  state: string
  ageMs: number
  merchant: string
  refundAmountAtomic: string
  paymentTx: string
  orderId?: string
}

/**
 * Alerts on refunds that have gone quiet, not just on ones that were loudly
 * rejected.
 *
 * `parkRejected` was the ONLY alert on this path, so the two silent failure
 * shapes — a job that never re-enters `/admin/refunds/pending`, and one that
 * fails the same way every tick — produced no notification at all. The stuck
 * refund found on 2026-08-18 was invisible for an hour for exactly that reason.
 *
 * Deduplicated by the alert outbox's `INSERT OR IGNORE` on `stuck:<refundId>`,
 * so a refund that stays stuck across hundreds of one-minute cron ticks
 * produces exactly one message, not one per tick.
 *
 * Never throws: an alerting failure must not abort or fail a run whose actual
 * job is returning money.
 */
export async function reportStuckRefunds(env: Env, ledger: RefundLedger): Promise<void> {
  try {
    const stuck = await routerApi<{ jobs: StuckRefund[] }>(env, '/admin/refunds/stuck')
    for (const job of stuck.jobs) {
      const minutes = Math.floor(job.ageMs / 60_000)
      await ledger.enqueueAlert(
        `stuck:${job.refundId}`,
        `MPP refund still unpaid after ${minutes}m: state ${job.state}, ` +
          `$${formatUsdc(BigInt(job.refundAmountAtomic))}, merchant ${job.merchant}, ` +
          `payment tx ${job.paymentTx}` + (job.orderId ? `, order ${job.orderId}` : '') +
          (job.state === 'manual_review'
            ? '. Recover with POST /admin/refunds/unpark {"paymentTx":"<tx>"}'
            : ''),
      )
    }
  } catch (error: unknown) {
    console.error(JSON.stringify({
      event: 'refund_stuck_sweep_failed',
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}
