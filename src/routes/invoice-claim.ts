// Cross-channel invoice claim (UPI fiat vs. existing crypto flows).
//
// One merchant invoice (Coinbase pl_* / paymentSession_*, Stripe cpis_*) must
// be paid at most ONCE by this router, whichever channel the customer used:
//
//   - UPI: MuggleLink captured INR and calls POST /api/invoice/verified-pay-in
//   - crypto: the Rozo payin/payout webhook (webhook.ts / stripe-fulfillment.ts)
//   - coupon: /coupon/redeem (coupon.ts)
//
// Each of those flows already has its own in-flight guard, but those guards are
// per-flow (and the Coinbase webhook's is a non-atomic KV read). This module is
// the single mutual-exclusion point ACROSS flows. It is a versioned CAS insert
// on the linearizable AtomicStoreDO (the same primitive the Stripe double-sign
// guard uses); it is NOT a KV get/set, which cannot serialize two isolates.
//
// Semantics:
//   - absent            → claim inserted, ok
//   - held by same channel AND same ref → ok (idempotent re-entry / retry:
//     the Coinbase webhook retries under the same plId, the Stripe branch
//     under the same orderId)
//   - anything else → refused, the holder is returned so the caller can
//     decide (409 / refund path). This also serializes the crypto flows
//     against each other (webhook vs coupon), which their separate per-flow
//     records never did.
//
// A claim is released ONLY by the holder, and only on a definite pre-payment
// failure (nothing was sent to an executor). Once an executor call has been
// made the claim stays until a human reconciles.

import type { Env } from '../index'
import { casUpdate, casRead } from './stripe-atomic'

export type ClaimChannel = 'upi' | 'crypto'

export interface InvoiceClaim {
  channel: ClaimChannel
  // UPI: MuggleLink order_id. crypto: the Rozo orderId / coupon code.
  ref: string
  claimedAt: string
}

export type ClaimResult =
  | { ok: true; claim: InvoiceClaim; created: boolean }
  | { ok: false; holder: InvoiceClaim }

export function invoiceClaimKey(invoiceKey: string): string {
  return `invoice-claim:v1:${invoiceKey}`
}

function parseClaim(raw: string | null): InvoiceClaim | null {
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as InvoiceClaim
    if ((c.channel === 'upi' || c.channel === 'crypto') && typeof c.ref === 'string') return c
    return null
  } catch {
    return null
  }
}

function claimAllows(holder: InvoiceClaim, channel: ClaimChannel, ref: string): boolean {
  return holder.channel === channel && holder.ref === ref
}

/** Atomically claim `invoiceKey` for `channel`/`ref`. Linearizable (DO CAS). */
export async function claimInvoiceKey(
  env: Env,
  invoiceKey: string,
  channel: ClaimChannel,
  ref: string,
  now: Date = new Date(),
): Promise<ClaimResult> {
  return casUpdate<ClaimResult>(env, invoiceClaimKey(invoiceKey), (raw) => {
    const holder = parseClaim(raw)
    if (holder) {
      if (claimAllows(holder, channel, ref)) {
        return { op: 'noop', result: { ok: true, claim: holder, created: false } }
      }
      return { op: 'noop', result: { ok: false, holder } }
    }
    const claim: InvoiceClaim = { channel, ref, claimedAt: now.toISOString() }
    return { op: 'set', value: JSON.stringify(claim), result: { ok: true, claim, created: true } }
  })
}

/** Read the current holder (or null). */
export async function readInvoiceClaim(env: Env, invoiceKey: string): Promise<InvoiceClaim | null> {
  const { value } = await casRead(env, invoiceClaimKey(invoiceKey))
  return parseClaim(value)
}

/**
 * Release a claim held by exactly this channel/ref. No-op otherwise. For
 * definite pre-payment failures only (no executor call was made).
 */
export async function releaseInvoiceClaim(
  env: Env,
  invoiceKey: string,
  channel: ClaimChannel,
  ref: string,
): Promise<boolean> {
  return casUpdate<boolean>(env, invoiceClaimKey(invoiceKey), (raw) => {
    const holder = parseClaim(raw)
    if (!holder || !claimAllows(holder, channel, ref)) return { op: 'noop', result: false }
    // An empty value parses as "no claim" (parseClaim → null).
    return { op: 'set', value: '', result: true }
  })
}
