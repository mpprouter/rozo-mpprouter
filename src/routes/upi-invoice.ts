// UPI invoice payment: the Checkout-fulfillment side of the MuggleLink contract.
//
// MuggleLink collects INR over Razorpay UPI for a merchant invoice the customer
// pasted (Coinbase v1 payment link, Coinbase v3 payment session, or a Stripe
// Crypto Payin session). Once the UPI payment is CAPTURED, MuggleLink's server
// calls this Worker to settle the original invoice with the router's own funder
// wallet, through the exact same payment executors the crypto checkout uses:
//
//   coinbase_v1 / coinbase_v3 → callAgentApiPayInvoice (webhook.ts)
//   stripe_crypto             → callStripePayInvoice   (stripe-fulfillment.ts)
//
// Nothing here fakes a Rozo payin webhook. The fiat receipt is a NEW trusted
// input (server-to-server, shared secret + body HMAC), and the invoice is
// claimed across channels (invoice-claim.ts) before any executor is called.
//
// Endpoints (all X-Internal-Key: UPI_INTERNAL_KEY, never browser-facing):
//   POST /api/invoice/resolve
//   POST /api/invoice/verified-pay-in        (+ X-Signature, X-Idempotency-Key)
//   GET  /api/invoice/fulfillment/<order_id>
//
// State machine for a fulfillment (keyed by MuggleLink order_id):
//   queued → processing → paid | failed | unknown
//   `paid` is set ONLY on provider terminal success observed by us
//   (Coinbase v3 PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED, Coinbase v1 usage
//   exhausted, Stripe fulfillment_complete/succeeded). An accepted executor
//   call is `processing`, never `paid`. An ambiguous executor outcome is
//   `unknown` and is NEVER re-paid; the status endpoint asks the provider.
//
// Secret hygiene: the Stripe pay URL is a replayable capability. It is stored
// only AES-GCM encrypted (invoice-capability-crypto.ts) in the quote record
// and decrypted in memory to hand to the executor. It is never returned.

import type { Env } from '../index'
import {
  detectProvider,
  extractCoinbaseCheckoutId,
  extractStripeSessionBlob,
  isCoinbasePaymentSessionId,
} from './pay-invoice-admin'
import {
  CoinbaseResolveError,
  StripeResolveError,
  fetchCoinbasePayment,
  normalizeCoinbasePayment,
  resolveStripeInvoice,
  type NormalizedInvoice,
} from './invoice-provider'
import { casUpdate, casRead } from './stripe-atomic'
import { claimInvoiceKey } from './invoice-claim'
import {
  FUNDER_WALLET,
  callAgentApiPayInvoice,
  bumpReserved,
  reservedAtomic,
  sendInvoiceFailureAlert,
} from './webhook'
import {
  callStripePayInvoice,
  reserveDailySpend,
  releaseDailySpend,
} from './stripe-fulfillment'
import { getBaseUsdcBalance } from '../utils/base-usdc-balance'
import { encryptCapability, decryptCapability } from './invoice-capability-crypto'

// ── Types ───────────────────────────────────────────────────────────────────

export type UpiProvider = 'coinbase_v1' | 'coinbase_v3' | 'stripe_crypto'
const UPI_PROVIDERS: ReadonlySet<string> = new Set(['coinbase_v1', 'coinbase_v3', 'stripe_crypto'])

export type FulfillmentState = 'queued' | 'processing' | 'paid' | 'failed' | 'unknown'

export interface UpiFulfillmentRecord {
  orderId: string
  provider: UpiProvider
  invoiceKey: string
  bodyHash: string // sha256 hex of the raw verified-pay-in body (replay check)
  baseAmountMinor: string
  stablecoinAmountAtomic: string
  state: FulfillmentState
  providerFinalState: string | null
  executionRef: string | null
  failureReason: string | null
  razorpayPaymentId: string | null
  createdAt: string
  updatedAt: string
  events: Array<{ kind: string; at: string; detail?: unknown }>
}

interface QuoteRecord {
  provider: UpiProvider
  invoiceKey: string
  quoteId: string
  baseAmountMinor: string
  expiresAt: string | null
  merchant: string
  // stripe_crypto only: the pay URL, AES-GCM sealed. Never plaintext.
  payUrlEncrypted: string | null
  createdAt: string
}

export interface UpiResolution {
  provider: UpiProvider
  invoice_key: string
  merchant: string
  base_amount_minor: number
  currency: 'USD'
  payable: boolean
  reason: string | null
  expires_at: string | null
  quote_id: string
}

