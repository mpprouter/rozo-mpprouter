/**
 * Payer attribution out of the agent's signed x402 XDR
 * (extractPayerFromXdr in src/mpp/stellar-x402-server.ts).
 *
 * The property under test is not "can we parse XDR" — the SDK does that.
 * It is: when the account that pays the NETWORK FEE differs from the
 * account that pays the INVOICE, we must report the latter. This router
 * runs a published gas sponsor, so that divergence is a normal operating
 * state, not a hypothetical. Attributing rows to a sponsor would collapse
 * many distinct agents onto one address and silently deflate the
 * unique-payer count the SCF #44 floors are measured against.
 */

import { describe, it, expect } from 'vitest'
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { extractPayerFromXdr } from '../src/mpp/stellar-x402-server'

const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

/** Build a signed SAC `transfer(from, to, amount)` invocation. */
function transferTx(opts: {
  envelopeSource: Keypair
  from: string
  to: string
}): string {
  const account = new Account(opts.envelopeSource.publicKey(), '1')
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(USDC_SAC).toScAddress(),
        functionName: 'transfer',
        args: [
          new Address(opts.from).toScVal(),
          new Address(opts.to).toScVal(),
          nativeToScVal(10000n, { type: 'i128' }),
        ],
      }),
    ),
    auth: [],
  })
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
  tx.sign(opts.envelopeSource)
  return tx.toXDR()
}

describe('extractPayerFromXdr', () => {
  const agent = Keypair.random()
  const sponsor = Keypair.random()
  const routerPool = Keypair.random()

  it('returns the transfer `from` account, not the envelope source, when a sponsor pays the fee', () => {
    const xdrString = transferTx({
      envelopeSource: sponsor,
      from: agent.publicKey(),
      to: routerPool.publicKey(),
    })
    const payer = extractPayerFromXdr(xdrString, 'stellar:pubnet')
    expect(payer).toBe(agent.publicKey())
    // The regression this guards: reading tx.source would return the sponsor.
    expect(payer).not.toBe(sponsor.publicKey())
  })

  it('agrees with the envelope source in the ordinary self-paid case', () => {
    const xdrString = transferTx({
      envelopeSource: agent,
      from: agent.publicKey(),
      to: routerPool.publicKey(),
    })
    expect(extractPayerFromXdr(xdrString, 'stellar:pubnet')).toBe(agent.publicKey())
  })

  it('returns null rather than throwing on garbage, so a payment never fails over attribution', () => {
    expect(extractPayerFromXdr('not-xdr-at-all', 'stellar:pubnet')).toBeNull()
    expect(extractPayerFromXdr('', 'stellar:pubnet')).toBeNull()
    // Valid XDR, wrong network passphrase -> signature/parse mismatch -> null.
    const xdrString = transferTx({
      envelopeSource: agent,
      from: agent.publicKey(),
      to: routerPool.publicKey(),
    })
    expect(extractPayerFromXdr(xdrString, 'stellar:unknown-net')).toBeNull()
  })

  it('falls back to the envelope source when the tx carries no transfer invocation', () => {
    const account = new Account(agent.publicKey(), '1')
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.payment({
          destination: routerPool.publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build()
    tx.sign(agent)
    expect(extractPayerFromXdr(tx.toXDR(), 'stellar:pubnet')).toBe(agent.publicKey())
  })
})
