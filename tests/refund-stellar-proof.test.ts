import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import type { RefundRecord } from '../src/refund/refund'
import { validateSignedRefundXdr } from '../src/refund/stellar-proof'

function fixture() {
  const operator = Keypair.random()
  const payer = Keypair.random().publicKey()
  const contractId = StrKeyFixture.contract()
  const tx = new TransactionBuilder(new Account(operator.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(new Contract(contractId).call(
      'transfer',
      Address.fromString(operator.publicKey()).toScVal(),
      Address.fromString(payer).toScVal(),
      nativeToScVal(500_000n, { type: 'i128' }),
    ))
    .setTimeout(30)
    .build()
  tx.sign(operator)
  const record: RefundRecord = {
    version: 1,
    refundId: 'x',
    publicId: crypto.randomUUID(),
    state: 'leased',
    reason: 'timeout',
    merchant: 'merchant.test',
    routeId: 'route',
    refundAmountAtomic: '500000',
    createdAt: new Date().toISOString(),
    payment: {
      paymentId: 'payment', paymentTx: 'a'.repeat(64), payer,
      recipient: operator.publicKey(), asset: contractId, amountAtomic: '500000', mode: 'charge',
    },
  }
  return { record, xdr: tx.toXDR(), hash: tx.hash().toString('hex') }
}

const StrKeyFixture = {
  contract(): string {
    // Deterministic, valid contract address without relying on a live network.
    const bytes = new Uint8Array(32)
    bytes.fill(7)
    return StrKey.encodeContract(Buffer.from(bytes))
  },
}

describe('signed refund proof', () => {
  it('accepts the exact original-recipient to original-payer SAC transfer', () => {
    const { record, xdr, hash } = fixture()
    expect(validateSignedRefundXdr(record, xdr, 'stellar:pubnet')).toBe(hash)
  })

  it('rejects an amount different from the authorized refund', () => {
    const { record, xdr } = fixture()
    record.refundAmountAtomic = '500001'
    expect(() => validateSignedRefundXdr(record, xdr, 'stellar:pubnet')).toThrow('amount mismatch')
  })
})