// Minimum validity left on the invoice at resolve time. A UPI flow needs the
// customer to log in, confirm, and pay, then Razorpay to capture; an invoice
// that expires before that would be captured and then unpayable (refund path).
const DEFAULT_MIN_VALIDITY_S = 15 * 60
// A `processing` record older than this without provider confirmation is
// reported as `unknown` (needs reconciliation; never re-paid).
const PROCESSING_STALE_MS = 15 * 60 * 1000
const QUOTE_TTL_S = 60 * 60 * 24 * 7

// ── Small helpers ───────────────────────────────────────────────────────────

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: code, message })
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
}

async function sha256Hex(message: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)))
}

/** quote_id = HMAC-SHA256(UPI_INTERNAL_KEY, provider|invoice_key|base_amount_minor|expires_at). */
export async function computeQuoteId(
  secret: string,
  provider: UpiProvider,
  invoiceKey: string,
  baseAmountMinor: string | number,
  expiresAt: string | null,
): Promise<string> {
  return hmacSha256Hex(
    secret,
    [provider, invoiceKey, String(baseAmountMinor), expiresAt ?? ''].join('|'),
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function providersEnabled(env: Env): Set<string> {
  const raw = env.UPI_PROVIDERS_ENABLED ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

function minValidityMs(env: Env): number {
  const n = Number(env.UPI_MIN_VALIDITY_S)
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_VALIDITY_S) * 1000
}

// ── Auth ────────────────────────────────────────────────────────────────────

/** null when authorized, else the 401/503 response. */
export function checkInternalKey(request: Request, env: Env): Response | null {
  const secret = env.UPI_INTERNAL_KEY
  if (!secret || secret.length < 16) {
    return err(503, 'not_configured', 'UPI_INTERNAL_KEY is not configured')
  }
  const provided = request.headers.get('x-internal-key') ?? ''
  if (!timingSafeEqual(provided, secret)) {
    return err(401, 'unauthorized', 'invalid X-Internal-Key')
  }
  return null
}

// ── URL classification ──────────────────────────────────────────────────────

export type ClassifiedUrl =
  | { provider: 'coinbase_v1' | 'coinbase_v3'; invoiceKey: string; payUrl: string }
  | { provider: 'stripe_crypto'; invoiceKey: null; payUrl: string }
  | null

/**
 * Strict allowlist: exactly the three supported link families. Everything
 * else (commerce.coinbase.com charges, crypto.stripe.com/setup/*, card
 * checkout.stripe.com pages, arbitrary hosts) is null.
 */
export function classifyUpiUrl(raw: string): ClassifiedUrl {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  const provider = detectProvider(raw.trim())
  if (provider === 'coinbase') {
    const id = extractCoinbaseCheckoutId(raw.trim())
    if (!id) return null
    return {
      provider: isCoinbasePaymentSessionId(id) ? 'coinbase_v3' : 'coinbase_v1',
      invoiceKey: id,
      payUrl: raw.trim(),
    }
  }
  if (provider === 'stripe_crypto') {
    if (!extractStripeSessionBlob(raw.trim())) return null
    return { provider: 'stripe_crypto', invoiceKey: null, payUrl: raw.trim() }
  }
  return null
}

// ── Live provider lookups ───────────────────────────────────────────────────

export interface LiveInvoice {
  normalized: NormalizedInvoice
  // Provider terminal mapping (design §10-6). `success` is the ONLY thing
  // that may ever turn a fulfillment into `paid`.
  terminal: 'success' | 'failure' | null
}

const STRIPE_TERMINAL_SUCCESS = new Set(['fulfillment_complete', 'succeeded'])
const STRIPE_TERMINAL_FAILURE = new Set(['failed', 'canceled', 'error'])
const COINBASE_V3_SUCCESS = 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED'

/** Map a Stripe session state to a terminal outcome (null = not terminal). */
export function stripeTerminal(state: string): LiveInvoice['terminal'] {
  if (STRIPE_TERMINAL_SUCCESS.has(state)) return 'success'
  if (STRIPE_TERMINAL_FAILURE.has(state)) return 'failure'
  return null
}

export async function fetchLiveInvoice(
  provider: UpiProvider,
  invoiceKey: string,
  payUrl: string | null,
  nowMs: number = Date.now(),
): Promise<LiveInvoice> {
  if (provider === 'stripe_crypto') {
    if (!payUrl) throw new StripeResolveError('invalid_url', 'stripe pay url unavailable')
    const normalized = await resolveStripeInvoice(payUrl)
    return { normalized, terminal: stripeTerminal(normalized.state) }
  }
  const payment = await fetchCoinbasePayment(invoiceKey)
  const normalized = await normalizeCoinbasePayment(payment, nowMs)
  let terminal: LiveInvoice['terminal'] = null
  if (provider === 'coinbase_v3') {
    if (normalized.state === COINBASE_V3_SUCCESS) terminal = 'success'
  } else {
    const p = payment as { usageCount?: unknown; maxUsage?: unknown }
    if (
      typeof p.usageCount === 'number' &&
      typeof p.maxUsage === 'number' &&
      p.maxUsage > 0 &&
      p.usageCount >= p.maxUsage
    ) {
      terminal = 'success'
    }
  }
  return { normalized, terminal }
}

// ── Quote records (KV, TTL) ─────────────────────────────────────────────────

function quoteKey(provider: UpiProvider, invoiceKey: string): string {
  return `upi-quote:v1:${provider}:${invoiceKey}`
}

async function loadQuote(env: Env, provider: UpiProvider, invoiceKey: string): Promise<QuoteRecord | null> {
  const raw = await env.MPP_STORE.get(quoteKey(provider, invoiceKey))
  if (!raw) return null
  try {
    return JSON.parse(raw) as QuoteRecord
  } catch {
    return null
  }
}

// ── Fulfillment records (DO, linearizable) ──────────────────────────────────

export function fulfillmentKey(orderId: string): string {
  return `upi-fulfillment:v1:${orderId}`
}

function parseFulfillment(raw: string | null): UpiFulfillmentRecord | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as UpiFulfillmentRecord
  } catch {
    return null
  }
}

