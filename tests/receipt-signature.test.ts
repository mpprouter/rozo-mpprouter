/**
 * Refund receipts must be verifiable by a third party holding only the signer's
 * public Stellar address — the property HMAC-SHA256 could never provide.
 *
 * Every keypair here is generated at test time. No production secret is read,
 * printed, or committed.
 */
import { describe, expect, it } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import {
  RECEIPT_CANONICALIZATION,
  RECEIPT_FIELD_ORDER,
  ReceiptSigningUnavailable,
  canonicalReceiptJson,
  receiptSignerAddress,
  retiredReceiptSignerAddresses,
  signReceipt,
} from '../src/refund/receipt-signer'
import { handleRefundStatus } from '../src/routes/refunds'
import { completeRefund, enqueueRefund, leaseRefund } from '../src/refund/refund'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

const receipt = {
  version: 1,
  payment_id: 'challenge-1',
  payment_tx: 'a'.repeat(64),
  merchant: 'merchant.test',
  amount: '500000',
  mode: 'charge',
  outcome: 'refunded_full',
  refund_tx: 'b'.repeat(64),
  refund_amount: '500000',
  reason: 'non_fulfillment',
  confirmed_ledger: 123456,
  iat: '2026-08-18T00:00:00.000Z',
  exp: '2026-08-19T00:00:00.000Z',
}

/** Independent verifier: exactly what a reviewer would write from the doc. */
function verify(signed: ReturnType<typeof signReceipt>, address: string): boolean {
  const signature = Buffer.from(
    signed.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64',
  )
  const message = Buffer.from(canonicalReceiptJson(signed.receipt), 'utf8')
  return Keypair.fromPublicKey(address).verify(message, signature)
}

