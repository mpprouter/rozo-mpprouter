import {
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  type Transaction,
} from '@stellar/stellar-sdk'
import type { RefundRecord } from './refund'

function networkPassphrase(network: string): string {
  if (network === 'stellar:pubnet') return Networks.PUBLIC
  if (network === 'stellar:testnet') return Networks.TESTNET
  throw new Error(`Unsupported Stellar network: ${network}`)
}

export function validateSignedRefundXdr(record: RefundRecord, signedXdr: string, network: string): string {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase(network)) as Transaction
  if (tx.operations.length !== 1) throw new Error('Refund transaction must contain exactly one operation')
  const op = tx.operations[0]
  if (op.type !== 'invokeHostFunction') throw new Error('Refund transaction must invoke the SAC')
  const fn = op.func
  if (fn.switch().name !== 'hostFunctionTypeInvokeContract') throw new Error('Refund host function must invoke a contract')
  const invocation = fn.invokeContract()
  const address = invocation.contractAddress()
  if (address.switch().name !== 'scAddressTypeContract') throw new Error('Refund target must be a contract')
  const contract = StrKey.encodeContract(Buffer.from(address.contractId() as unknown as Uint8Array))
  if (contract !== record.payment.asset) throw new Error('Refund asset does not match payment asset')
  if (invocation.functionName().toString() !== 'transfer') throw new Error('Refund function must be transfer')
  const values = invocation.args().map((value) => scValToNative(value))
  if (String(values[0]) !== record.payment.recipient) throw new Error('Refund source does not match original recipient')
  if (String(values[1]) !== record.payment.payer) throw new Error('Refund destination does not match original payer')
  if (BigInt(values[2]) !== BigInt(record.refundAmountAtomic)) throw new Error('Refund amount mismatch')
  if (tx.source !== record.payment.recipient) throw new Error('Envelope source does not match original recipient')
  return tx.hash().toString('hex')
}

export function hasSorobanTransactionData(signedXdr: string, network: string): boolean {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase(network)) as Transaction
  return tx.toEnvelope().v1().tx().ext().switch() === 1
}

export async function verifyConfirmedRefund(
  record: RefundRecord,
  signedXdr: string,
  network: string,
  rpcUrl: string,
): Promise<{ txHash: string; ledger: number }> {
  const txHash = validateSignedRefundXdr(record, signedXdr, network)
  const result = await new rpc.Server(rpcUrl).getTransaction(txHash)
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Refund transaction is not confirmed: ${result.status}`)
  }
  return { txHash, ledger: result.ledger }
}

/**
 * An envelope is definitively expired only when a CLOSED ledger's close time
 * is past its maxTime — wall-clock comparison is unsafe (a fast local clock
 * would let a still-includable envelope be replaced, opening a double-refund
 * window). Pass the latestLedgerCloseTime observed from the same RPC response
 * that reported the transaction NOT_FOUND.
 */
export function isExpiredEnvelope(signedXdr: string, network: string, ledgerCloseTimeSecs: number): boolean {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase(network)) as Transaction
  const maxTime = BigInt(tx.timeBounds?.maxTime ?? '0')
  return maxTime > 0n && ledgerCloseTimeSecs > 0 && maxTime < BigInt(ledgerCloseTimeSecs)
}