export async function loadFulfillment(env: Env, orderId: string): Promise<UpiFulfillmentRecord | null> {
  const { value } = await casRead(env, fulfillmentKey(orderId))
  return parseFulfillment(value)
}

async function updateFulfillment(
  env: Env,
  orderId: string,
  mutate: (rec: UpiFulfillmentRecord) => void,
): Promise<UpiFulfillmentRecord | null> {
  return casUpdate<UpiFulfillmentRecord | null>(env, fulfillmentKey(orderId), (raw) => {
    const rec = parseFulfillment(raw)
    if (!rec) return { op: 'noop', result: null }
    mutate(rec)
    rec.updatedAt = new Date().toISOString()
    return { op: 'set', value: JSON.stringify(rec), result: rec }
  })
}

const TERMINAL_STATES: ReadonlySet<FulfillmentState> = new Set(['paid', 'failed'])

async function transition(
  env: Env,
  orderId: string,
  state: FulfillmentState,
  detail: {
    kind: string
    providerFinalState?: string | null
    executionRef?: string | null
    failureReason?: string | null
    extra?: unknown
  },
): Promise<UpiFulfillmentRecord | null> {
  return updateFulfillment(env, orderId, (rec) => {
    // Terminal states are sticky. In particular a `failed` record (e.g. the
    // invoice was already paid by someone else before we ran) must never be
    // relabelled `paid` just because the provider later reports success:
    // that would attribute another payer's settlement to this UPI order.
    if (!TERMINAL_STATES.has(rec.state)) rec.state = state
    if (detail.providerFinalState !== undefined) rec.providerFinalState = detail.providerFinalState
    if (detail.executionRef !== undefined) rec.executionRef = detail.executionRef
    if (detail.failureReason !== undefined) rec.failureReason = detail.failureReason
    rec.events.push({ kind: detail.kind, at: new Date().toISOString(), detail: detail.extra })
  })
}

function statusPayload(rec: UpiFulfillmentRecord) {
  return {
    state: rec.state,
    provider_final_state: rec.providerFinalState,
    execution_ref: rec.executionRef,
    updated_at: rec.updatedAt,
  }
}

// ── POST /api/invoice/resolve ───────────────────────────────────────────────

function mapResolveError(e: unknown): Response {
  if (e instanceof StripeResolveError || e instanceof CoinbaseResolveError) {
    switch (e.kind) {
      case 'invalid_url':
        return err(400, 'unsupported_url', 'URL is not a supported payment link')
      case 'unsupported':
        return err(422, 'non_usd', 'only USD invoices can be paid with UPI')
      case 'expired':
        return err(410, 'expired', 'the invoice no longer exists or has expired')
      default:
        return err(502, 'upstream_error', 'the invoice provider could not be reached')
    }
  }
  return err(502, 'upstream_error', 'the invoice provider could not be reached')
}

