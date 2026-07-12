import type { Env } from '../index'

// ── Error code constants ─────────────────────────────────────────────────────

export type PayInvoiceErrorCode =
  | 'INVALID_INPUT'
  | 'QUOTE_UNAVAILABLE'
  | 'LINK_USED_OR_EXPIRED'
  | 'UPSTREAM_ERROR'

export interface PayInvoiceError {
  code: PayInvoiceErrorCode
  message: string
  hint?: string
  normalized_input?: { url?: string; payment_id?: string }
  link_id_detected?: string | null
  route_capabilities?: string[]
}

// ── Canonical normalized type ─────────────────────────────────────────────────

export type PayInvoiceNormalized =
  | { url: string; payment_id?: never }
  | { payment_id: string; url?: never }

// ── Field aliases ─────────────────────────────────────────────────────────────
// Accepted client aliases → canonical field names:
//   url:        url | payment_link | link | invoice_url
//   payment_id: payment_id | id | invoice_id | paymentLinkId

const URL_ALIASES = ['url', 'payment_link', 'link', 'invoice_url'] as const
const ID_ALIASES = ['payment_id', 'id', 'invoice_id', 'paymentLinkId'] as const

// ── Provider detection ──────────────────────────────────────────────────────

export type InvoiceProvider = 'coinbase' | 'stripe_crypto'

// Strict host allowlists. Only these exact hosts are recognized as invoice
// providers — any other host (including look-alikes such as
// crypto.stripe.com.evil.com) resolves to `null` so a caller can never coax
// the router into resolving an attacker-controlled URL.
const COINBASE_HOSTS = new Set(['payments.coinbase.com', 'commerce.coinbase.com'])
const STRIPE_HOSTS = new Set(['crypto.stripe.com'])

/**
 * Classify an invoice URL by provider using a strict host allowlist.
 * Returns 'coinbase' for Coinbase payment-link hosts, 'stripe_crypto' for
 * Stripe crypto checkout, or null when the URL is malformed or the host is
 * not on either allowlist.
 */
export function detectProvider(raw: string): InvoiceProvider | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  if (STRIPE_HOSTS.has(host)) return 'stripe_crypto'
  if (COINBASE_HOSTS.has(host)) return 'coinbase'
  return null
}

// ── pl_ extraction ────────────────────────────────────────────────────────────

/**
 * If the input is a Coinbase payment link URL containing /payment-links/pl_...,
 * extract and return the payment link ID. Returns null otherwise.
 */
