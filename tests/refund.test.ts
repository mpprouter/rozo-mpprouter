import { describe, expect, it } from 'vitest'
import { decideRefund, decimalToRaw } from '../src/mpp/refund'

describe('refund policy unit coverage', () => {
  it('TC1 refunds a fresh failed channel in full', () => {
    expect(decideRefund({
      mode: 'channel', paymentSettled: true, delivered: false,
      amountRaw: '1000000', depositCapRaw: '1000000', cumulativeDeliveredRaw: '0',
    })).toEqual({ eligible: true, amountRaw: '1000000', outcome: 'refunded_full' })
  })

  it('TC2 refunds exactly the unused 7-decimal remainder', () => {
    expect(decideRefund({
      mode: 'channel', paymentSettled: true, delivered: false,
      amountRaw: '6000000', depositCapRaw: '20000000', cumulativeDeliveredRaw: '6000000',
    })).toEqual({ eligible: true, amountRaw: '14000000', outcome: 'refunded_partial' })
  })

  it.each(['100000', '900000'])('TC3 fully refunds a settled failed charge (%s)', amountRaw => {
    expect(decideRefund({ mode: 'charge', paymentSettled: true, delivered: false, amountRaw }))
      .toEqual({ eligible: true, amountRaw, outcome: 'refunded_full' })
  })

  it('never refunds an unsettled payment', () => {
    expect(decideRefund({ mode: 'charge', paymentSettled: false, delivered: false, amountRaw: '100000' }))
      .toEqual({ eligible: false, amountRaw: '0', outcome: 'rejected_no_charge' })
  })

  it('fails closed when delivered cumulative exceeds the deposit', () => {
    expect(() => decideRefund({
      mode: 'channel', paymentSettled: true, delivered: false,
      amountRaw: '1', depositCapRaw: '10', cumulativeDeliveredRaw: '11',
    })).toThrow('exceeds')
  })

  it('converts Stellar decimal amounts without floating point', () => {
    expect(decimalToRaw('2', 7)).toBe('20000000')
    expect(decimalToRaw('0.60', 7)).toBe('6000000')
    expect(decimalToRaw('1.40', 7)).toBe('14000000')
  })
})
