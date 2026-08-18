/**
 * Regression tests for the 2026-08-18 stuck refund
 * (docs/reports/refund-stuck-investigation-2026-08-18.md).
 *
 * One transient submission failure permanently stranded a customer's money:
 * a 60-second envelope expired inside the pipeline's own retry loop, every
 * re-send was rejected, and `parkRejected` moved the job to `manual_review`,
 * a state no code path could leave and no alert ever reported.
 */
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type Transaction,
} from '@stellar/stellar-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REFUND_TX_MIN_TIME_GRACE_SECONDS,
  REFUND_TX_VALIDITY_SECONDS,
  RefundSequenceGuard,
  reportStuckRefunds,
  runRefundSigner,
  type Env as SignerEnv,
  type RefundSignerRpc,
} from '../src/refund-signer-core'
import {
  completeRefund,
  enqueueRefund,
  leaseRefund,
  readRefund,
  refundIdForPaymentTx,
  unparkRefund,
  type RefundRecord,
} from '../src/refund/refund'
import { selectStuckRefunds, STUCK_REFUND_THRESHOLD_MS } from '../src/routes/refunds'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

afterEach(() => vi.restoreAllMocks())

// ── router-side store fixtures ───────────────────────────────────────────────

function routerEnv(): Env {
  return { ATOMIC_STORE: makeAtomicStoreMock() } as Env
}

function proofFor(paymentTx: string) {
  return {
    paymentId: 'challenge-1',
    paymentTx,
    payer: `G${'A'.repeat(55)}`,
    recipient: `G${'B'.repeat(55)}`,
    asset: USDC,
    amountAtomic: '10000',
    mode: 'charge' as const,
  }
}

/** Drives a fresh refund into `manual_review`, the way `parkRejected` does. */
async function parked(env: Env, paymentTx = 'a'.repeat(64)): Promise<RefundRecord> {
  const record = await enqueueRefund(env, {
    proof: proofFor(paymentTx), reason: 'non_fulfillment', merchant: 'merchant.test', routeId: 'image',
  })
  const leaseId = 'lease-1'
  await leaseRefund(env, record.refundId, leaseId)
  const submitted = await completeRefund(env, record.refundId, leaseId, {
    state: 'submitted', refundTx: 'b'.repeat(64), signedXdr: 'AAAA',
  })
  expect(submitted?.state).toBe('submitted')
  const review = await completeRefund(env, record.refundId, leaseId, {
    state: 'manual_review', refundTx: 'b'.repeat(64), signedXdr: 'AAAA',
  })
  expect(review?.state).toBe('manual_review')
  return review as RefundRecord
}

// ── P0-b: unpark ─────────────────────────────────────────────────────────────

