/**
 * x402 `exact` on Solana mainnet: a partially signed SPL TransferChecked
 * transaction whose fee payer is the facilitator named in
 * `accepts.extra.feePayer`. Built by @x402/svm's own ExactSvmScheme client so
 * the transaction layout (compute budget, TransferChecked, memo nonce) is the
 * reference one; we only add the checks around it.
 *
 * The funder signs as token authority only. It must never be the fee payer:
 * a challenge that names our funder as feePayer is refused, otherwise the
 * facilitator could make us pay its fees.
 */

import {
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getTransactionDecoder,
  type TransactionSigner,
} from '@solana/kit'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import { SOLANA_MAINNET_CAIP2, type ValidatedRequirement } from './requirements'

export type SolanaPayloadBuilder = (
  signer: TransactionSigner,
  req: ValidatedRequirement,
) => Promise<{ transaction: string }>

/** Default builder: the official @x402/svm exact client. Needs an RPC (mint + blockhash). */
export function x402SvmPayloadBuilder(rpcUrl?: string): SolanaPayloadBuilder {
  return async (signer, req) => {
    const scheme = new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined)
    const result = await scheme.createPaymentPayload(2, {
      scheme: req.scheme,
      network: req.network,
      asset: req.asset,
      amount: req.amount,
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: req.extra,
    } as any)
    const tx = (result.payload as { transaction?: unknown }).transaction
    if (typeof tx !== 'string') throw new Error('svm payload has no transaction')
    return { transaction: tx }
  }
}

export interface SvmExactResult {
  /** x402 v2 `payload` for scheme exact on SVM. */
  payload: { transaction: string }
  /** Funder's signature on the transaction, base58: unique per transaction. */
  nonce: string
  funder: string
}

export class SvmSignError extends Error {}

export async function signSolanaExact(
  signer: TransactionSigner,
  req: ValidatedRequirement,
  build: SolanaPayloadBuilder,
): Promise<SvmExactResult> {
  if (req.network !== SOLANA_MAINNET_CAIP2) throw new SvmSignError(`not a Solana requirement: ${req.network}`)
  const funder = String(signer.address)
  const feePayer = String(req.extra.feePayer ?? '')
  if (!feePayer) throw new SvmSignError('extra.feePayer missing')
  if (feePayer === funder) throw new SvmSignError('facilitator feePayer must not be the funder')
  if (req.payTo === funder) throw new SvmSignError('payTo must not be the funder')

  const { transaction } = await build(signer, req)

  // Decode and check what we are handing out: fee payer is the facilitator
  // and still unsigned; the funder has signed.
  const bytes = getBase64Encoder().encode(transaction)
  const decoded = getTransactionDecoder().decode(bytes)
  const signers = Object.keys(decoded.signatures)
  if (signers[0] !== feePayer) throw new SvmSignError('transaction fee payer is not the facilitator')
  if (decoded.signatures[feePayer as keyof typeof decoded.signatures] !== null) {
    throw new SvmSignError('fee payer slot is already signed')
  }
  const funderSig = decoded.signatures[funder as keyof typeof decoded.signatures]
  if (!funderSig) throw new SvmSignError('funder signature missing from transaction')

  return {
    payload: { transaction },
    nonce: getBase58Decoder().decode(funderSig as Uint8Array),
    funder,
  }
}

/** Random shadow-mode nonce shaped like a base58 signature. */
export function randomSvmNonce(): string {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)))
}

/**
 * Funder signer from the Worker secret X402_SOLANA_FUNDER_SECRET_KEY (base58
 * 64-byte keypair, or a JSON byte array). Refuses a key that does not derive
 * to X402_SOLANA_FUNDER_ADDRESS.
 */
export async function svmSignerFromSecret(
  secret: string | undefined,
  expectedAddress: string | undefined,
): Promise<TransactionSigner | null> {
  if (!secret || !expectedAddress) return null
  let bytes: Uint8Array
  try {
    const s = secret.trim()
    bytes = s.startsWith('[')
      ? Uint8Array.from(JSON.parse(s) as number[])
      : new Uint8Array(getBase58Encoder().encode(s))
  } catch {
    return null
  }
  if (bytes.length !== 64) return null
  try {
    const signer = await createKeyPairSignerFromBytes(bytes)
    return String(signer.address) === expectedAddress.trim() ? signer : null
  } catch {
    return null
  } finally {
    bytes.fill(0)
  }
}