export async function handleUpiResolve(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return err(405, 'method_not_allowed', 'POST only')
  const unauthorized = checkInternalKey(request, env)
  if (unauthorized) return unauthorized

  let body: { pay_url?: unknown }
  try {
    body = (await request.json()) as { pay_url?: unknown }
  } catch {
    return err(400, 'invalid_body', 'body must be JSON { pay_url }')
  }
  if (!body || typeof body.pay_url !== 'string') {
    return err(400, 'invalid_body', 'pay_url is required')
  }
  const classified = classifyUpiUrl(body.pay_url)
  if (!classified) {
    return err(400, 'unsupported_url', 'URL is not a supported payment link')
  }

  const now = Date.now()
  let live: LiveInvoice
  try {
    live = await fetchLiveInvoice(
      classified.provider,
      classified.invoiceKey ?? '',
      classified.payUrl,
      now,
    )
  } catch (e) {
    return mapResolveError(e)
  }
  const inv = live.normalized
  if (inv.fiatCurrency !== 'usd') {
    return err(422, 'non_usd', 'only USD invoices can be paid with UPI')
  }
  const invoiceKey = inv.invoiceKey
  const provider = classified.provider

  // Payability for the UPI channel = provider payable AND not terminal AND
  // enough validity left AND the provider is switched on for UPI.
  let payable = inv.payable
  let reason: string | null = inv.payable ? null : (inv.payableReason ?? 'not_payable')
  if (payable && live.terminal !== null) {
    payable = false
    reason = 'already_paid'
  }
  if (payable && inv.validBefore) {
    const expMs = Date.parse(inv.validBefore)
    if (!Number.isFinite(expMs)) {
      payable = false
      reason = 'expiry_unverifiable'
    } else if (expMs - now < minValidityMs(env)) {
      payable = false
      reason = expMs <= now ? 'expired' : 'expires_too_soon'
    }
  }
  if (payable && !providersEnabled(env).has(provider)) {
    payable = false
    reason = 'provider_disabled'
  }
  if (payable && inv.stablecoinAmountAtomic === '0') {
    payable = false
    reason = 'zero_amount'
  }

  const baseAmountMinor = inv.fiatAmountMinor
  const quoteId = await computeQuoteId(
    env.UPI_INTERNAL_KEY as string,
    provider,
    invoiceKey,
    baseAmountMinor,
    inv.validBefore,
  )

  // Persist the quote so verified-pay-in can re-derive the same values and,
  // for Stripe, recover the (sealed) pay URL it needs to execute.
  if (payable) {
    let payUrlEncrypted: string | null = null
    if (provider === 'stripe_crypto') {
      try {
        payUrlEncrypted = await encryptCapability(classified.payUrl, env)
      } catch {
        payable = false
        reason = 'capability_encryption_unavailable'
      }
    }
    if (payable) {
      const quote: QuoteRecord = {
        provider,
        invoiceKey,
        quoteId,
        baseAmountMinor,
        expiresAt: inv.validBefore,
        merchant: inv.merchantTitle,
        payUrlEncrypted,
        createdAt: new Date(now).toISOString(),
      }
      await env.MPP_STORE.put(quoteKey(provider, invoiceKey), JSON.stringify(quote), {
        expirationTtl: QUOTE_TTL_S,
      })
    }
  }

  const out: UpiResolution = {
    provider,
    invoice_key: invoiceKey,
    merchant: inv.merchantTitle,
    base_amount_minor: Number(baseAmountMinor),
    currency: 'USD',
    payable,
    reason,
    expires_at: inv.validBefore,
    quote_id: quoteId,
  }
  return json(200, out)
}

// ── POST /api/invoice/verified-pay-in ───────────────────────────────────────

interface VerifiedPayInBody {
  order_id: string
  provider: UpiProvider
  invoice_key: string
  quote_id: string
  base_amount_minor: number
  razorpay_order_id: string
  razorpay_payment_id: string
  captured_at: string
}