describe('unparkRefund — manual_review is no longer terminal', () => {
  it('returns a parked refund to pending and discards its dead envelope', async () => {
    const env = routerEnv()
    const record = await parked(env)

    const outcome = await unparkRefund(env, record.refundId, 'rpc hiccup 2026-08-18')
    expect(outcome).toMatchObject({ ok: true, changed: true })

    const after = await readRefund(env, record.refundId)
    expect(after?.state).toBe('pending')
    // The stale envelope and lease must be gone: the pending path has to sign
    // a fresh transaction, not re-send one that can only ever be txTooLate.
    expect(after?.refundTx).toBeUndefined()
    expect(after?.signedXdr).toBeUndefined()
    expect(after?.lease).toBeUndefined()
    expect(after?.events).toEqual([
      expect.objectContaining({
        kind: 'admin_unpark',
        detail: expect.objectContaining({ from: 'manual_review', reason: 'rpc hiccup 2026-08-18' }),
      }),
    ])
  })

  it('is idempotent: a repeated call is a no-op, not a second audit event', async () => {
    const env = routerEnv()
    const record = await parked(env)

    const first = await unparkRefund(env, record.refundId)
    const second = await unparkRefund(env, record.refundId)

    expect(first).toMatchObject({ ok: true, changed: true })
    expect(second).toMatchObject({ ok: true, changed: false })
    expect((await readRefund(env, record.refundId))?.events).toHaveLength(1)
  })

  it('refuses every transition except manual_review -> pending', async () => {
    const env = routerEnv()

    // confirmed: unparking would re-send money that already went back.
    const done = await enqueueRefund(env, {
      proof: proofFor('c'.repeat(64)), reason: 'non_fulfillment', merchant: 'm', routeId: 'r',
    })
    await leaseRefund(env, done.refundId, 'l')
    await completeRefund(env, done.refundId, 'l', { state: 'submitted', refundTx: 'd'.repeat(64), signedXdr: 'AAAA' })
    await completeRefund(env, done.refundId, 'l', { state: 'confirmed', refundTx: 'd'.repeat(64), confirmedLedger: 9 })
    expect(await unparkRefund(env, done.refundId)).toEqual({ ok: false, error: 'invalid_state', state: 'confirmed' })

    // submitted / leased belong to a live executor lease; recovery there is
    // requeue-malformed, which proves the envelope is dead first.
    const live = await enqueueRefund(env, {
      proof: proofFor('e'.repeat(64)), reason: 'non_fulfillment', merchant: 'm', routeId: 'r',
    })
    await leaseRefund(env, live.refundId, 'l')
    expect(await unparkRefund(env, live.refundId)).toEqual({ ok: false, error: 'invalid_state', state: 'leased' })
    await completeRefund(env, live.refundId, 'l', { state: 'submitted', refundTx: 'f'.repeat(64), signedXdr: 'AAAA' })
    expect(await unparkRefund(env, live.refundId)).toEqual({ ok: false, error: 'invalid_state', state: 'submitted' })
  })

  it('reports a missing refund rather than inventing one', async () => {
    expect(await unparkRefund(routerEnv(), 'f'.repeat(64))).toEqual({ ok: false, error: 'not_found' })
  })

  it('is addressable by the payment hash printed on the public ledger row', async () => {
    const env = routerEnv()
    const paymentTx = 'a'.repeat(64)
    const record = await parked(env, paymentTx)
    expect(await refundIdForPaymentTx(paymentTx)).toBe(record.refundId)
  })
})

// ── P1: stuck-refund alerting ────────────────────────────────────────────────

describe('selectStuckRefunds', () => {
  const now = Date.parse('2026-08-18T11:00:00.000Z')
  function record(over: Partial<RefundRecord>): RefundRecord {
    return {
      version: 1, refundId: 'r1', publicId: 'p1', state: 'pending', reason: 'non_fulfillment',
      payment: proofFor('a'.repeat(64)), merchant: 'm', routeId: 'r',
      refundAmountAtomic: '10000', createdAt: new Date(now - 30 * 60_000).toISOString(),
      ...over,
    } as RefundRecord
  }

  it('flags any unconfirmed refund older than ten minutes, parked ones included', () => {
    const stuck = selectStuckRefunds([
      record({ refundId: 'parked', state: 'manual_review' }),
      record({ refundId: 'submitted', state: 'submitted' }),
      record({ refundId: 'pending', state: 'pending' }),
    ], now)
    expect(stuck.map((job) => job.refundId).sort()).toEqual(['parked', 'pending', 'submitted'])
    expect(stuck[0].ageMs).toBe(30 * 60_000)
  })

  it('ignores confirmed refunds and refunds still inside the window', () => {
    expect(selectStuckRefunds([
      record({ refundId: 'done', state: 'confirmed' }),
      record({ refundId: 'young', createdAt: new Date(now - 60_000).toISOString() }),
    ], now)).toEqual([])
  })

  it('uses a ten-minute default threshold', () => {
    const justUnder = record({ createdAt: new Date(now - STUCK_REFUND_THRESHOLD_MS + 1).toISOString() })
    const justOver = record({ createdAt: new Date(now - STUCK_REFUND_THRESHOLD_MS).toISOString() })
    expect(selectStuckRefunds([justUnder], now)).toEqual([])
    expect(selectStuckRefunds([justOver], now)).toHaveLength(1)
  })
})

