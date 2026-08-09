import { describe, expect, it } from 'vitest'
import { Store } from 'mppx/server'
import type { Env } from '../src/index'
import { completeRefund, enqueueRefund, leaseRefund, readRefund, refundAmountAtomic } from '../src/refund/refund'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { doAtomicParams } from '../src/mpp/kv-atomic-store'
import {
  acquireChannelDeliveryLock,
  releaseChannelDeliveryLock,
  rollbackFailedChannelVoucher,
} from '../src/mpp/stellar-channel-dispatch'
import { finishAsyncDelivery, type JobAuthRecord } from '../src/routes/job-status'

function env(): Env {
  const kv = new Map<string, string>()
  return {
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value) },
      delete: async (key: string) => { kv.delete(key) },
      list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
        keys: [...kv.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cursor: '',
      }),
    } as unknown as KVNamespace,
  } as Env
}

const proof = {
  paymentId: 'challenge-1',
  paymentTx: 'a'.repeat(64),
  payer: `G${'A'.repeat(55)}`,
  recipient: `G${'B'.repeat(55)}`,
  asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  amountAtomic: '500000',
  mode: 'charge' as const,
}

describe('refund D2 minimum rules', () => {
  it('TC1 geo/non-fulfillment refunds the full charge and deduplicates detection', async () => {
    const e = env()
    const [a, b] = await Promise.all([
      enqueueRefund(e, { proof, reason: 'non_fulfillment', merchant: 'merchant.test', routeId: 'image' }),
      enqueueRefund(e, { proof, reason: 'non_fulfillment', merchant: 'merchant.test', routeId: 'image' }),
    ])
    expect(a.refundId).toBe(b.refundId)
    expect(a.refundAmountAtomic).toBe('500000')
    expect((await readRefund(e, a.refundId))?.state).toBe('pending')
  })

  it('TC2 session refunds only the undelivered channel remainder', () => {
    expect(refundAmountAtomic({ mode: 'channel', paidAtomic: 20_000_000n, deliveredAtomic: 6_000_000n }))
      .toBe(14_000_000n)
    expect(refundAmountAtomic({ mode: 'channel', paidAtomic: 6n, deliveredAtomic: 6n })).toBe(0n)
  })

  it('TC2 failed channel voucher restores the prior cumulative and is retryable', async () => {
    const e = env()
    const store = Store.cloudflare(doAtomicParams(e.ATOMIC_STORE)) as any
    const channel = `C${'A'.repeat(55)}`
    await store.put(`stellar:channel:cumulative:${channel}`, { amount: '20000000' })
    await store.put('stellar:channel:challenge:challenge-failed', { state: 'settled' })
    expect(await rollbackFailedChannelVoucher(e, channel, '20000000', '6000000', 'challenge-failed'))
      .toBe(true)
    expect(await store.get(`stellar:channel:cumulative:${channel}`)).toEqual({ amount: '6000000' })
    expect(await store.get('stellar:channel:challenge:challenge-failed')).toBeNull()
  })

  it('TC2 rollback never overwrites a later successful voucher', async () => {
    const e = env()
    const store = Store.cloudflare(doAtomicParams(e.ATOMIC_STORE)) as any
    const channel = `C${'B'.repeat(55)}`
    await store.put(`stellar:channel:cumulative:${channel}`, { amount: '21000000' })
    expect(await rollbackFailedChannelVoucher(e, channel, '20000000', '6000000', 'old-challenge'))
      .toBe(false)
    expect(await store.get(`stellar:channel:cumulative:${channel}`)).toEqual({ amount: '21000000' })
  })

  it('TC2 serializes verify through delivery outcome per channel', async () => {
    const e = env()
    const channel = `C${'C'.repeat(55)}`
    expect(await acquireChannelDeliveryLock(e, channel, 'request-a')).toBe(true)
    expect(await acquireChannelDeliveryLock(e, channel, 'request-b')).toBe(false)
    await releaseChannelDeliveryLock(e, channel, 'request-a')
    expect(await acquireChannelDeliveryLock(e, channel, 'request-b')).toBe(true)
  })

  it.each(['timeout', 'upstream_5xx', 'empty_response'] as const)(
    'TC3 %s refunds the full charge and only one executor wins the lease',
    async (reason) => {
      const e = env()
      const job = await enqueueRefund(e, {
        proof: { ...proof, paymentTx: reason.padEnd(64, 'a') },
        reason,
        merchant: 'merchant.test',
        routeId: 'model',
      })
      // The production Durable Object serializes these calls. The lightweight
      // in-process mock does not emulate an input gate, so invoke sequentially
      // while still asserting the persisted CAS outcome.
      const leases = [
        await leaseRefund(e, job.refundId, 'executor-a'),
        await leaseRefund(e, job.refundId, 'executor-b'),
      ]
      expect(leases.filter(Boolean)).toHaveLength(1)
      expect(job.refundAmountAtomic).toBe(proof.amountAtomic)
    },
  )

  it('never allows a submitted signed transaction to be replaced', async () => {
    const e = env()
    const job = await enqueueRefund(e, {
      proof: { ...proof, paymentTx: 'b'.repeat(64) },
      reason: 'timeout', merchant: 'merchant.test', routeId: 'model',
    })
    await leaseRefund(e, job.refundId, 'executor-a')
    expect(await completeRefund(e, job.refundId, 'executor-a', {
      state: 'submitted', refundTx: 'c'.repeat(64), signedXdr: 'xdr-a',
    })).not.toBeNull()
    expect(await completeRefund(e, job.refundId, 'executor-a', {
      state: 'submitted', refundTx: 'd'.repeat(64), signedXdr: 'xdr-b',
    })).toBeNull()
    const stored = await readRefund(e, job.refundId)
    expect(stored?.refundTx).toBe('c'.repeat(64))
    expect(stored?.signedXdr).toBe('xdr-a')
  })

  it('TC2 async terminal outcome is claimed once before money side effects', async () => {
    const e = env()
    const channel = `C${'D'.repeat(55)}`
    const store = Store.cloudflare(doAtomicParams(e.ATOMIC_STORE)) as any
    await store.put(`stellar:channel:cumulative:${channel}`, { amount: '10000000' })
    await store.put('stellar:channel:challenge:async-challenge', { state: 'settled' })
    await acquireChannelDeliveryLock(e, channel, 'async-lock')
    const record: JobAuthRecord = {
      stellarAddress: proof.payer,
      serviceId: 'async-route', upstreamHost: 'merchant.test',
      upstreamJobPath: '/api/jobs/1', paidAt: new Date().toISOString(),
      channelDelivery: {
        channelContract: channel, lockId: 'async-lock', challengeId: 'async-challenge',
        acceptedAmount: '10000000', previousAmount: '6000000', action: 'voucher',
      },
    }
    expect(await finishAsyncDelivery(e, 'async-route:1', record, 'delivered')).toBe('done')
    expect(await finishAsyncDelivery(e, 'async-route:1', record, 'failed', 'upstream_5xx'))
      .toBe('conflict')
    expect(await store.get(`stellar:channel:cumulative:${channel}`)).toEqual({ amount: '10000000' })
  })
})