function parseVerifiedPayInBody(raw: string): VerifiedPayInBody | string {
  let b: Record<string, unknown>
  try {
    b = JSON.parse(raw)
  } catch {
    return 'body is not JSON'
  }
  if (!b || typeof b !== 'object') return 'body must be an object'
  const s = (k: string) => (typeof b[k] === 'string' && (b[k] as string).length > 0 ? (b[k] as string) : null)
  const orderId = s('order_id')
  if (!orderId || !UUID_RE.test(orderId)) return 'order_id must be a UUID'
  const provider = s('provider')
  if (!provider || !UPI_PROVIDERS.has(provider)) return 'provider must be coinbase_v1|coinbase_v3|stripe_crypto'
  const invoiceKey = s('invoice_key')
  if (!invoiceKey || invoiceKey.length > 200 || !/^[A-Za-z0-9_-]+$/.test(invoiceKey)) {
    return 'invoice_key is invalid'
  }
  const quoteId = s('quote_id')
  if (!quoteId || !/^[0-9a-f]{64}$/.test(quoteId)) return 'quote_id is invalid'
  const amt = b.base_amount_minor
  if (typeof amt !== 'number' || !Number.isSafeInteger(amt) || amt <= 0) {
    return 'base_amount_minor must be a positive integer'
  }
  const rzpOrder = s('razorpay_order_id')
  const rzpPayment = s('razorpay_payment_id')
  const capturedAt = s('captured_at')
  if (!rzpOrder || !rzpPayment || !capturedAt) {
    return 'razorpay_order_id, razorpay_payment_id and captured_at are required'
  }
  return {
    order_id: orderId,
    provider: provider as UpiProvider,
    invoice_key: invoiceKey,
    quote_id: quoteId,
    base_amount_minor: amt,
    razorpay_order_id: rzpOrder,
    razorpay_payment_id: rzpPayment,
    captured_at: capturedAt,
  }
}

export interface VerifiedPayInOptions {
  // When present, execution runs in the background and the 202 returns
  // `processing`; tests omit it so execution is awaited.
  ctx?: ExecutionContext
  now?: () => number
}

