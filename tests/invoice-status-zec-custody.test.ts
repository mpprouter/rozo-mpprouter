import { describe, expect, it } from 'vitest'
import { pickRozoCallerSafe, pickZecCustodyStatus } from '../src/routes/webhook'

const ZEC = {
  rail: 'zec_custody',
  requiredConfirmations: 2,
  confirmations: 1,
  requiredZat: '8143000',
  receivedZat: '8143000',
  payinState: 'confirming',
  quoteExpiresAt: '2026-10-12T10:10:00.000Z',
}

const ROW = {
  id: 'p1',
  status: 'payment_unpaid',
  provider: 'rozo',
  quoteExpiresAt: '2026-10-12T10:10:00.000Z',
  refundStatus: 'sent',
  refundTxHash: 'a'.repeat(64),
  paymentHold: { kind: 'zec_late_review' },
  internalSecret: 'never',
  source: {
    chainId: '9133',
    tokenSymbol: 'ZEC',
    receiverAddress: 't1DepositAddrXXXXXXXXXXXXXXXXXXXXX',
    amount: '0.08143000',
    amountReceived: '0.08143000',
    minAcceptedAmount: '0.08143000',
    zec: { ...ZEC, extra: 'dropped' },
    receiverMemo: 'dropped',
  },
}

describe('invoice-status relays the custody ZEC fields', () => {
  it('passes provider, quoteExpiresAt, refund fields, minAcceptedAmount and source.zec', () => {
    const out: any = pickRozoCallerSafe(ROW)
    expect(out.provider).toBe('rozo')
    expect(out.quoteExpiresAt).toBe('2026-10-12T10:10:00.000Z')
    expect(out.refundStatus).toBe('sent')
    expect(out.refundTxHash).toBe('a'.repeat(64))
    expect(out.paymentHold).toEqual({ kind: 'zec_late_review' })
    expect(out.source.minAcceptedAmount).toBe('0.08143000')
    expect(out.source.zec).toEqual(ZEC)
    expect(out.internalSecret).toBeUndefined()
    expect(out.source.receiverMemo).toBeUndefined()
  })

  it('relays a confirmation count that went down after a reorg as given', () => {
    const out: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, zec: { ...ZEC, confirmations: 0, payinState: 'reorged' } } })
    expect(out.source.zec.confirmations).toBe(0)
    expect(out.source.zec.payinState).toBe('reorged')
  })

  it('drops a malformed zec block entirely', () => {
    const bad: any[] = [
      { ...ZEC, rail: 'near_direct' },
      { ...ZEC, requiredConfirmations: 3 },
      { ...ZEC, confirmations: -1 },
      { ...ZEC, confirmations: 1.5 },
      { ...ZEC, requiredZat: 8143000 },
      { ...ZEC, receivedZat: '1e8' },
      { ...ZEC, payinState: 'paid' },
      { ...ZEC, quoteExpiresAt: 'soon' },
      'x',
      null,
    ]
    for (const z of bad) {
      expect(pickZecCustodyStatus(z)).toBeNull()
      const out: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, zec: z } })
      expect(out.source.zec).toBeUndefined()
    }
  })

  it('drops unknown refund states, bad hashes, bad providers and non-decimal minAcceptedAmount', () => {
    const out: any = pickRozoCallerSafe({
      ...ROW,
      provider: '<b>near</b>',
      quoteExpiresAt: 'later',
      refundStatus: 'done',
      refundTxHash: 'not a hash',
      source: { ...ROW.source, minAcceptedAmount: '1e3' },
    })
    expect(out.provider).toBeUndefined()
    expect(out.quoteExpiresAt).toBeUndefined()
    expect(out.refundStatus).toBeUndefined()
    expect(out.refundTxHash).toBeUndefined()
    expect(out.source.minAcceptedAmount).toBeUndefined()
  })

  it('legacy near rows keep their old shape plus the new public fields', () => {
    const out: any = pickRozoCallerSafe({
      id: 'p2',
      status: 'payment_bounced',
      provider: 'near',
      refundStatus: 'pending',
      source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.1' },
    })
    expect(out.provider).toBe('near')
    expect(out.refundStatus).toBe('pending')
    expect(out.refundTxHash).toBeUndefined()
    expect(out.source.zec).toBeUndefined()
  })
})
