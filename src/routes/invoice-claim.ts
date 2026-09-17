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
//   - held by same channel, same ref → ok (idempotent re-entry / retry)
//   - held by 'crypto', new 'crypto' ref → ok. Crypto-vs-crypto serialization
//     stays with the existing per-flow guards; this module only adds the
//     cross-channel rule so it cannot change existing crypto replay behaviour.
//   - held by another channel, or by 'upi' with a different order → refused,
//     the holder is returned so the caller can decide (409 / refund path).
//
// The claim is never released automatically: a claimed invoice that failed to
// settle is reconciled by a human, exactly like the existing failure states.

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
  if (holder.channel !== channel) return false
  if (channel === 'crypto') return true
  return holder.ref === ref
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
