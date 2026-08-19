/**
 * The settled-but-undelivered leg of the order ledger (2026-08-18).
 *
 * Until this change `recordOrder` was only ever reached on the success path,
 * so a call the agent PAID for and did not receive left no trace in
 * GET /v1/ledger. Observed on /v1/services/anthropic/chat_completions: two
 * payments settled, the merchant leg 403'd, both were auto-refunded on chain,
 * and the public ledger showed nothing at all — while the same day's delivered
 * Mercury calls showed up fine. A settlement ledger that omits the
 * settlements that went wrong is the one case it must not omit.
 *
 * Two halves are covered here:
 *   1. the row exists with `refund_status: 'pending'` while the refund is in
 *      flight, and
 *   2. it is moved to `refunded` when the on-chain return confirms — through
 *      the real refund lifecycle (enqueue -> lease -> submitted -> confirmed),
 *      not by calling the updater directly.
 *
 * The proxy call site itself is exercised by tests/proxy.test.ts, which only
 * runs with dev vars present; what is asserted here is the contract those
 * call sites depend on.
 */

import { describe, expect, it } from 'vitest'
import type { Env } from '../src/index'
import {
  orderKey,
  recordOrder,
  updateOrderRefundStatus,
  type OrderLedgerEntry,
} from '../src/services/order-ledger'
import { toPublicRow } from '../src/routes/ledger'

/** No payer classification configured — these tests only assert `status`. */
const noLists = { internal: new Set<string>(), unresolved: new Set<string>() }
import { completeRefund, enqueueRefund, leaseRefund } from '../src/refund/refund'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

function env(): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>()
  return {
    kv,
    env: {
      ATOMIC_STORE: makeAtomicStoreMock(),
      MPP_STORE: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => { kv.set(key, value) },
        delete: async (key: string) => { kv.delete(key) },
        list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
          keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
          list_complete: true,
          cursor: '',
        }),
      } as unknown as KVNamespace,
    } as Env,
  }
}

const PAYER = `G${'A'.repeat(55)}`
const TX = 'a'.repeat(64)

const proof = {
  paymentId: 'challenge-1',
  paymentTx: TX,
  payer: PAYER,
  recipient: `G${'B'.repeat(55)}`,
  asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  amountAtomic: '500000',
  mode: 'charge' as const,
}

/** The row the proxy writes when the payment settled and the merchant leg failed. */
function failedLegEntry(overrides: Partial<OrderLedgerEntry> = {}): OrderLedgerEntry {
  return {
    order_id: 'ord_failedleg',
    ts: '2026-08-18T06:48:00.000Z',
    route_id: 'anthropic_chat_completions',
    payer: PAYER,
    amount_usd: '0.05',
    settlement_ref: TX,
    request_path: '/v1/chat/completions',
    upstream_status: 403,
    latency_ms: 0,
    refund_status: 'pending',
    ...overrides,
  }
}

describe('settled-but-undelivered calls are in the ledger', () => {
  it('records a paid call whose merchant leg failed, with the merchant status and a pending refund', async () => {
    const { env: e, kv } = env()
    await recordOrder(e, failedLegEntry())

    const stored = JSON.parse(kv.get(orderKey('ord_failedleg'))!) as OrderLedgerEntry
    // The upstream status is the MERCHANT's (403), not the 502 the router
    // handed the caller — the ledger reports what the upstream did.
    expect(stored.upstream_status).toBe(403)
    expect(stored.refund_status).toBe('pending')
    // Reachable by settlement tx, same as a delivered call.
    expect(kv.get(`mercury_order_tx:${TX}`)).toBe('ord_failedleg')
  })

  it('shows the failed leg publicly as refund_pending, not as a delivered call', () => {
    const row = toPublicRow(failedLegEntry(), noLists)
    expect(row.status).toBe('refund_pending')
    expect(row.upstream_status).toBe(403)
    expect(row.settlement_tx).toBe(TX)
  })

  it('distinguishes a queued refund from one nobody committed to', () => {
    expect(toPublicRow(failedLegEntry({ refund_status: 'unknown' }), noLists).status)
      .toBe('refund_unknown')
    expect(toPublicRow(failedLegEntry({ refund_status: 'refunded' }), noLists).status)
      .toBe('refunded')
  })
})

