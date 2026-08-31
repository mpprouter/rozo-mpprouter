// Public read-only invoice detail endpoint.
//
// POST /v1/services/rozo-agent-api/invoice-details
//   { "url": "<invoice url>", "client": "rozo-checkout-web" }
//
// Resolves a Coinbase or Stripe checkout URL to normalized, NON-SECRET detail:
// merchant, amount, currency, state, expiry, supported payment options, and
// masked transaction details — the same data a customer already sees on the
// checkout page. Stripe responses also include the priced checkout total and
// a signed receipt that create-invoice requires when the fee canary is active.
//
// This endpoint moves NO money and NEVER exposes: client_secret, publishable
// key, the raw session URL/hash, unmasked wallet addresses, private keys, or
// signatures. It is rate-limited because every request consumes provider
// capacity and (for Stripe) touches a live session.

import type { Env } from '../index'
import { detectProvider, extractCoinbaseCheckoutId } from './pay-invoice-admin'
import {
  CoinbaseResolveError,
  resolveCoinbaseInvoice,
  resolveStripeInvoice,
  StripeResolveError,
  type NormalizedInvoice,
} from './invoice-provider'
import { createQuoteReceipt } from './quote-receipt'
import {
  formatUsdcAtomic,
  isExactCheckoutWebClient,
  normalizeCheckoutClient,
  resolveCheckoutPricing,
} from './checkout-web-pricing'

// Rate limits (design doc §5.1). Per-IP protects the endpoint; per-session
// protects an individual live Stripe session from being pounded.
//
// NOTE ON WINDOW SEMANTICS: this is an activity-based (sliding) limiter, not a
// strict fixed window. Each allowed request re-sets the KV TTL, so the counter
// only resets after `*_WINDOW_S` seconds of INACTIVITY. In practice this is
// stricter than a fixed window (sustained traffic never gets a mid-window
// reset), which is the desired property for abuse control. See rateLimitOk.
const PER_IP_LIMIT = 10 // requests
const PER_IP_WINDOW_S = 60
const PER_SESSION_LIMIT = 3 // requests
const PER_SESSION_WINDOW_S = 60

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Activity-based (sliding) counter in KV. Returns true if the request is
 * allowed (under the limit), false if it should be throttled. Each allowed
 * request re-sets the KV TTL, so the counter only resets after `windowSeconds`
 * of inactivity — sustained traffic never gets a mid-window reset. Best-effort:
 * a KV read/write race can let a small burst through, which is acceptable for
 * abuse control on a read-only endpoint. Fails OPEN if KV is unavailable so a
 * KV outage never takes down the endpoint.
 */
async function rateLimitOk(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = `ratelimit:invoice-details:${bucket}`
  try {
    const raw = await env.MPP_STORE.get(key)
    const count = raw ? parseInt(raw, 10) : 0
    if (Number.isFinite(count) && count >= limit) return false
    // Increment and (re)set the TTL. CF KV cannot update a value without
    // resetting TTL, so this is an activity-based sliding window by design.
    await env.MPP_STORE.put(key, String((Number.isFinite(count) ? count : 0) + 1), {
      expirationTtl: windowSeconds,
    })
    return true
  } catch {
    return true // fail open
  }
}

// A short, stable, non-secret identifier for the per-invoice bucket. For Stripe
// we hash the /pay/<blob> segment so the raw blob is never persisted in a KV
// key (it must not be logged either). For Coinbase we hash the checkout ID.
async function sessionBucketId(url: string): Promise<string | null> {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/pay\/([A-Za-z0-9_-]+)/)
    const id = m ? m[1] : extractCoinbaseCheckoutId(url)
    if (!id) return null
    const bytes = new TextEncoder().encode(id)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return hex
  } catch {
    return null
  }
}

