// Public read-only invoice detail endpoint.
//
// POST /v1/services/rozo-agent-api/invoice-details  { "url": "<invoice url>" }
//
// Resolves a Coinbase or Stripe invoice URL to normalized, NON-SECRET detail:
// merchant, amount, currency, state, expiry, supported payment options, and
// masked transaction details — the same data a customer already sees on the
// checkout page.
//
// This endpoint moves NO money and NEVER exposes: client_secret, publishable
// key, the raw session URL/hash, unmasked wallet addresses, private keys, or
// signatures. It is rate-limited because every request consumes provider
// capacity and (for Stripe) touches a live session.

import type { Env } from '../index'
import { detectProvider } from './pay-invoice-admin'
import {
  resolveStripeInvoice,
  StripeResolveError,
  type NormalizedInvoice,
} from './invoice-provider'

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

// A short, stable, non-secret identifier for the Stripe session bucket. We use
// the /pay/<blob> segment length + a cheap hash so we never persist the raw
// blob in a KV key. The blob itself must not be logged.
async function sessionBucketId(url: string): Promise<string | null> {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/pay\/([A-Za-z0-9_-]+)/)
    if (!m) return null
    const bytes = new TextEncoder().encode(m[1])
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
      ],
    })
  }

  // Rate limit: per-IP first (cheap), then per-session for Stripe.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (!(await rateLimitOk(env, `ip:${ip}`, PER_IP_LIMIT, PER_IP_WINDOW_S))) {
    return json(429, { ok: false, error: 'Rate limit exceeded (per-IP). Try again shortly.' })
  }
  if (provider === 'stripe_crypto') {
    const sessBucket = await sessionBucketId(rawUrl)
    if (sessBucket) {
      if (
        !(await rateLimitOk(
          env,
          `session:${sessBucket}`,
          PER_SESSION_LIMIT,
          PER_SESSION_WINDOW_S,
        ))
      ) {
        return json(429, {
          ok: false,
          error: 'Rate limit exceeded (per-session). Try again shortly.',
        })
      }
    }
  }

  if (provider === 'stripe_crypto') {
    let invoice: NormalizedInvoice
    try {
      invoice = await resolveStripeInvoice(rawUrl)
    } catch (err) {
      if (err instanceof StripeResolveError) {
        const status =
          err.kind === 'invalid_url'
            ? 400
            : err.kind === 'expired'
              ? 410
              : err.kind === 'unsupported'
                ? 422
                : 502
        // err.message is authored to be address/secret-free by construction.
        return json(status, { ok: false, provider, error: err.message, reason: err.kind })
      }
      return json(502, { ok: false, provider, error: 'Failed to resolve Stripe invoice' })
    }
    return json(200, { ok: true, invoice })
  }

  // Coinbase read-only detail is served by the existing agentapi quote path
  // (quote-invoice / invoice-status). Phase A does not duplicate it here; the
  // normalized Coinbase adapter is a follow-up. Direct callers to the existing
  // endpoints for now.
  return json(501, {
    ok: false,
    provider,
    error:
      'Coinbase invoice-details normalization is not yet available on this endpoint. ' +
      'Use /v1/services/rozo-agent-api/quote-invoice or /invoice-status for Coinbase links.',
  })
}