describe('refund confirmation writes back to the order row', () => {
  it('moves the row from refund_pending to refunded when the return confirms on chain', async () => {
    const { env: e, kv } = env()
    await recordOrder(e, failedLegEntry())

    const refund = await enqueueRefund(e, {
      proof,
      reason: 'non_fulfillment',
      merchant: 'anthropic.merchant.test',
      routeId: 'anthropic_chat_completions',
      orderId: 'ord_failedleg',
    })
    expect(refund.orderId).toBe('ord_failedleg')

    await leaseRefund(e, refund.refundId, 'lease-1')
    await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'submitted',
      refundTx: 'b'.repeat(64),
      signedXdr: 'AAAA',
    })
    // Still pending: a submitted tx is not an included one.
    expect(JSON.parse(kv.get(orderKey('ord_failedleg'))!).refund_status).toBe('pending')

    await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'confirmed',
      refundTx: 'b'.repeat(64),
      confirmedLedger: 42,
    })
    const after = JSON.parse(kv.get(orderKey('ord_failedleg'))!) as OrderLedgerEntry
    expect(after.refund_status).toBe('refunded')
    expect(toPublicRow(after, noLists).status).toBe('refunded')
    // Nothing else about the row is rewritten.
    expect(after.settlement_ref).toBe(TX)
    expect(after.upstream_status).toBe(403)
  })

  it('leaves the row alone when the refund needs manual review', async () => {
    const { env: e, kv } = env()
    await recordOrder(e, failedLegEntry())
    const refund = await enqueueRefund(e, {
      proof,
      reason: 'timeout',
      merchant: 'anthropic.merchant.test',
      routeId: 'anthropic_chat_completions',
      orderId: 'ord_failedleg',
    })
    await leaseRefund(e, refund.refundId, 'lease-1')
    await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'submitted',
      refundTx: 'c'.repeat(64),
      signedXdr: 'AAAA',
    })
    await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'manual_review',
      refundTx: 'c'.repeat(64),
      signedXdr: 'AAAA',
    })
    expect(JSON.parse(kv.get(orderKey('ord_failedleg'))!).refund_status).toBe('pending')
  })

  it('a refund with no order row (or an expired one) fails the write-back without failing the refund', async () => {
    const { env: e } = env()
    const refund = await enqueueRefund(e, {
      proof,
      reason: 'non_fulfillment',
      merchant: 'anthropic.merchant.test',
      routeId: 'anthropic_chat_completions',
      orderId: 'ord_never_written',
    })
    await leaseRefund(e, refund.refundId, 'lease-1')
    await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'submitted',
      refundTx: 'd'.repeat(64),
      signedXdr: 'AAAA',
    })
    const confirmed = await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'confirmed',
      refundTx: 'd'.repeat(64),
      confirmedLedger: 7,
    })
    // The refund record — the source of truth for whether money went back —
    // still confirms.
    expect(confirmed?.state).toBe('confirmed')
    expect(await updateOrderRefundStatus(e, 'ord_never_written', 'refunded')).toBe(false)
  })

  it('refunds enqueued without an order id (pre-2026-08-18 records) still confirm', async () => {
    const { env: e } = env()
    const refund = await enqueueRefund(e, {
      proof,
      reason: 'non_fulfillment',
      merchant: 'anthropic.merchant.test',
      routeId: 'anthropic_chat_completions',
    })
    expect(refund.orderId).toBeUndefined()
    await leaseRefund(e, refund.refundId, 'lease-1')
    await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'submitted',
      refundTx: 'e'.repeat(64),
      signedXdr: 'AAAA',
    })
    const confirmed = await completeRefund(e, refund.refundId, 'lease-1', {
      state: 'confirmed',
      refundTx: 'e'.repeat(64),
      confirmedLedger: 9,
    })
    expect(confirmed?.state).toBe('confirmed')
  })
})