describe('refund receipt Ed25519 signatures', () => {
  it('signs with Ed25519 and advertises the signer public key', () => {
    const kp = Keypair.random()
    const signed = signReceipt(receipt, kp.secret())

    expect(signed.algorithm).toBe('Ed25519')
    expect(signed.canonicalization).toBe(RECEIPT_CANONICALIZATION)
    expect(signed.signer.stellar_address).toBe(kp.publicKey())
    // The hex form is the same key, just unwrapped from strkey.
    expect(signed.signer.ed25519_public_key_hex)
      .toBe(Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey())).toString('hex'))
    // Raw Ed25519 signatures are 64 bytes.
    expect(Buffer.from(signed.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
      .toHaveLength(64)
  })

  it('verifies against the published public address alone', () => {
    const kp = Keypair.random()
    const signed = signReceipt(receipt, kp.secret())
    expect(verify(signed, signed.signer.stellar_address)).toBe(true)
    expect(verify(signed, kp.publicKey())).toBe(true)
  })

  it('fails verification when any signed field is tampered with', () => {
    const kp = Keypair.random()
    const signed = signReceipt(receipt, kp.secret())

    for (const field of RECEIPT_FIELD_ORDER) {
      const tampered = {
        ...signed,
        receipt: { ...signed.receipt, [field]: `tampered-${String(signed.receipt[field])}` },
      }
      expect(verify(tampered, kp.publicKey()), `tampering with ${field} must be detected`)
        .toBe(false)
    }
  })

  it('fails verification against an unrelated key', () => {
    const signed = signReceipt(receipt, Keypair.random().secret())
    expect(verify(signed, Keypair.random().publicKey())).toBe(false)
  })

  it('fails verification when the signature itself is altered', () => {
    const kp = Keypair.random()
    const signed = signReceipt(receipt, kp.secret())
    const bytes = Buffer.from(signed.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    bytes[0] ^= 0xff
    const forged = {
      ...signed,
      signature: bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    }
    expect(verify(forged, kp.publicKey())).toBe(false)
  })

  it('canonicalises to a fixed field order regardless of object key order', () => {
    const shuffled = Object.fromEntries(
      [...Object.entries(receipt)].reverse(),
    ) as typeof receipt
    expect(canonicalReceiptJson(shuffled)).toBe(canonicalReceiptJson(receipt))
    // The wire contract, spelled out: verification snippets depend on it.
    expect(canonicalReceiptJson(receipt).slice(0, 40)).toBe('{"version":1,"payment_id":"challenge-1",')
  })

  it('ignores fields outside the canonical set, so they cannot smuggle meaning', () => {
    const withExtra = { ...receipt, injected: 'ignored' } as typeof receipt
    expect(canonicalReceiptJson(withExtra)).toBe(canonicalReceiptJson(receipt))
  })

  it('omits undefined optional fields rather than emitting null', () => {
    const partial = { ...receipt, confirmed_ledger: undefined }
    expect(canonicalReceiptJson(partial)).not.toContain('confirmed_ledger')
  })

  it('fails closed when no signing key is configured', () => {
    expect(() => signReceipt(receipt, undefined)).toThrow(ReceiptSigningUnavailable)
    expect(() => signReceipt(receipt, '')).toThrow(ReceiptSigningUnavailable)
    expect(receiptSignerAddress(undefined)).toBeUndefined()
  })

  it('fails closed on a malformed key without echoing it', () => {
    const bogus = 'SNOTAREALSTELLARSECRET'
    expect(() => signReceipt(receipt, bogus)).toThrow(ReceiptSigningUnavailable)
    try {
      signReceipt(receipt, bogus)
    } catch (error: any) {
      expect(error.message).not.toContain(bogus)
    }
    expect(receiptSignerAddress(bogus)).toBeUndefined()
  })
})

describe('signer key rotation', () => {
  it('keeps receipts signed by a retired key verifiable', () => {
    const retired = Keypair.random()
    const current = Keypair.random()
    // A receipt issued before the rotation.
    const old = signReceipt(receipt, retired.secret())

    const published = [
      receiptSignerAddress(current.secret()),
      ...retiredReceiptSignerAddresses(retired.publicKey()),
    ]
    // The verification procedure trusts the published set, not the receipt.
    expect(published).toContain(old.signer.stellar_address)
    expect(verify(old, old.signer.stellar_address)).toBe(true)
  })

  it('parses a comma-separated list and drops malformed entries', () => {
    const a = Keypair.random().publicKey()
    const b = Keypair.random().publicKey()
    expect(retiredReceiptSignerAddresses(` ${a} , ${b} `)).toEqual([a, b])
    // A typo must not throw and take /health down with it.
    expect(retiredReceiptSignerAddresses(`${a},,not-an-address,GARBAGE`)).toEqual([a])
    expect(retiredReceiptSignerAddresses(undefined)).toEqual([])
    expect(retiredReceiptSignerAddresses('')).toEqual([])
  })

  it('never accepts a secret seed in the retired-address list', () => {
    // Guards against an operator pasting an S... seed into a public var.
    expect(retiredReceiptSignerAddresses(Keypair.random().secret())).toEqual([])
  })
})

/** Drive a refund through the real store to a `confirmed` record. */
async function confirmedRefundEnv(secret?: string): Promise<{ env: Env; publicId: string }> {
  const env = {
    RECEIPT_SIGNING_SECRET: secret,
    ATOMIC_STORE: makeAtomicStoreMock(),
  } as unknown as Env

  const enqueued = await enqueueRefund(env, {
    proof: {
      paymentId: 'challenge-1',
      paymentTx: 'a'.repeat(64),
      payer: `G${'A'.repeat(55)}`,
      recipient: `G${'B'.repeat(55)}`,
      asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      amountAtomic: '500000',
      mode: 'charge' as const,
    },
    reason: 'non_fulfillment',
    merchant: 'merchant.test',
    routeId: 'image',
  })

  const leaseId = 'lease-1'
  await leaseRefund(env, enqueued.refundId, leaseId)
  await completeRefund(env, enqueued.refundId, leaseId, {
    state: 'submitted', refundTx: 'b'.repeat(64), signedXdr: 'AAAA-test-xdr',
  })
  const confirmed = await completeRefund(env, enqueued.refundId, leaseId, {
    state: 'confirmed', refundTx: 'b'.repeat(64), confirmedLedger: 123456,
  })
  expect(confirmed?.state).toBe('confirmed')
  return { env, publicId: confirmed!.publicId }
}

describe('GET /v1/refunds/{id} receipt response', () => {
  it('returns an Ed25519 receipt a third party can verify', async () => {
    const kp = Keypair.random()
    const { env, publicId } = await confirmedRefundEnv(kp.secret())
    const response = await handleRefundStatus(env, publicId)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.algorithm).toBe('Ed25519')
    expect(body.signer.stellar_address).toBe(kp.publicKey())
    expect(verify(body, kp.publicKey())).toBe(true)
  })

  it('never returns HS256 or a bare unsigned receipt', async () => {
    const { env, publicId } = await confirmedRefundEnv(Keypair.random().secret())
    const body = await (await handleRefundStatus(env, publicId)).json() as any
    expect(body.algorithm).not.toBe('HS256')
    expect(body.signature).toBeTruthy()
  })

  it('fails closed with 503 when the signing key is unset', async () => {
    const { env, publicId } = await confirmedRefundEnv(undefined)
    const response = await handleRefundStatus(env, publicId)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Receipt signing unavailable' })
  })
})