describe('reportStuckRefunds', () => {
  const signerEnv: SignerEnv = {
    ROUTER_URL: 'https://router.test', STELLAR_RPC_URL: 'https://rpc.test',
    AUTO_REFUND_MAX_ATOMIC: '1000000000', REFUND_ALERT_THRESHOLD_ATOMIC: '100000000',
    ROUTER_SIGNING_SECRET: Keypair.random().secret(), REFUND_EXECUTOR_TOKEN: 't',
    DINGTALK_ACCESS_TOKEN: 'a',
  }

  function outbox() {
    const sent = new Map<string, string>()
    return {
      sent,
      ledger: {
        reserve: vi.fn(async () => undefined),
        markConfirmed: vi.fn(async () => undefined),
        // Mirrors the coordinator's INSERT OR IGNORE: first write per key wins.
        enqueueAlert: vi.fn(async (key: string, content: string) => {
          if (!sent.has(key)) sent.set(key, content)
        }),
      },
    }
  }

  it('alerts once per stuck refund no matter how many cron ticks it stays stuck', async () => {
    const job = {
      refundId: 'r1', publicId: 'p1', state: 'manual_review', ageMs: 62 * 60_000,
      merchant: 'merchant.test', refundAmountAtomic: '10000',
      paymentTx: 'ef7984cd' + 'b'.repeat(56), orderId: 'ord_test',
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jobs: [job] })))
    const { sent, ledger } = outbox()

    for (let tick = 0; tick < 5; tick += 1) await reportStuckRefunds(signerEnv, ledger)

    expect([...sent.keys()]).toEqual(['stuck:r1'])
    expect(ledger.enqueueAlert).toHaveBeenCalledTimes(5)
    const content = sent.get('stuck:r1') as string
    expect(content).toContain('still unpaid after 62m')
    expect(content).toContain('state manual_review')
    expect(content).toContain('$0.001')
    expect(content).toContain(job.paymentTx)
    // The alert must carry its own remedy — the operator reads it on a phone.
    expect(content).toContain('/admin/refunds/unpark')
  })

  it('never lets an alerting failure abort the run that returns money', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const { ledger } = outbox()
    await expect(reportStuckRefunds(signerEnv, ledger)).resolves.toBeUndefined()
    expect(ledger.enqueueAlert).not.toHaveBeenCalled()
  })
})

// ── P0-c: sequence guard ─────────────────────────────────────────────────────

describe('RefundSequenceGuard', () => {
  it('advances a stale account read past the last sequence the network accepted', () => {
    const guard = new RefundSequenceGuard()
    const id = Keypair.random().publicKey()
    guard.recordAccepted('12')
    expect(guard.advance(new Account(id, '10')).sequenceNumber()).toBe('12')
  })

  it('never rewinds a fresher account read', () => {
    const guard = new RefundSequenceGuard()
    const id = Keypair.random().publicKey()
    guard.recordAccepted('12')
    expect(guard.advance(new Account(id, '20')).sequenceNumber()).toBe('20')
  })

  it('leaves the sequence untouched until something is accepted', () => {
    const id = Keypair.random().publicKey()
    expect(new RefundSequenceGuard().advance(new Account(id, '7')).sequenceNumber()).toBe('7')
  })
})

// ── end-to-end signer behaviour: time bounds + back-to-back sequences ────────