export async function handleInvoiceDetails(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' })
  }

  const body = (parsed ?? {}) as Record<string, unknown>
  const rawUrl =
    typeof body.url === 'string'
      ? body.url.trim()
      : typeof body.payment_link === 'string'
        ? (body.payment_link as string).trim()
        : ''

  if (!rawUrl) {
    return json(400, {
      ok: false,
      error: 'Body must contain { "url": "<invoice url>" }',
      supported_url_families: [
        'https://crypto.stripe.com/pay/<blob>',
        'https://payments.coinbase.com/payment-links/pl_<id>',
        'https://payments.coinbase.com/payment-sessions/paymentSession_<id>',
      ],
    })
  }

  const provider = detectProvider(rawUrl)
  if (!provider) {
    return json(400, {
      ok: false,
      error: 'Unsupported or malformed invoice URL',
      supported_url_families: [
        'https://crypto.stripe.com/pay/<blob>',
        'https://payments.coinbase.com/payment-links/pl_<id>',
        'https://payments.coinbase.com/payment-sessions/paymentSession_<id>',
      ],
    })
  }

  // Rate limit: per-IP first (cheap), then per-session for Stripe.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (!(await rateLimitOk(env, `ip:${ip}`, PER_IP_LIMIT, PER_IP_WINDOW_S))) {
    return json(429, { ok: false, error: 'Rate limit exceeded (per-IP). Try again shortly.' })
  }
  // Per-invoice limit applies to BOTH providers: each request touches a live
  // upstream (a Stripe session, or the Coinbase checkout API).
  const sessBucket = await sessionBucketId(rawUrl)
  if (sessBucket) {
    if (
      !(await rateLimitOk(env, `session:${sessBucket}`, PER_SESSION_LIMIT, PER_SESSION_WINDOW_S))
    ) {
      return json(429, {
        ok: false,
        error: 'Rate limit exceeded (per-session). Try again shortly.',
      })
    }
  }

  // Map a resolver error kind to an HTTP status. Both providers use the same
  // kind union, so both branches share this mapping.
  const statusFor = (kind: string): number =>
    kind === 'invalid_url' ? 400 : kind === 'expired' ? 410 : kind === 'unsupported' ? 422 : 502

  let invoice: NormalizedInvoice
  if (provider === 'stripe_crypto') {
    try {
      invoice = await resolveStripeInvoice(rawUrl)
    } catch (err) {
      if (err instanceof StripeResolveError) {
        // err.message is authored to be address/secret-free by construction.
        return json(statusFor(err.kind), {
          ok: false,
          provider,
          error: err.message,
          reason: err.kind,
        })
      }
      return json(502, { ok: false, provider, error: 'Failed to resolve Stripe invoice' })
    }
  } else {
    // Coinbase: read-only normalization of the same data the checkout page
    // shows. This issues NO quote receipt and is NOT a replacement for
    // `quote-invoice`, which remains the amount trust chain for settlement.
    try {
      invoice = await resolveCoinbaseInvoice(rawUrl)
    } catch (err) {
      if (err instanceof CoinbaseResolveError) {
        return json(statusFor(err.kind), {
          ok: false,
          provider,
          error: err.message,
          reason: err.kind,
        })
      }
      return json(502, { ok: false, provider, error: 'Failed to resolve Coinbase invoice' })
    }
  }
  if (provider === 'stripe_crypto') {
    const clientRaw = body.client
    const client = normalizeCheckoutClient(clientRaw)
    const pricingClient = isExactCheckoutWebClient(clientRaw) ? client : null
    const pricing = resolveCheckoutPricing(
      BigInt(invoice.stablecoinAmountAtomic),
      invoice.merchantTitle,
      pricingClient,
      env.CHECKOUT_WEB_FEE_BPS,
    )
    const pricingFields = {
      original: formatUsdcAtomic(pricing.originalAtomic),
      serviceFee: formatUsdcAtomic(pricing.serviceFeeAtomic),
      callerPays: formatUsdcAtomic(pricing.callerPaysAtomic),
      feeBps: pricing.feeBps,
      pricingVersion: pricing.pricingVersion,
    }

    // A non-zero canary must never become display-X/create-X+fee. Fail closed
    // if we cannot issue the signed snapshot create-invoice requires.
    if (pricing.feeBps > 0 && !env.PAYINVOICE_ADMIN_SECRET) {
      return json(503, {
        ok: false,
        provider,
        error: 'Signed checkout pricing is temporarily unavailable.',
      })
    }
    const quoteReceipt = env.PAYINVOICE_ADMIN_SECRET
      ? await createQuoteReceipt(
          invoice.invoiceKey,
          invoice.stablecoinAmount,
          invoice.merchantTitle,
          env.PAYINVOICE_ADMIN_SECRET,
          Math.floor(Date.now() / 1000),
          { ...pricingFields, client: pricingClient },
        )
      : null
    return json(200, {
      ok: true,
      invoice,
      ...pricingFields,
      ...(quoteReceipt ? { quoteReceipt } : {}),
    })
  }

  return json(200, { ok: true, invoice })
}
