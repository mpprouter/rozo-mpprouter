import { describe, expect, it } from 'vitest'
import { pickRozoCallerSafe } from '../src/routes/webhook'

describe('invoice-status rozoPayment.earlierPayment', () => {
  it('relays the Rozo earlierPayment flag (booleans + chain only)', () => {
    const out: any = pickRozoCallerSafe({
      id: 'x', status: 'payment_unpaid',
      earlierPayment: { detected: true, chainId: '56', chainName: 'BNB Chain', extra: 'dropped' },
    })
    expect(out.earlierPayment).toEqual({ detected: true, chainId: '56', chainName: 'BNB Chain' })
  })
  it('omits it when Rozo does not send it (older deploys)', () => {
    const out: any = pickRozoCallerSafe({ id: 'x', status: 'payment_unpaid' })
    expect(out.earlierPayment).toBeUndefined()
  })
  it('relays confirming only when it is strictly true', () => {
    const out: any = pickRozoCallerSafe({
      id: 'x', status: 'payment_unpaid',
      earlierPayment: { detected: true, chainId: '56', chainName: 'BNB Chain', confirming: true },
    })
    expect(out.earlierPayment).toEqual({ detected: true, chainId: '56', chainName: 'BNB Chain', confirming: true })
  })
  it.each([
    ['absent', undefined],
    ['false', false],
    ['string "true"', 'true'],
    ['number 1', 1],
  ])('omits confirming when it is %s, output byte-identical to before', (_label, value) => {
    const base = { detected: true, chainId: '56', chainName: 'BNB Chain' }
    const withValue = value === undefined ? base : { ...base, confirming: value }
    const out: any = pickRozoCallerSafe({ id: 'x', status: 'payment_unpaid', earlierPayment: withValue })
    const ref: any = pickRozoCallerSafe({ id: 'x', status: 'payment_unpaid', earlierPayment: base })
    expect('confirming' in out.earlierPayment).toBe(false)
    expect(JSON.stringify(out)).toBe(JSON.stringify(ref))
    expect(JSON.stringify(out.earlierPayment)).toBe('{"detected":true,"chainId":"56","chainName":"BNB Chain"}')
  })
})
