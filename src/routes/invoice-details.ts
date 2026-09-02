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
  resolveCheckoutPricing,
} from './checkout-web-pricing'

// Rate limits (design doc §5.1). Per-IP protects the endpoint; the per-invoice
// bucket protects an individual live session from being pounded.
//
// WINDOW SEMANTICS: a true FIXED window. The window start is stored inside the
// value, so the counter resets `*_WINDOW_S` after the first request of a window
// even though CF KV resets a key's TTL on every write. The previous version
// derived the window from the TTL alone, which made it activity-based
// (sliding): sustained traffic never got a reset, so a throttled invoice could
// stay locked indefinitely.
//
// The per-invoice bucket is keyed by invoice AND client IP. Keying it by
// invoice alone made the budget global to a payment link, so two people (or one
// person on two tabs) opening the same link locked each other out.
// The per-IP limit must stay ABOVE the per-invoice limit, or the per-invoice
// bucket is unreachable: the IP check runs first over the same window, so a
// lower IP ceiling would answer every request that could ever have tripped the
// invoice bucket. Per-IP is the endpoint-wide abuse ceiling across all
// invoices; per-invoice is what stops one live session being pounded.
const PER_IP_LIMIT = 60 // requests, across all invoices
const PER_IP_WINDOW_S = 60
const PER_SESSION_LIMIT = 30 // requests, per invoice per IP
const PER_SESSION_WINDOW_S = 60

// User-facing 429 text. Callers branch on `code`, not on this string — it is
// rendered verbatim by checkout UIs, so it must never leak internal bucket
// names ("per-IP" / "per-session"); `scope` carries that for operators.
const RATE_LIMIT_MESSAGE = 'Too many requests. Please wait a moment and try again.'

function json(status: number, payload: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  })
}

type RateLimitResult = { ok: true } | { ok: false; retryAfterS: number }

/**
 * Fixed-window counter in KV. Returns `ok: true` if the request is allowed, or
 * `ok: false` with the seconds left in the current window. The window start is
 * carried in the value (`{ n, w }`) rather than inferred from the KV TTL, so a
 * write's unavoidable TTL reset cannot extend the window. The TTL is only used
 * to garbage-collect idle keys. Best-effort: a KV read/write race can let a
 * small burst through, which is acceptable for abuse control on a read-only
 * endpoint. Fails OPEN if KV is unavailable so a KV outage never takes down the
 * endpoint.
 */
async function rateLimitOk(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = `ratelimit:invoice-details:${bucket}`
  const now = Date.now()
  const windowMs = windowSeconds * 1000
  try {
    const raw = await env.MPP_STORE.get(key)
    let count = 0
    let windowStart = now
    if (raw) {
      // Values written before the fixed-window change were bare integers; they
      // do not parse and simply start a fresh window (one-time, self-healing).
      try {
        const parsed = JSON.parse(raw) as { n?: unknown; w?: unknown }
        if (
          typeof parsed?.n === 'number' &&
          Number.isFinite(parsed.n) &&
          typeof parsed?.w === 'number' &&
          Number.isFinite(parsed.w) &&
          now - parsed.w < windowMs
        ) {
          count = parsed.n
          windowStart = parsed.w
        }
      } catch {
        // fall through with a fresh window
      }
    }
    if (count >= limit) {
      const retryAfterS = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000))
      return { ok: false, retryAfterS }
    }
    // CF KV has a 60s minimum TTL; 2x the window is ample garbage collection
    // and no longer affects when the counter resets.
    await env.MPP_STORE.put(key, JSON.stringify({ n: count + 1, w: windowStart }), {
      expirationTtl: Math.max(60, windowSeconds * 2),
    })
    return { ok: true }
  } catch {
    return { ok: true } // fail open
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
  const ipLimit = await rateLimitOk(env, `ip:${ip}`, PER_IP_LIMIT, PER_IP_WINDOW_S)
  if (!ipLimit.ok) {
    return json(
      429,
      {
        ok: false,
        code: 'RATE_LIMITED',
        error: RATE_LIMIT_MESSAGE,
        scope: 'ip',
        retry_after_s: ipLimit.retryAfterS,
      },
      { 'Retry-After': String(ipLimit.retryAfterS) },
    )
  }
  // Per-invoice limit applies to BOTH providers: each request touches a live
  // upstream (a Stripe session, or the Coinbase checkout API).
  const sessBucket = await sessionBucketId(rawUrl)
  if (sessBucket) {
    const sessLimit = await rateLimitOk(
      env,
      `session:${sessBucket}:ip:${ip}`,
      PER_SESSION_LIMIT,
      PER_SESSION_WINDOW_S,
    )
    if (!sessLimit.ok) {
      return json(
        429,
        {
          ok: false,
          code: 'RATE_LIMITED',
          error: RATE_LIMIT_MESSAGE,
          scope: 'invoice',
          retry_after_s: sessLimit.retryAfterS,
        },
        { 'Retry-After': String(sessLimit.retryAfterS) },
      )
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
    const pricing = resolveCheckoutPricing(
      BigInt(invoice.stablecoinAmountAtomic),
      invoice.merchantTitle,
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
          { ...pricingFields, client: null },
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
