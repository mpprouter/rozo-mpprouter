import type { Env } from '../index'
import { createQuoteReceipt } from './quote-receipt'
import { resolveStripeInvoice, StripeResolveError } from './invoice-provider'
import { invoiceResolveRateLimit } from './invoice-details'
import {
  buildCheckoutTitle,
  formatUsdcAtomic,
  parseUsdcAtomic,
  resolveCheckoutPricing,
  resolveTrustedCheckoutChannel,
} from './checkout-web-pricing'

// ── Error code constants ─────────────────────────────────────────────────────

export type PayInvoiceErrorCode =
  | 'INVALID_INPUT'
  | 'QUOTE_UNAVAILABLE'
  | 'LINK_USED_OR_EXPIRED'
  | 'LINK_NOT_FOUND'
  | 'LINK_NOT_PAYABLE'
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
 * Returns 'coinbase' for Coinbase checkout hosts, 'stripe_crypto' for
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
  // Plain http:// is accepted and treated as https://: both providers only
  // serve checkout over TLS, so an http link is a copy/paste artifact (mail
  // clients and chat apps strip the scheme), never a different invoice.
  // normalizeInvoiceUrl() rewrites it before anything is fetched or keyed.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  if (STRIPE_HOSTS.has(host)) return 'stripe_crypto'
  if (COINBASE_HOSTS.has(host)) return 'coinbase'
  return null
}

/**
 * Canonicalize an invoice URL from a recognized provider: upgrade `http://`
 * to `https://` so the resolver fetch, KV session keys and quote receipts all
 * see one spelling. Returns the input unchanged when it is already https, is
 * not a URL, or is not on the provider allowlist (those fail later with the
 * existing errors — this never widens what is accepted).
 */
export function normalizeInvoiceUrl(raw: string): string {
  if (detectProvider(raw) === null) return raw
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return raw
    u.protocol = 'https:'
    return u.toString()
  } catch {
    return raw
  }
}

// ── Coinbase checkout ID extraction ──────────────────────────────────────────

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

/**
 * Extract the stable ID from either Coinbase checkout URL family.
 *
 * Kept separate from extractPaymentLinkId so existing callers that require a
 * legacy pl_* ID (coupon redemption and fulfillment KV keys) do not silently
 * start accepting paymentSession_* IDs before those flows support v3.
 */
export function extractCoinbaseCheckoutId(raw: string): string | null {
  if (detectProvider(raw) !== 'coinbase') return null
  try {
    const u = new URL(raw)
    const legacy = u.pathname.match(/\/payment-links\/(pl_[A-Za-z0-9_-]+)/)
    if (legacy) return legacy[1]
    const session = u.pathname.match(
      /\/payment-sessions\/(paymentSession_[A-Za-z0-9_-]+)/,
    )
    return session ? session[1] : null
  } catch {
    return null
  }
}

/**
 * True when the ID is a Coinbase v3 Payment Session ID (`paymentSession_*`)
 * rather than a legacy v1 Payment Link ID (`pl_*`).
 *
 * Callers use this to pick the upstream `next-api` resource path and the
 * matching response schema. Kept here alongside the URL extractors so the
 * Coinbase ID grammar lives in exactly one place.
 *
 * NOTE: `webhook.ts` still carries its own private `isPlId` / `isPaymentSessionId`
 * pair whose `pl_` pattern is STRICTER (alphanumeric only, no `_`/`-`). That
 * copy sits on the fund-movement path, so consolidating it is deliberately out
 * of scope for this read-only change — widening which IDs the payout webhook
 * accepts is a behavior change that belongs in its own reviewed PR.
 */
