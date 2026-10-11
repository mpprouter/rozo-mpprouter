import { describe, expect, it } from 'vitest'
import { pickRozoCallerSafe } from '../src/routes/webhook'

const base = {
  direction: 'underpay',
  expectedAmount: '19.09',
  receivedAmount: '17.323892',
  remainingAmount: '1.766108',
  excessAmount: '0',
  currency: 'USDT',
  detectedAt: '2026-10-11T01:50:00.000Z',
  updatedAt: '2026-10-11T01:52:00.000Z',
  reviewed: false,
  canTopUp: true,
  topUpBlockedReason: 'order_expired',
}

describe('invoice-status rozoPayment.amountMismatch', () => {
  it('relays the whitelisted fields and drops unknown keys', () => {
    const out: any = pickRozoCallerSafe({
      id: 'x', status: 'payment_unpaid',
      amountMismatch: { ...base, sender_address: '0xabc', match_type: 'standard', review: { by: 'ops' } },
    })
    expect(out.amountMismatch).toEqual(base)
  })

  it('omits canTopUp when it is not a boolean (checkout treats absent as false)', () => {
    const { canTopUp: _c, ...rest } = base
    let out: any = pickRozoCallerSafe({ id: 'x', amountMismatch: rest })
    expect('canTopUp' in out.amountMismatch).toBe(false)
    out = pickRozoCallerSafe({ id: 'x', amountMismatch: { ...base, canTopUp: 'true' } })
    expect('canTopUp' in out.amountMismatch).toBe(false)
  })

  it('treats a missing or non-boolean reviewed as reviewed (fail closed)', () => {
    const out: any = pickRozoCallerSafe({ id: 'x', amountMismatch: { ...base, reviewed: undefined } })
    expect(out.amountMismatch.reviewed).toBe(true)
  })

  it('drops the whole object when amounts or currency are not plain values', () => {
    for (const bad of [
      { receivedAmount: '<img src=x onerror=alert(1)>' },
      { expectedAmount: 19.09 },
      { currency: 'USDT<script>' },
      { direction: 'sideways' },
    ]) {
      const out: any = pickRozoCallerSafe({ id: 'x', amountMismatch: { ...base, ...bad } })
      expect(out.amountMismatch).toBeUndefined()
    }
  })

  it('nulls a malformed optional amount or timestamp and drops a bad reason', () => {
    const out: any = pickRozoCallerSafe({
      id: 'x',
      amountMismatch: { ...base, remainingAmount: '1e3', updatedAt: 'soon', topUpBlockedReason: 'A B<' },
    })
    expect(out.amountMismatch.remainingAmount).toBeNull()
    expect(out.amountMismatch.updatedAt).toBeNull()
    expect(out.amountMismatch.topUpBlockedReason).toBeUndefined()
  })

  it('omits it when Rozo does not send it (older deploys)', () => {
    const out: any = pickRozoCallerSafe({ id: 'x', status: 'payment_unpaid' })
    expect(out.amountMismatch).toBeUndefined()
    expect(out.paymentHold).toBeUndefined()
  })
})

describe('invoice-status rozoPayment.paymentHold', () => {
  it('relays only the kind', () => {
    const out: any = pickRozoCallerSafe({
      id: 'x', paymentHold: { kind: 'mixed_tokens', amounts: { USDC: '1', USDT: '2' } },
    })
    expect(out.paymentHold).toEqual({ kind: 'mixed_tokens' })
  })
  it('drops a malformed kind', () => {
    const out: any = pickRozoCallerSafe({ id: 'x', paymentHold: { kind: '<b>' } })
    expect(out.paymentHold).toBeUndefined()
  })
})
