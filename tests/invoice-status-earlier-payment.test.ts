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
})