export async function handleUpiVerifiedPayIn(
  request: Request,
  env: Env,
  opts: VerifiedPayInOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') return err(405, 'method_not_allowed', 'POST only')
  const unauthorized = checkInternalKey(request, env)
  if (unauthorized) return unauthorized
  const secret = env.UPI_INTERNAL_KEY as string

  // 1. Raw body first — the signature covers the bytes as received.
  const rawBody = await request.text()
  const sigHeader = (request.headers.get('x-signature') ?? '').trim().replace(/^sha256=/i, '')
  if (!/^[0-9a-f]{64}$/i.test(sigHeader)) {
    return err(401, 'invalid_signature', 'X-Signature must be hex HMAC-SHA256 of the raw body')
  }
  const expectedSig = await hmacSha256Hex(secret, rawBody)
  if (!timingSafeEqual(expectedSig, sigHeader.toLowerCase())) {
    return err(401, 'invalid_signature', 'X-Signature does not match the body')
  }

  // 2. Parse + idempotency-key binding.
  const parsed = parseVerifiedPayInBody(rawBody)
  if (typeof parsed === 'string') return err(400, 'invalid_body', parsed)
  const body = parsed
  const idem = request.headers.get('x-idempotency-key') ?? ''
  if (idem !== body.order_id) {
    return err(400, 'idempotency_key_mismatch', 'X-Idempotency-Key must equal order_id')
  }
  const bodyHash = await sha256Hex(rawBody)

  // 3. Replay check. Same order + same bytes → the current record; same order
  //    + different bytes → 409. Checked again inside the create CAS below.
  const existing = await loadFulfillment(env, body.order_id)
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      return err(409, 'order_body_mismatch', 'order_id was already submitted with a different body')
    }
    return json(202, { fulfillment_id: existing.orderId, state: existing.state })
  }

  // 4. Verify the quote against LIVE provider data (design §10-5: re-check
  //    amount and validity right before fulfilment).
  const nowMs = (opts.now ?? Date.now)()
  const quote = await loadQuote(env, body.provider, body.invoice_key)
  let payUrl: string | null = null
  if (body.provider === 'stripe_crypto') {
    if (!quote?.payUrlEncrypted) {
      return err(422, 'quote_unknown', 'no resolve quote on file for this Stripe invoice')
    }
    try {
      payUrl = await decryptCapability(quote.payUrlEncrypted, env)
    } catch {
      return err(503, 'capability_unavailable', 'stored invoice capability could not be opened')
    }
  }
  let live: LiveInvoice
  try {
    live = await fetchLiveInvoice(body.provider, body.invoice_key, payUrl, nowMs)
  } catch (e) {
    // Provider unreachable / gone: nothing claimed, nothing paid. MuggleLink
    // may retry (same body) later.
    return mapResolveError(e)
  }
  const inv = live.normalized
  if (inv.invoiceKey !== body.invoice_key) {
    return err(422, 'invalid_quote', 'invoice_key does not match the provider')
  }
  const quoteFromBody = await computeQuoteId(
    secret,
    body.provider,
    body.invoice_key,
    body.base_amount_minor,
    inv.validBefore,
  )
  if (!timingSafeEqual(quoteFromBody, body.quote_id)) {
    // Either a forged/stale quote_id, or expires_at moved. Both mean the
    // caller is not holding a quote we issued for these values.
    return err(422, 'invalid_quote', 'quote_id does not verify for the given provider/invoice/amount')
  }

  // Everything from here is "money was captured; we owe an outcome". Failures
  // become a persisted `failed` record (202) so MuggleLink takes the refund
  // path, not an ad-hoc 4xx it cannot act on.
  let preFail: { reason: string; providerFinalState: string | null } | null = null
  if (inv.fiatAmountMinor !== String(body.base_amount_minor)) {
    preFail = { reason: 'invoice_changed', providerFinalState: inv.state }
  } else if (live.terminal === 'success') {
    preFail = { reason: 'already_paid', providerFinalState: inv.state }
  } else if (!inv.payable) {
    preFail = { reason: inv.payableReason ?? 'not_payable', providerFinalState: inv.state }
  } else if (!providersEnabled(env).has(body.provider)) {
    preFail = { reason: 'provider_disabled', providerFinalState: inv.state }
  }

  // 5. Create the fulfillment record — CAS insert; a concurrent duplicate loses
  //    the insert and is answered as a replay/mismatch exactly like step 3.
  const nowIso = new Date(nowMs).toISOString()
  const fresh: UpiFulfillmentRecord = {
    orderId: body.order_id,
    provider: body.provider,
    invoiceKey: body.invoice_key,
    bodyHash,
    baseAmountMinor: inv.fiatAmountMinor,
    stablecoinAmountAtomic: inv.stablecoinAmountAtomic,
    state: 'queued',
    providerFinalState: null,
    executionRef: null,
    failureReason: null,
    razorpayPaymentId: body.razorpay_payment_id,
    createdAt: nowIso,
    updatedAt: nowIso,
    events: [{ kind: 'verified_pay_in_received', at: nowIso }],
  }
  const created = await casUpdate<
    { kind: 'created' } | { kind: 'replay'; rec: UpiFulfillmentRecord } | { kind: 'mismatch' }
  >(env, fulfillmentKey(body.order_id), (raw) => {
    const cur = parseFulfillment(raw)
    if (cur) {
      return { op: 'noop', result: cur.bodyHash === bodyHash ? { kind: 'replay', rec: cur } : { kind: 'mismatch' } }
    }
    return { op: 'set', value: JSON.stringify(fresh), result: { kind: 'created' } }
  })
  if (created.kind === 'mismatch') {
    return err(409, 'order_body_mismatch', 'order_id was already submitted with a different body')
  }
  if (created.kind === 'replay') {
    return json(202, { fulfillment_id: created.rec.orderId, state: created.rec.state })
  }

  if (preFail) {
    await transition(env, body.order_id, 'failed', {
      kind: 'precheck_failed',
      failureReason: preFail.reason,
      providerFinalState: preFail.providerFinalState,
    })
    return json(202, { fulfillment_id: body.order_id, state: 'failed' })
  }

  // 6. Cross-channel claim (linearizable). Another channel already holds this
  //    invoice → 409 and a `failed` record: MuggleLink refunds the UPI capture.
  const claim = await claimInvoiceKey(env, body.invoice_key, 'upi', body.order_id, new Date(nowMs))
  if (!claim.ok) {
    await transition(env, body.order_id, 'failed', {
      kind: 'claim_refused',
      failureReason: 'claimed_by_other_channel',
      extra: { holder_channel: claim.holder.channel },
    })
    return json(409, {
      error: 'already_claimed',
      message: `invoice is already being settled by the ${claim.holder.channel} channel`,
      fulfillment_id: body.order_id,
      state: 'failed',
    })
  }

  // 7. Execute through the existing executor for the provider.
  await transition(env, body.order_id, 'processing', { kind: 'execution_started' })
  const run = executeFulfillment(env, body.order_id, body.provider, body.invoice_key, inv, payUrl)
  if (opts.ctx) {
    opts.ctx.waitUntil(run.catch((e) => console.error('[upi] execution error', e instanceof Error ? e.message : String(e))))
    return json(202, { fulfillment_id: body.order_id, state: 'processing' })
  }
  await run
  const after = await loadFulfillment(env, body.order_id)
  return json(202, { fulfillment_id: body.order_id, state: after?.state ?? 'processing' })
}

