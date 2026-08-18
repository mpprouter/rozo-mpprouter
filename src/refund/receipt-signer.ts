/**
 * Refund receipt signing.
 *
 * Receipts are signed with **Ed25519** using a Stellar keypair, so that anybody
 * holding the signer's public `G...` address can verify a receipt without any
 * secret from us. This replaces the previous HMAC-SHA256 (`HS256`) scheme,
 * which was symmetric: only the router could verify its own receipts, so a
 * receipt proved nothing to a third party.
 *
 * The signing key is a DEDICATED key (`RECEIPT_SIGNING_SECRET`), not the router
 * pool treasury key. The treasury secret is deliberately not present in the
 * Worker at all (see `STELLAR_ROUTER_PUBLIC` in src/index.ts); a signing key
 * that can only produce receipts has no custody of funds, so exposing it in the
 * request path is bounded. Its public address is published in the receipt and
 * on `/health` as `receipt_signer`, which is what makes verification possible.
 *
 * Canonicalisation is explicit: RECEIPT_FIELD_ORDER below is the wire contract.
 * The bytes that are signed are `JSON.stringify` over exactly those keys, in
 * exactly that order, with `undefined`-valued keys omitted. Any change here is
 * a breaking change to every published verification snippet.
 */
import { Keypair } from '@stellar/stellar-sdk'

export const RECEIPT_SIGNATURE_ALGORITHM = 'Ed25519'

/** Canonicalisation identifier emitted with every receipt. */
export const RECEIPT_CANONICALIZATION = 'rozo-receipt-json-v1'

/**
 * The canonical field order. Serialisation walks this list; keys whose value is
 * `undefined` are skipped. Keys not in this list are never signed.
 */
export const RECEIPT_FIELD_ORDER = [
  'version',
  'payment_id',
  'payment_tx',
  'merchant',
  'amount',
  'mode',
  'outcome',
  'refund_tx',
  'refund_amount',
  'reason',
  'confirmed_ledger',
  'iat',
  'exp',
] as const

export type ReceiptField = typeof RECEIPT_FIELD_ORDER[number]
export type Receipt = Partial<Record<ReceiptField, unknown>>

/** Deterministic bytes-to-sign for a receipt. */
export function canonicalReceiptJson(receipt: Receipt): string {
  const ordered: Record<string, unknown> = {}
  for (const key of RECEIPT_FIELD_ORDER) {
    const value = receipt[key]
    if (value !== undefined) ordered[key] = value
  }
  return JSON.stringify(ordered)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface SignedReceipt {
  receipt: Receipt
  signature: string
  algorithm: typeof RECEIPT_SIGNATURE_ALGORITHM
  canonicalization: typeof RECEIPT_CANONICALIZATION
  signer: {
    stellar_address: string
    ed25519_public_key_hex: string
  }
}

export class ReceiptSigningUnavailable extends Error {}

/**
 * Sign a receipt with the Ed25519 key behind `secret` (a Stellar `S...` seed).
 *
 * Throws {@link ReceiptSigningUnavailable} when no key is configured, so that
 * callers fail closed rather than emitting an unsigned or self-attested
 * receipt.
 */
export function signReceipt(receipt: Receipt, secret: string | undefined): SignedReceipt {
  if (!secret) throw new ReceiptSigningUnavailable('Receipt signing key is not configured')
  let keypair: Keypair
  try {
    keypair = Keypair.fromSecret(secret)
  } catch {
    // Never echo the secret, not even a prefix of it.
    throw new ReceiptSigningUnavailable('Receipt signing key is not a valid Stellar secret seed')
  }
  const message = new TextEncoder().encode(canonicalReceiptJson(receipt))
  const signature = new Uint8Array(keypair.sign(Buffer.from(message)))
  return {
    receipt,
    signature: base64url(signature),
    algorithm: RECEIPT_SIGNATURE_ALGORITHM,
    canonicalization: RECEIPT_CANONICALIZATION,
    signer: {
      stellar_address: keypair.publicKey(),
      ed25519_public_key_hex: hex(new Uint8Array(keypair.rawPublicKey())),
    },
  }
}

/** Public address of the receipt signer, or undefined when unconfigured. */
export function receiptSignerAddress(secret: string | undefined): string | undefined {
  if (!secret) return undefined
  try {
    return Keypair.fromSecret(secret).publicKey()
  } catch {
    return undefined
  }
}
