import { describe, it, expect } from 'vitest'
import { nextSessionCumulative, ChannelDepositExhaustedError } from '../src/mpp/tempo-client'

describe('nextSessionCumulative deposit guard', () => {
  it('returns the new cumulative when within the deposit', () => {
    expect(nextSessionCumulative('m', { cumulativeRaw: '1000', depositRaw: '1001000' }, '1000000')).toBe('1001000')
  })
  it('refuses a voucher above the deposit (dune_execute 2026-10-25 shape)', () => {
    expect(() => nextSessionCumulative('dune_execute', { cumulativeRaw: '4000000', depositRaw: '1000000' }, '50000'))
      .toThrow(ChannelDepositExhaustedError)
    expect(() => nextSessionCumulative('m', { cumulativeRaw: '0', depositRaw: '1000000' }, '1000001'))
      .toThrow(/deposit is 1000000/)
  })
  it('does not check an entry without a valid depositRaw', () => {
    expect(nextSessionCumulative('m', { cumulativeRaw: '5', depositRaw: undefined as any }, '5')).toBe('10')
    expect(nextSessionCumulative('m', { cumulativeRaw: '5', depositRaw: '' }, '5')).toBe('10')
  })
})