export function extractPaymentLinkId(raw: string): string | null {
  try {
    const u = new URL(raw)
    const match = u.pathname.match(/\/payment-links\/(pl_[A-Za-z0-9_-]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

// ── Stripe pay-blob extraction ──────────────────────────────────────────────

/**
 * Extract the opaque `/pay/<blob>` segment from a Stripe crypto checkout URL.
 * The blob is the customer-facing session hash used to resume the Payin
 * Session. Returns null when the host is not the Stripe checkout host or no
 * `/pay/<blob>` segment is present.
 *
 * The blob is NOT a secret on its own — it is the same value embedded in the
 * customer checkout URL — but it must never be logged or echoed back in
 * responses (it can be replayed to extend a live session). Callers use this
 * only to hand the URL to the read-only resolver.
 */
export function extractStripeSessionBlob(raw: string): string | null {
  if (detectProvider(raw) !== 'stripe_crypto') return null
  try {
    const u = new URL(raw)
    const m = u.pathname.match(/\/pay\/([A-Za-z0-9_-]+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ── normalizePayInvoiceBody ───────────────────────────────────────────────────

export interface NormalizedPayInvoiceResult {
  normalized: PayInvoiceNormalized | null
  /** Raw values seen in the body after alias resolution (for error context) */
  raw_url: string
  raw_id: string
  link_id_detected: string | null
  /**
   * Provider classified from the URL (strict host allowlist), or null when no
   * URL was given / the host is unknown. Additive: Coinbase callers that pass
   * a pl_ id (no URL) get `null` here and are unaffected.
   */
  provider_detected: InvoiceProvider | null
  error?: PayInvoiceError
}

export function normalizePayInvoiceBody(input: unknown): NormalizedPayInvoiceResult {
  const empty: NormalizedPayInvoiceResult = {
    normalized: null,
    raw_url: '',
    raw_id: '',
    link_id_detected: null,
    provider_detected: null,
  }

  if (!input || typeof input !== 'object') {
    return {
      ...empty,
      error: {
        code: 'INVALID_INPUT',
        message: 'Request body must be a JSON object.',
        hint: 'Send Content-Type: application/json with a JSON object body.',
        route_capabilities: [
          'POST body: { "url": "<payment_link_url>" }',
          'POST body: { "payment_id": "<pl_...>" }',
          'Aliases accepted for url: payment_link, link, invoice_url',
          'Aliases accepted for payment_id: id, invoice_id, paymentLinkId',
        ],
      },
    }
  }

  const body = input as Record<string, unknown>

  // Resolve url from any alias
  let rawUrl = ''
  for (const alias of URL_ALIASES) {
    if (typeof body[alias] === 'string' && (body[alias] as string).trim()) {
      rawUrl = (body[alias] as string).trim()
      break
    }
  }

  // Resolve payment_id from any alias
  let rawId = ''
  for (const alias of ID_ALIASES) {
    if (typeof body[alias] === 'string' && (body[alias] as string).trim()) {
      rawId = (body[alias] as string).trim()
      break
    }
  }

  // If url provided but no explicit id, try to derive payment_id from pl_ in URL
  let linkIdDetected: string | null = null
  let providerDetected: InvoiceProvider | null = null
  if (rawUrl) {
    linkIdDetected = extractPaymentLinkId(rawUrl)
    // Classify the provider from the URL host (strict allowlist). Purely
    // additive — used by the Stripe path and for error context; the Coinbase
    // normalization result (url/payment_id) is unchanged.
    providerDetected = detectProvider(rawUrl)
    // If we can derive a payment_id from the url and no explicit id given, prefer url form
    // but record detection for error reporting
  }

  const hasUrl = !!rawUrl
  const hasId = !!rawId

  if (!hasUrl && !hasId) {
    return {
      ...empty,
      error: {
        code: 'INVALID_INPUT',
        message: 'Body must contain at least one of: url or payment_id (with accepted aliases).',
        hint: 'Provide { "url": "<payment_link_url>" } or { "payment_id": "<pl_...>" }.',
        normalized_input: {},
        link_id_detected: null,
        route_capabilities: [
          'url aliases: url, payment_link, link, invoice_url',
          'id aliases: payment_id, id, invoice_id, paymentLinkId',
          'If url contains /payment-links/pl_..., payment_id is auto-derived',
        ],
      },
    }
  }

  if (hasUrl && hasId) {
    // Both provided: use payment_id as canonical (more precise), but record both
    return {
      normalized: { payment_id: rawId },
      raw_url: rawUrl,
      raw_id: rawId,
      link_id_detected: linkIdDetected,
      provider_detected: providerDetected,
    }
  }

  if (hasUrl) {
    return {
      normalized: { url: rawUrl },
      raw_url: rawUrl,
      raw_id: '',
      link_id_detected: linkIdDetected,
      provider_detected: providerDetected,
    }
  }

  // hasId only (no URL → no provider classification possible)
  return {
    normalized: { payment_id: rawId },
    raw_url: '',
    raw_id: rawId,
    link_id_detected: null,
    provider_detected: null,
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, err: PayInvoiceError): Response {
  return json(status, { error: err.message, ...err })
}

// ── handleAdminPayInvoice ─────────────────────────────────────────────────────

export async function handleAdminPayInvoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  }

  const callerSecret = request.headers.get('x-admin-secret')?.trim()
  if (!callerSecret || callerSecret !== env.PAYINVOICE_ADMIN_SECRET) {
    return json(401, { error: 'Unauthorized' })
  }

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return json(400, { code: 'INVALID_INPUT', error: 'Invalid JSON body' })
  }

  const { normalized, error, link_id_detected } = normalizePayInvoiceBody(parsed)
  if (!normalized || error) {
    const errPayload = error ?? {
      code: 'INVALID_INPUT' as PayInvoiceErrorCode,
      message: 'Could not normalize request body.',
      link_id_detected,
    }
    return errorResponse(400, errPayload)
  }

  let upstream: Response
  try {
    upstream = await fetch('https://agentapi.rozo.ai/pay-invoice', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify(normalized),
    })
  } catch (err: any) {
    return errorResponse(502, {
      code: 'UPSTREAM_ERROR',
      message: `Upstream call failed: ${err?.message ?? 'unknown error'}`,
      hint: 'agentapi.rozo.ai/pay-invoice is unreachable. Retry later.',
      normalized_input: normalized,
      link_id_detected,
    })
  }

  const upstreamText = await upstream.text()

  // Detect deterministic link states from upstream status codes
  if (upstream.status === 409 || upstream.status === 410) {
    return errorResponse(upstream.status, {
      code: 'LINK_USED_OR_EXPIRED',
      message: 'Payment link has already been used or has expired.',
      hint: 'Request a new payment link from the merchant.',
      normalized_input: normalized,
      link_id_detected,
    })
  }

  const contentType = upstream.headers.get('content-type') || 'application/json'
  return new Response(upstreamText, {
    status: upstream.status,
    headers: { 'Content-Type': contentType },
  })
}

// ── handleQuoteInvoice ────────────────────────────────────────────────────────
// Public handler for GET/POST /v1/services/rozo-agent-api/quote-invoice
// Proxies to agentapi.rozo.ai/quote-invoice with alias normalization.

export async function handleQuoteInvoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  }

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return json(400, { code: 'INVALID_INPUT', error: 'Invalid JSON body' })
  }

  const { normalized, error, link_id_detected } = normalizePayInvoiceBody(parsed)
  if (!normalized || error) {
    const errPayload = error ?? {
      code: 'INVALID_INPUT' as PayInvoiceErrorCode,
      message: 'Could not normalize request body.',
      link_id_detected,
    }
    return errorResponse(400, errPayload)
  }

  let upstream: Response
  try {
    upstream = await fetch('https://agentapi.rozo.ai/quote-invoice', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify(normalized),
    })
  } catch (err: any) {
    return errorResponse(502, {
      code: 'QUOTE_UNAVAILABLE',
      message: `Quote upstream call failed: ${err?.message ?? 'unknown error'}`,
      hint: 'agentapi.rozo.ai/quote-invoice is unreachable. Retry later.',
      normalized_input: normalized,
      link_id_detected,
    })
  }

  if (!upstream.ok) {
    const detail = await upstream.text()
    if (upstream.status === 409 || upstream.status === 410) {
      return errorResponse(upstream.status, {
        code: 'LINK_USED_OR_EXPIRED',
        message: 'Payment link has already been used or has expired.',
        hint: 'Request a new payment link from the merchant.',
        normalized_input: normalized,
        link_id_detected,
      })
    }
    return errorResponse(502, {
      code: 'QUOTE_UNAVAILABLE',
      message: 'Quote upstream returned an error.',
      hint: detail.substring(0, 300),
      normalized_input: normalized,
      link_id_detected,
    })
  }

  const contentType = upstream.headers.get('content-type') || 'application/json'
  const body = await upstream.text()
  return new Response(body, {
    status: upstream.status,
    headers: { 'Content-Type': contentType },
  })
}