export function isCoinbasePaymentSessionId(id: string): boolean {
  return /^paymentSession_[A-Za-z0-9_-]+$/.test(id)
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
          'POST body: { "payment_id": "<pl_... or paymentSession_...>" }',
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
      rawUrl = normalizeInvoiceUrl((body[alias] as string).trim())
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

  // If a URL is provided, expose its stable checkout ID for diagnostics.
  let linkIdDetected: string | null = null
  let providerDetected: InvoiceProvider | null = null
  if (rawUrl) {
    linkIdDetected = extractCoinbaseCheckoutId(rawUrl)
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
        hint:
          'Provide { "url": "<checkout_url>" } or ' +
          '{ "payment_id": "<pl_... or paymentSession_...>" }.',
        normalized_input: {},
        link_id_detected: null,
        route_capabilities: [
          'url aliases: url, payment_link, link, invoice_url',
          'id aliases: payment_id, id, invoice_id, paymentLinkId',
          'Coinbase URL families: /payment-links/pl_... and /payment-sessions/paymentSession_...',
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

  const { normalized, error, link_id_detected, raw_url, provider_detected } =
    normalizePayInvoiceBody(parsed)
  if (!normalized || error) {
    const errPayload = error ?? {
      code: 'INVALID_INPUT' as PayInvoiceErrorCode,
      message: 'Could not normalize request body.',
      link_id_detected,
    }
    return errorResponse(400, errPayload)
  }

  // Stripe Crypto Payin links never reach agentapi (its quote-invoice only
  // understands Coinbase ids and answers "Invalid Coinbase Payment Link").
  // Resolve them read-only here and answer in the same shape as the Coinbase
  // branch, so a client that always quotes first (the web checkout does, for
  // both providers) gets one contract. No order, no money movement.
  if (provider_detected === 'stripe_crypto' && 'url' in normalized && normalized.url) {
    return quoteStripeInvoice(request, env, normalized.url)
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
    return errorResponse(...classifyQuoteUpstreamError(upstream.status, detail, {
      normalized_input: normalized,
      link_id_detected,
    }))
  }

  const quote: any = await upstream.json().catch(() => null)
  const paymentId = quote?.linkId ?? link_id_detected
  const amount = quote?.invoice?.amount
  const merchant = quote?.merchant
  if (!quote || !paymentId || typeof amount !== 'string' || typeof merchant !== 'string') {
    return errorResponse(502, {
      code: 'QUOTE_UNAVAILABLE',
      message: 'Quote upstream returned an invalid response.',
      normalized_input: normalized,
      link_id_detected,
    })
  }

  let originalAtomic: bigint
  try {
    originalAtomic = parseUsdcAtomic(amount)
  } catch {
    return errorResponse(502, {
      code: 'QUOTE_UNAVAILABLE',
      message: 'Quote upstream returned an unparseable invoice amount.',
      normalized_input: normalized,
      link_id_detected,
    })
  }
  const channel = await resolveTrustedCheckoutChannel(request, `coinbase:${paymentId}`, {
    agentBetaSecret: env.CHECKOUT_AGENT_BETA_CHANNEL_SECRET,
    agentBetaFeeBps: env.CHECKOUT_AGENT_BETA_FEE_BPS,
  })
  const pricing = resolveCheckoutPricing(
    originalAtomic,
    merchant,
    env.CHECKOUT_WEB_FEE_BPS,
    channel?.feeBps,
  )
  const pricingFields = {
    original: formatUsdcAtomic(pricing.originalAtomic),
    serviceFee: formatUsdcAtomic(pricing.serviceFeeAtomic),
    callerPays: formatUsdcAtomic(pricing.callerPaysAtomic),
    feeBps: pricing.feeBps,
    pricingVersion: pricing.pricingVersion,
  }

  const quoteReceipt = await createQuoteReceipt(
    paymentId,
    amount,
    merchant,
    env.PAYINVOICE_ADMIN_SECRET,
    Math.floor(Date.now() / 1000),
    { ...pricingFields, client: null, channel: channel?.id ?? null },
  )
  // Display fields, so a client can render the full invoice card from the quote
  // alone — before any order exists. `merchant` and `linkId` already reach the
  // caller via the `...quote` spread; `title` and `currency` are added here so
  // the quote shows exactly what create-invoice will show, instead of the
  // client rebuilding the string and drifting from the server.
  //
  // Deliberately NOT included: merchantLogoUrl / merchantDescription. Those come
  // from the Rozo intents response and genuinely do not exist until an intent is
  // created, so a quote-time card must render without them.
  return json(200, {
    ...quote,
    ...pricingFields,
    // Verbatim echo of the invoice URL this caller supplied in this same
    // request, so a client that keeps only the quote can still link back to the
    // merchant's invoice page. Discloses nothing new — they already hold it.
    // Omitted when the invoice was identified by payment_id instead of a URL.
    // Never sourced from a lookup: no endpoint keyed by id may return this.
    ...(raw_url ? { invoiceUrl: raw_url } : {}),
    title: buildCheckoutTitle(merchant, pricing),
    currency: 'USD',
    quote: {
      ...(quote?.quote && typeof quote.quote === 'object' ? quote.quote : {}),
      originalAtomicUsdc: pricing.originalAtomic.toString(),
      serviceFeeAtomicUsdc: pricing.serviceFeeAtomic.toString(),
      callerPaysAtomicUsdc: pricing.callerPaysAtomic.toString(),
      feeBps: pricing.feeBps,
      pricingVersion: pricing.pricingVersion,
    },
    quoteReceipt,
  })
}

// ── Upstream quote failure classification ────────────────────────────────────
// A bad link is the caller's problem, not an outage. agentapi answers 404 for a
// payment link Coinbase has never heard of and other 4xx for one it refuses to
// serve; wrapping those as 502 told the user "server error" when the honest
// answer was "this link is dead", and made every stale link look like one of
// our 5xx in the Cloudflare alert. Only agentapi being unreachable or broken
// (5xx, transport failure) is still ours to own.
//
// The 409 / 410 "already used or expired" cases are handled by the caller
// before this runs and keep their existing code and status.
//
// Not every 4xx is the link's fault. agentapi answers 401/403 when it rejects
// OUR x-admin-secret and 408/429 when it is timing out or throttling US. Those
// are total-checkout outages on our side: calling them LINK_NOT_PAYABLE would
// blame the buyer's link AND keep the Cloudflare 5xx alert silent through the
// outage, which is the exact failure this classification exists to prevent.
// 4xx codes from agentapi that describe OUR relationship with it (rejected
// admin secret, timeout, throttling), never the caller's payment link.
export const UPSTREAM_OUR_FAULT_4XX = new Set([401, 403, 408, 429])

function classifyQuoteUpstreamError(
  upstreamStatus: number,
  detail: string,
  context: Pick<PayInvoiceError, 'normalized_input' | 'link_id_detected'>,
): [number, PayInvoiceError] {
  const hint = detail.substring(0, 300)
  if (upstreamStatus === 404) {
    return [404, {
      code: 'LINK_NOT_FOUND',
      message: 'No such payment link. It may have been deleted, or the link may be mistyped.',
      hint,
      ...context,
    }]
  }
  if (upstreamStatus >= 400 && upstreamStatus < 500 && !UPSTREAM_OUR_FAULT_4XX.has(upstreamStatus)) {
    return [422, {
      code: 'LINK_NOT_PAYABLE',
      message: 'This payment link cannot be quoted.',
      hint,
      ...context,
    }]
  }
  return [502, {
    code: 'QUOTE_UNAVAILABLE',
    message: 'Quote upstream returned an error.',
    hint,
    ...context,
  }]
}

// ── Stripe quote branch ───────────────────────────────────────────────────────
// Mirrors invoice-details' Stripe pricing + receipt issuance, but returns the
// quote-invoice envelope (linkId / merchant / invoice.amount / pricing fields /
// quoteReceipt) that create-invoice's Stripe path already verifies against
// (receipt keyed by the cpis_* invoiceKey).

const STRIPE_QUOTE_ERROR_CODES: Record<string, PayInvoiceErrorCode> = {
  invalid_url: 'INVALID_INPUT',
  expired: 'LINK_USED_OR_EXPIRED',
  unsupported: 'QUOTE_UNAVAILABLE',
  upstream: 'QUOTE_UNAVAILABLE',
}
const STRIPE_QUOTE_ERROR_STATUS: Record<string, number> = {
  invalid_url: 400,
  expired: 410,
  unsupported: 422,
  upstream: 502,
}

async function quoteStripeInvoice(request: Request, env: Env, url: string): Promise<Response> {
  // Never echo the /pay/<blob> URL back in error payloads: the blob can be
  // replayed to resume the session. The caller already holds it.
  // Same per-IP / per-invoice buckets as invoice-details: every request here
  // resumes a live Stripe session, so quote-invoice must not be a second,
  // unmetered path to the same upstream (codex P2 on #188).
  const limited = await invoiceResolveRateLimit(request, env, url)
  if (limited) return limited

  let invoice
  try {
    invoice = await resolveStripeInvoice(url)
  } catch (err) {
    if (err instanceof StripeResolveError) {
      return errorResponse(STRIPE_QUOTE_ERROR_STATUS[err.kind] ?? 502, {
        code: STRIPE_QUOTE_ERROR_CODES[err.kind] ?? 'QUOTE_UNAVAILABLE',
        message: err.message,
        hint: err.kind === 'expired' ? 'Request a new payment link from the merchant.' : undefined,
        link_id_detected: null,
      })
    }
    return errorResponse(502, {
      code: 'QUOTE_UNAVAILABLE',
      message: 'Failed to resolve Stripe invoice.',
      link_id_detected: null,
    })
  }

  if (!invoice.payable) {
    // A session that is still open but whose merchant does not offer Base
    // USDC / wallet_connect is a settlement-rail mismatch, not a dead link: a
    // fresh link from the merchant would not help, so do not say "expired".
    const stillOpen = invoice.state === 'initialized' || invoice.state === 'checkout'
    if (stillOpen) {
      return errorResponse(422, {
        code: 'QUOTE_UNAVAILABLE',
        message: `Stripe invoice cannot be settled by this router (${invoice.payableReason ?? 'unsupported settlement option'}).`,
        hint: 'Pay this invoice directly with the merchant; it is still valid.',
        link_id_detected: null,
      })
    }
    return errorResponse(410, {
      code: 'LINK_USED_OR_EXPIRED',
      message: `Stripe invoice is not payable (${invoice.payableReason ?? invoice.state}).`,
      hint: 'Request a new payment link from the merchant.',
      link_id_detected: null,
    })
  }

  let originalAtomic: bigint
  try {
    originalAtomic = BigInt(invoice.stablecoinAmountAtomic)
  } catch {
    return errorResponse(502, {
      code: 'QUOTE_UNAVAILABLE',
      message: 'Stripe invoice returned an unparseable amount.',
      link_id_detected: null,
    })
  }
  if (originalAtomic <= 0n) {
    return errorResponse(422, {
      code: 'QUOTE_UNAVAILABLE',
      message: 'Invoice amount must be positive.',
      link_id_detected: null,
    })
  }

  // Same channel key as invoice-details so both quote surfaces price alike.
  const channel = await resolveTrustedCheckoutChannel(request, `stripe:${url}`, {
    agentBetaSecret: env.CHECKOUT_AGENT_BETA_CHANNEL_SECRET,
    agentBetaFeeBps: env.CHECKOUT_AGENT_BETA_FEE_BPS,
  })
  const pricing = resolveCheckoutPricing(
    originalAtomic,
    invoice.merchantTitle,
    env.CHECKOUT_WEB_FEE_BPS,
    channel?.feeBps,
  )
  const pricingFields = {
    original: formatUsdcAtomic(pricing.originalAtomic),
    serviceFee: formatUsdcAtomic(pricing.serviceFeeAtomic),
    callerPays: formatUsdcAtomic(pricing.callerPaysAtomic),
    feeBps: pricing.feeBps,
    pricingVersion: pricing.pricingVersion,
  }
  const quoteReceipt = await createQuoteReceipt(
    invoice.invoiceKey,
    invoice.stablecoinAmount,
    invoice.merchantTitle,
    env.PAYINVOICE_ADMIN_SECRET,
    Math.floor(Date.now() / 1000),
    { ...pricingFields, client: null, channel: channel?.id ?? null },
  )

  return json(200, {
    ok: true,
    provider: 'stripe_crypto',
    linkId: invoice.invoiceKey,
    merchant: invoice.merchantTitle,
    invoice: {
      amount: invoice.stablecoinAmount,
      currency: 'USD',
      invoiceKey: invoice.invoiceKey,
      state: invoice.state,
      validBefore: invoice.validBefore,
    },
    ...pricingFields,
    invoiceUrl: url,
    title: buildCheckoutTitle(invoice.merchantTitle, pricing),
    currency: 'USD',
    quote: {
      originalAtomicUsdc: pricing.originalAtomic.toString(),
      serviceFeeAtomicUsdc: pricing.serviceFeeAtomic.toString(),
      callerPaysAtomicUsdc: pricing.callerPaysAtomic.toString(),
      feeBps: pricing.feeBps,
      pricingVersion: pricing.pricingVersion,
    },
    quoteReceipt,
  })
}
