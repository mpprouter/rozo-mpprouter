// GET /v1/services/rozo-agent-api/existing-order
//
// Read-only: the order a payment link already has, so the checkout can avoid
// surprising a payer (e.g. auto-switching coins on a link that is already
// funded). Advisory only: create-invoice remains the gate.
//
// Split out of quote-invoice on 2026-10-12: the intents order lookup takes
// ~2.5s in production, and doing it inside the quote pushed every quote from
// ~0.07s to 1.5-2.1s (deploy 8e3e1633, rolled back). The quote never calls it.
//
// Input mirrors quote-invoice: `?payment_id=<pl_* | paymentSession_* |
// rozotest_* | cpis_*>` or `?link=<Coinbase or Stripe Crypto URL>`; when both
// are given, payment_id wins (same as normalizePayInvoiceBody).
//
// Response: { existingOrder: { rozoPaymentId, status, source: { chainId,
// tokenSymbol }, expiresAt, state, paid } | null, unknown: boolean }.
// unknown = the lookup failed, timed out or could not resolve the link: the
// client must not assume there is no order. Never returns addresses, amounts,
// BOLT11, tokens or receipts.

import type { Env } from '../index'
import { normalizePayInvoiceBody } from './pay-invoice-admin'
import { invoiceResolveRateLimit, rateLimitOk } from './invoice-details'
import { resolveStripeInvoice } from './invoice-provider'
import { isTestPaymentId, verifyTestPaymentId } from './native-sources'
import {
  EXISTING_ORDER_TIMEOUT_MS,
  findExistingOrder,
  isLookupTargetValid,
  type ExistingOrderResult,
  type ExistingOrderTarget,
} from './existing-order'

export const EXISTING_ORDER_PATH = '/v1/services/rozo-agent-api/existing-order'

// Budget for the lookup (up to 9 intents GETs per call), in its own buckets of
// the invoice-details KV limiter: per IP and per link per IP. Stripe links are
// additionally metered by invoiceResolveRateLimit before the session resolve.
export const EXISTING_ORDER_PER_IP_LIMIT = 60
export const EXISTING_ORDER_PER_LINK_LIMIT = 20
const EXISTING_ORDER_WINDOW_S = 60

function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

function invalid(message: string): Response {
  return json(400, { ok: false, code: 'INVALID_INPUT', message })
}

function result(r: ExistingOrderResult): Response {
  return json(200, {
    existingOrder: r.kind === 'found' ? r.summary : null,
    unknown: r.kind === 'unknown',
  })
}

const UNKNOWN: ExistingOrderResult = { kind: 'unknown' }

function rateLimited(retryAfterS: number): Response {
  return json(
    429,
    { ok: false, code: 'RATE_LIMITED', existingOrder: null, unknown: true, retry_after_s: retryAfterS },
    { 'Retry-After': String(retryAfterS) },
  )
}

const TIMED_OUT = Symbol('timed-out')

/** `p`, or TIMED_OUT once `ms` passes (p keeps running but is ignored). */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return TIMED_OUT
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Shared with invoice-status's by-link scan: one budget per IP and per link. */
export async function lookupBudget(
  request: Request,
  env: Env,
  key: string,
): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const perIp = await rateLimitOk(env, `existing-order:ip:${ip}`, EXISTING_ORDER_PER_IP_LIMIT, EXISTING_ORDER_WINDOW_S)
  if (!perIp.ok) return { ok: false, retryAfterS: perIp.retryAfterS }
  const perLink = await rateLimitOk(
    env,
    `existing-order:link:${key}:ip:${ip}`,
    EXISTING_ORDER_PER_LINK_LIMIT,
    EXISTING_ORDER_WINDOW_S,
  )
  if (!perLink.ok) return { ok: false, retryAfterS: perLink.retryAfterS }
  return { ok: true }
}

export async function handleExistingOrder(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })

  // One total deadline for the whole call: Stripe session resolve + lookup.
  const deadline = Date.now() + EXISTING_ORDER_TIMEOUT_MS
  const params = new URL(request.url).searchParams
  const paymentId = params.get('payment_id')?.trim() || ''
  const link = params.get('link')?.trim() || ''
  const body: Record<string, string> = {}
  if (paymentId) body.payment_id = paymentId
  if (link) body.url = link
  const { normalized, error, link_id_detected, provider_detected } = normalizePayInvoiceBody(body)
  if (!normalized || error) return invalid('Provide ?payment_id=<id> or ?link=<payment link URL>.')

  let target: ExistingOrderTarget | null = null
  const explicitId = 'payment_id' in normalized ? normalized.payment_id ?? null : null

  if (explicitId) {
    if (isTestPaymentId(explicitId)) {
      // Only a validly signed test id may reach the intents API.
      if ((await verifyTestPaymentId(env.ROZO_TEST_LINK_SECRET, explicitId)) === null) {
        return invalid('Invalid test payment id.')
      }
      target = { provider: 'coinbase', linkId: explicitId }
    } else if (explicitId.startsWith('cpis_')) {
      target = { provider: 'stripe_crypto', invoiceKey: explicitId }
    } else {
      target = { provider: 'coinbase', linkId: explicitId }
    }
  } else if (provider_detected === 'stripe_crypto' && 'url' in normalized && normalized.url) {
    // Same per-IP / per-invoice budget as invoice-details and quote-invoice:
    // resolving resumes a live Stripe session.
    // On a trip keep its 429 + Retry-After, in this endpoint's shape.
    const limited = await invoiceResolveRateLimit(request, env, normalized.url)
    if (limited) {
      const retryAfterS = Number(limited.headers.get('Retry-After')) || 60
      return rateLimited(retryAfterS)
    }
    // Check the time budget BEFORE touching Stripe: no resolve is started
    // that could not finish inside the deadline.
    const resolveMs = deadline - Date.now()
    if (resolveMs <= 0) return result(UNKNOWN)
    const resolving = resolveStripeInvoice(normalized.url)
    // Observed even if the deadline wins the race below.
    resolving.catch(() => undefined)
    try {
      const invoice = await withDeadline(resolving, resolveMs)
      // Cannot tell which order this link maps to: unknown, not "none".
      if (invoice === TIMED_OUT) return result(UNKNOWN)
      target = { provider: 'stripe_crypto', invoiceKey: invoice.invoiceKey }
    } catch {
      return result(UNKNOWN)
    }
  } else if (link_id_detected) {
    target = { provider: 'coinbase', linkId: link_id_detected }
  }

  if (!target || !isLookupTargetValid(target)) {
    return invalid('Unsupported payment link or id.')
  }

  const key = target.provider === 'stripe_crypto' ? target.invoiceKey : target.linkId
  const budget = await lookupBudget(request, env, key)
  if (!budget.ok) {
    return rateLimited(budget.retryAfterS)
  }

  const remaining = deadline - Date.now()
  if (remaining <= 0) return result(UNKNOWN)
  return result(await findExistingOrder(env, target, { timeoutMs: remaining }))
}
