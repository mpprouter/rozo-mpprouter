// Original merchant payment link of a checkout order, kept in the router's own
// D1 (migrations/0005_checkout_payment_links.sql). Founder 2026-10-26: "you
// should save the original link. stripe and openrouter."
//
// The url is a replayable payment capability, so it is deliberately NOT put
// into Rozo intents metadata (echoed on every GET by order id) and NOT served
// by any public endpoint. Operators read it with:
//   wrangler d1 execute mpprouter-coupon-security --remote \
//     --command "SELECT provider, order_ref, url FROM checkout_payment_links WHERE rozo_payment_id = '<id>'"
//
// Writes are best effort: a D1 hiccup must never fail or delay order creation.
import type { Env } from '../index'

export type PaymentLinkProvider = 'coinbase' | 'stripe_crypto'

export interface OriginalPaymentLink {
  rozoPaymentId: string
  provider: PaymentLinkProvider
  orderRef: string
  url: string
}

const ALLOWED_HOSTS: Record<PaymentLinkProvider, (host: string) => boolean> = {
  coinbase: (h) => h === 'payments.coinbase.com' || h === 'commerce.coinbase.com',
  stripe_crypto: (h) => h === 'crypto.stripe.com',
}

/** True when `url` is an https link on the provider's own checkout host. */
export function isStorablePaymentLink(provider: PaymentLinkProvider, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  if (url.length > 2048) return false
  return ALLOWED_HOSTS[provider](u.hostname.toLowerCase().replace(/\.+$/, ''))
}

/**
 * Upsert the original link for an order. Never throws; returns whether a row
 * was written so callers/tests can observe it. Skipped (false) when the D1
 * binding is absent or the url is not a provider checkout link.
 */
export async function saveOriginalPaymentLink(
  env: Env,
  link: OriginalPaymentLink,
  now: number = Date.now(),
): Promise<boolean> {
  const db = env.COUPON_SECURITY_DB
  if (!db) return false
  if (!link.rozoPaymentId || !link.orderRef) return false
  if (!isStorablePaymentLink(link.provider, link.url)) return false
  try {
    await db
      .prepare(
        `INSERT INTO checkout_payment_links (rozo_payment_id, provider, order_ref, url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(rozo_payment_id) DO UPDATE SET
           provider = excluded.provider,
           order_ref = excluded.order_ref,
           url = excluded.url,
           updated_at = excluded.updated_at`,
      )
      .bind(link.rozoPaymentId, link.provider, link.orderRef, link.url, now, now)
      .run()
    return true
  } catch (err) {
    // Best effort by design: the order exists upstream; losing the copy of the
    // link is the lesser failure and is visible as a missing row.
    console.warn(
      // Not the full orderRef: a Coinbase id rebuilds the payable link.
      `[payment-link-store] save failed for ${link.provider} ${link.orderRef.slice(0, 18)}…: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`,
    )
    return false
  }
}

/** Read back the stored link (operator / admin use only; never public). */
export async function readOriginalPaymentLink(
  env: Env,
  rozoPaymentId: string,
): Promise<OriginalPaymentLink | null> {
  const db = env.COUPON_SECURITY_DB
  if (!db) return null
  const row = (await db
    .prepare('SELECT rozo_payment_id, provider, order_ref, url FROM checkout_payment_links WHERE rozo_payment_id = ?')
    .bind(rozoPaymentId)
    .first()) as { rozo_payment_id: string; provider: PaymentLinkProvider; order_ref: string; url: string } | null
  if (!row) return null
  return { rozoPaymentId: row.rozo_payment_id, provider: row.provider, orderRef: row.order_ref, url: row.url }
}

/** Canonical Coinbase link for a pl_ / paymentSession_ id (when the caller gave only the id). */
export function coinbaseLinkFromId(linkId: string): string | null {
  if (/^pl_[A-Za-z0-9_-]+$/.test(linkId)) return `https://payments.coinbase.com/payment-links/${linkId}`
  if (/^paymentSession_[A-Za-z0-9_-]+$/.test(linkId)) return `https://payments.coinbase.com/payment-sessions/${linkId}`
  return null
}
