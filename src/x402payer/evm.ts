/**
 * x402 `exact` on Base: EIP-3009 TransferWithAuthorization signed by the
 * shared funder.
 *
 * Same EIP-3009 typed data the funder already signs for Coinbase checkout
 * (pay-invoice, ReceiveWithAuthorization), with primaryType switched to
 * TransferWithAuthorization because an x402 facilitator calls
 * transferWithAuthorization, not receiveWithAuthorization. Field layout,
 * validAfter = now - 600 and validBefore = now + maxTimeoutSeconds follow
 * @x402/evm's exact client (createEIP3009Payload) so a facilitator's verify
 * sees exactly what an official client would send.
 */

import { getAddress, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { BASE_MAINNET_CAIP2, type ValidatedRequirement } from './requirements'

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export const BASE_CHAIN_ID = 8453

/** Minimal signer surface (a viem LocalAccount satisfies it). */
export interface EvmTypedDataSigner {
  address: `0x${string}`
  signTypedData(args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES
    primaryType: 'TransferWithAuthorization'
    message: {
      from: `0x${string}`
      to: `0x${string}`
      value: bigint
      validAfter: bigint
      validBefore: bigint
      nonce: Hex
    }
  }): Promise<Hex>
}

export interface EvmAuthorization {
  from: `0x${string}`
  to: `0x${string}`
  value: string
  validAfter: string
  validBefore: string
  nonce: Hex
}

export function randomEvmNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** The EIP-712 request for one authorization (exported for tests). */
export function buildTransferWithAuthorizationTypedData(req: ValidatedRequirement, auth: EvmAuthorization) {
  if (req.network !== BASE_MAINNET_CAIP2) throw new Error(`not an EVM requirement: ${req.network}`)
  return {
    domain: {
      name: String(req.extra.name),
      version: String(req.extra.version),
      chainId: BASE_CHAIN_ID,
      verifyingContract: getAddress(req.asset),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  }
}

export interface EvmExactResult {
  /** x402 v2 `payload` for scheme exact on EVM. */
  payload: { authorization: EvmAuthorization; signature: Hex }
  nonce: Hex
  validBeforeUnix: number
  funder: `0x${string}`
}

export async function signEvmExact(
  signer: EvmTypedDataSigner,
  req: ValidatedRequirement,
  opts: { nowSeconds?: number; nonce?: Hex } = {},
): Promise<EvmExactResult> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const nonce = opts.nonce ?? randomEvmNonce()
  const authorization: EvmAuthorization = {
    from: getAddress(signer.address),
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: String(now - 600),
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce,
  }
  const signature = await signer.signTypedData(buildTransferWithAuthorizationTypedData(req, authorization))
  return {
    payload: { authorization, signature },
    nonce,
    validBeforeUnix: now + req.maxTimeoutSeconds,
    funder: authorization.from,
  }
}

/**
 * Funder signer from the Worker secret X402_BASE_FUNDER_PRIVATE_KEY. Refuses a
 * key that does not derive to the expected funder address, so a mis-set secret
 * fails closed instead of signing from an unknown wallet.
 */
export function evmSignerFromSecret(privateKey: string | undefined, expectedAddress: string): EvmTypedDataSigner | null {
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey.trim())) return null
  const account = privateKeyToAccount(privateKey.trim() as Hex)
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) return null
  return account as unknown as EvmTypedDataSigner
}