// ── Execution ───────────────────────────────────────────────────────────────

function pickExecutionRef(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  for (const k of ['txHash', 'transactionHash', 'tx_hash', 'paymentId', 'id']) {
    const v = b[k]
    if (typeof v === 'string' && v.length > 0 && v.length <= 128) return v
  }
  return null
}

async function executeFulfillment(
  env: Env,
  orderId: string,
  provider: UpiProvider,
  invoiceKey: string,
  inv: NormalizedInvoice,
  payUrl: string | null,
): Promise<void> {
  const invoiceAtomic = BigInt(inv.stablecoinAmountAtomic)
  const now = new Date()

  // Wallet inventory gate — identical to the crypto webhook: real balance minus
  // the shared reserved counter. An unreadable balance attempts anyway because
  // the executor re-checks the funder as the final gate.
  const balanceResult = await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)
  const balance = balanceResult.balance
  if (balance !== null) {
    const reserved = await reservedAtomic(env)
    const available = balance - reserved
    if (available < invoiceAtomic) {
      await transition(env, orderId, 'failed', {
        kind: 'insufficient_funder_balance',
        failureReason: 'insufficient_funder_balance',
        extra: { balance: balance.toString(), reserved: reserved.toString(), invoice: invoiceAtomic.toString() },
      })
      await sendInvoiceFailureAlert(env, {
        kind: 'failed_insufficient_balance',
        plId: `${invoiceKey} (UPI order ${orderId})`,
        invoiceAtomic,
        funderBalanceAtomic: balance,
        availableAtomic: available,
        failureReason: 'UPI captured but funder cannot cover the invoice',
      })
      return
    }
  }

  await bumpReserved(env, invoiceAtomic)
  try {
    if (provider === 'stripe_crypto') {
      await executeStripe(env, orderId, inv, payUrl, invoiceAtomic, now)
    } else {
      await executeCoinbase(env, orderId, invoiceKey, inv)
    }
  } finally {
    await bumpReserved(env, -invoiceAtomic)
  }
}

async function executeCoinbase(
  env: Env,
  orderId: string,
  invoiceKey: string,
  inv: NormalizedInvoice,
): Promise<void> {
  let result: { ok: boolean; status: number; body: unknown }
  try {
    result = await callAgentApiPayInvoice(env, invoiceKey)
  } catch {
    // Transport failure: the executor MAY have paid. Ambiguous → unknown.
    await transition(env, orderId, 'unknown', {
      kind: 'executor_ambiguous',
      failureReason: 'executor transport error',
    })
    return
  }
  if (result.ok) {
    await transition(env, orderId, 'processing', {
      kind: 'executor_accepted',
      executionRef: pickExecutionRef(result.body),
      extra: { status: result.status },
    })
    // Confirm against the provider right away when possible; the status
    // endpoint repeats this on every poll.
    await confirmWithProvider(env, orderId)
    return
  }
  if (result.status >= 500 || result.status === 0) {
    await transition(env, orderId, 'unknown', {
      kind: 'executor_ambiguous',
      failureReason: `executor status ${result.status}`,
    })
    return
  }
  await transition(env, orderId, 'failed', {
    kind: 'executor_rejected',
    failureReason: `executor status ${result.status}`,
    extra: { status: result.status },
  })
  await sendInvoiceFailureAlert(env, {
    kind: 'failed_pay_invoice',
    plId: `${invoiceKey} (UPI order ${orderId})`,
    invoiceAtomic: BigInt(inv.stablecoinAmountAtomic),
    funderBalanceAtomic: null,
    failureReason: `UPI captured but pay-invoice returned ${result.status}`,
  })
}