function paymentEnvelope(payer: string, recipient: string, amount: string): Transaction {
  return new TransactionBuilder(new Account(payer, '1'), { fee: '100', networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(USDC).call(
      'transfer',
      Address.fromString(payer).toScVal(),
      Address.fromString(recipient).toScVal(),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
    ))
    .setTimeout(30)
    .build()
}

/**
 * A signer harness whose `getAccount` is deliberately STALE — it always
 * reports the same sequence, exactly as an RPC that has not yet observed the
 * transaction submitted a moment earlier. This is the shape that killed the
 * second of two back-to-back refunds.
 */
function signerHarness(signer: Keypair, amounts: string[]) {
  const jobs = amounts.map((amount, index) => {
    const payer = Keypair.random().publicKey()
    const payment = paymentEnvelope(payer, signer.publicKey(), amount)
    return {
      job: {
        refundId: `refund-${index}`, publicId: `public-${index}`, state: 'pending' as const,
        refundAmountAtomic: amount, reason: 'non_fulfillment', merchant: 'merchant.test',
        payment: {
          payer, recipient: signer.publicKey(), asset: USDC,
          paymentTx: payment.hash().toString('hex'), amountAtomic: amount,
        },
      },
      payment,
    }
  })
  const byHash = new Map(jobs.map(({ payment }) => [payment.hash().toString('hex'), payment]))
  const submitted: Transaction[] = []

  const server: RefundSignerRpc = {
    getAccount: async () => new Account(signer.publicKey(), '100'),
    prepareTransaction: async (tx: Transaction) => TransactionBuilder.cloneFrom(tx, {
      fee: '100', sorobanData: new SorobanDataBuilder().build(),
    }).build(),
    sendTransaction: async (tx) => {
      submitted.push(tx as Transaction)
      return { status: 'PENDING', hash: (tx as Transaction).hash().toString('hex'), latestLedger: 1, latestLedgerCloseTime: 1 } as rpc.Api.SendTransactionResponse
    },
    getTransaction: async (hash: string) => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 123,
      envelopeXdr: (byHash.get(hash) ?? jobs[0].payment).toXDR(), resultXdr: '', resultMetaXdr: '',
    }) as rpc.Api.GetSuccessfulTransactionResponse,
  }

  const env: SignerEnv = {
    ROUTER_URL: 'https://router.test', STELLAR_RPC_URL: 'https://rpc.test',
    AUTO_REFUND_MAX_ATOMIC: '1000000000', REFUND_ALERT_THRESHOLD_ATOMIC: '100000000',
    ROUTER_SIGNING_SECRET: signer.secret(), REFUND_EXECUTOR_TOKEN: 't', DINGTALK_ACCESS_TOKEN: 'a',
  }

  const pending = jobs.map(({ job }) => job)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    if (url.pathname.endsWith('/stuck')) return Response.json({ jobs: [] })
    if (url.pathname.endsWith('/pending')) return Response.json({ jobs: pending })
    if (url.pathname.endsWith('/lease')) {
      const target = pending.find((candidate) => candidate.refundId === body?.refundId)
      return Response.json({ job: { ...target, state: 'leased', lease: { id: body?.leaseId, until: new Date().toISOString() } } })
    }
    return Response.json({ ok: true })
  }))

  const ledger = {
    reserve: vi.fn(async () => undefined),
    markConfirmed: vi.fn(async () => undefined),
    enqueueAlert: vi.fn(async () => undefined),
  }
  return { env, server, ledger, submitted }
}

describe('signed refund envelopes', () => {
  it('stays valid for ten minutes, not the 60s that expired inside our own retry loop', async () => {
    const signer = Keypair.random()
    const { env, server, ledger, submitted } = signerHarness(signer, ['10000'])
    const before = Math.floor(Date.now() / 1000)

    await runRefundSigner(env, ledger, server)

    expect(submitted).toHaveLength(1)
    const bounds = submitted[0].timeBounds as { minTime: string; maxTime: string }
    const minTime = Number(bounds.minTime)
    const maxTime = Number(bounds.maxTime)
    expect(maxTime - minTime).toBe(REFUND_TX_VALIDITY_SECONDS + REFUND_TX_MIN_TIME_GRACE_SECONDS)
    expect(REFUND_TX_VALIDITY_SECONDS).toBe(600)
    // Comfortably outside the 25s confirmation poll and the 60s cron tick that
    // together made the old 60s window unusable on the first retry.
    expect(maxTime).toBeGreaterThanOrEqual(before + REFUND_TX_VALIDITY_SECONDS)
  })

  it('gives the second back-to-back refund the next sequence, not the consumed one', async () => {
    const signer = Keypair.random()
    // getAccount is pinned at 100 for both jobs — the stale read that made
    // refund #2 collide with refund #1 and get parked on its first attempt.
    const { env, server, ledger, submitted } = signerHarness(signer, ['10000', '20000'])

    await runRefundSigner(env, ledger, server)

    expect(submitted).toHaveLength(2)
    expect(submitted[0].sequence).toBe('101')
    expect(submitted[1].sequence).toBe('102')
    expect(ledger.markConfirmed).toHaveBeenCalledTimes(2)
  })
})