async function executeStripe(
  env: Env,
  orderId: string,
  inv: NormalizedInvoice,
  payUrl: string | null,
  invoiceAtomic: bigint,
  now: Date,
): Promise<void> {
  if (!payUrl || !inv.merchantAccount) {
    await transition(env, orderId, 'failed', {
      kind: 'missing_lock_binding',
      failureReason: 'missing pay url or merchant account',
    })
    return
  }
  const spentBefore = await reserveDailySpend(env, now, invoiceAtomic)
  if (spentBefore === null) {
    await transition(env, orderId, 'failed', {
      kind: 'daily_cap_reached',
      failureReason: 'daily_cap_reached',
    })
    return
  }
  const result = await callStripePayInvoice(env, {
    stripeUrl: payUrl,
    expectedMerchantAccount: inv.merchantAccount,
    expectedAmountAtomic: inv.stablecoinAmountAtomic,
    spentTodayAtomic: spentBefore.toString(),
  })
  if (result.ambiguous) {
    // Keep the daily reservation (spend may have happened). Never re-pay.
    await transition(env, orderId, 'unknown', {
      kind: 'executor_ambiguous',
      failureReason: `executor status ${result.status}`,
    })
    return
  }
  if (result.disabled) {
    await releaseDailySpend(env, now, invoiceAtomic)
    await transition(env, orderId, 'failed', {
      kind: 'executor_disabled',
      failureReason: 'stripe_fulfillment_disabled',
      providerFinalState: inv.state,
    })
    return
  }
  if (result.ok) {
    await transition(env, orderId, 'processing', {
      kind: 'executor_accepted',
      executionRef: pickExecutionRef(result.body),
      extra: { status: result.status },
    })
    return
  }
  await releaseDailySpend(env, now, invoiceAtomic)
  await transition(env, orderId, 'failed', {
    kind: 'executor_rejected',
    failureReason: `executor status ${result.status}`,
  })
}

// ── Provider confirmation (never pays; only observes) ───────────────────────

/**
 * Ask the provider for the invoice's current state and advance the record:
 *   terminal success → paid; terminal failure → failed; otherwise unchanged,
 *   except that a stale `processing` becomes `unknown`.
 */
export async function confirmWithProvider(
  env: Env,
  orderId: string,
  nowMs: number = Date.now(),
): Promise<UpiFulfillmentRecord | null> {
  const rec = await loadFulfillment(env, orderId)
  if (!rec) return null
  if (TERMINAL_STATES.has(rec.state)) return rec

  let payUrl: string | null = null
  if (rec.provider === 'stripe_crypto') {
    const quote = await loadQuote(env, rec.provider, rec.invoiceKey)
    if (quote?.payUrlEncrypted) {
      try {
        payUrl = await decryptCapability(quote.payUrlEncrypted, env)
      } catch {
        payUrl = null
      }
    }
    if (!payUrl) return rec // cannot observe; leave as is
  }
  let live: LiveInvoice
  try {
    live = await fetchLiveInvoice(rec.provider, rec.invoiceKey, payUrl, nowMs)
  } catch {
    return rec
  }
  if (live.terminal === 'success') {
    return (await transition(env, orderId, 'paid', {
      kind: 'provider_confirmed',
      providerFinalState: live.normalized.state,
    })) ?? rec
  }
  if (live.terminal === 'failure') {
    return (await transition(env, orderId, 'failed', {
      kind: 'provider_failed',
      providerFinalState: live.normalized.state,
      failureReason: 'provider_terminal_failure',
    })) ?? rec
  }
  const updatedMs = Date.parse(rec.updatedAt)
  if (rec.state === 'processing' && Number.isFinite(updatedMs) && nowMs - updatedMs > PROCESSING_STALE_MS) {
    return (await transition(env, orderId, 'unknown', {
      kind: 'processing_stale',
      providerFinalState: live.normalized.state,
      failureReason: 'no provider confirmation after executor accepted',
    })) ?? rec
  }
  // Record the last observed provider state without changing ours.
  return (await updateFulfillment(env, orderId, (r) => {
    r.providerFinalState = live.normalized.state
  })) ?? rec
}

// ── GET /api/invoice/fulfillment/:order_id ──────────────────────────────────

export async function handleUpiFulfillmentStatus(
  request: Request,
  env: Env,
  orderId: string,
): Promise<Response> {
  if (request.method !== 'GET') return err(405, 'method_not_allowed', 'GET only')
  const unauthorized = checkInternalKey(request, env)
  if (unauthorized) return unauthorized
  if (!UUID_RE.test(orderId)) return err(400, 'invalid_order_id', 'order_id must be a UUID')

  const rec = await loadFulfillment(env, orderId)
  if (!rec) return err(404, 'not_found', 'no fulfillment for this order_id')
  const fresh = (await confirmWithProvider(env, orderId)) ?? rec
  return json(200, statusPayload(fresh))
}
