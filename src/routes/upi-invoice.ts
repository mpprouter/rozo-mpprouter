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
//   POST /api/invoice/verified-funding       (v2, UPI rewards; same headers)
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
  normalizeInvoiceUrl,
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
import { claimInvoiceKey, releaseInvoiceClaim } from './invoice-claim'
import {
  FUNDER_WALLET,
  callAgentApiPayInvoice,
  sendInvoiceFailureAlert,
  type PayInvoiceExpectedBinding,
} from './webhook'
import {
  callStripePayInvoice,
  reserveDailySpend,
  releaseDailySpend,
} from './stripe-fulfillment'
import { getBaseUsdcBalance } from '../utils/base-usdc-balance'
import { encryptCapability, decryptCapability } from './invoice-capability-crypto'
import { checkoutDeliveryPaused } from './checkout-control'
import {
  RewardBindingError,
  UPI_REWARD_BINDING_VERSION,
  canonicalInteger,
  rewardBindingFromCoinbase,
} from '../utils/upi-reward-binding'
import { verifyInvoiceApproval } from './upi-approval-verify'

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
  // ── verified-funding v2 only (absent on v1 records) ──
  schemaVersion?: 2
  funding?: V2FundingSummary
  cashEvidence?: V2CashEvidence | null
  executionPhase?: ExecutionPhase
  failureClass?: FailureClass
  attemptId?: string | null
  // Why a not_started v2 record is still queued (e.g. eligibility_unavailable).
  queuedReason?: string | null
  binding?: V2FrozenBinding | null
}

// v2 execution bookkeeping (design §5.4 / §6):
//   not_started → nothing was sent to the executor; only this phase can take
//                 the execution right (one atomic CAS), or a refusal barrier.
//   calling     → the executor call has been (or is being) made. A crash here
//                 is `unknown`: it is never re-called.
//   accepted    → the executor answered 2xx.
//   terminal    → a definite outcome (paid, or definite_not_paid).
export type ExecutionPhase = 'not_started' | 'calling' | 'accepted' | 'terminal'
export type FailureClass = 'pre_execution_refusal' | 'definite_not_paid' | 'ambiguous' | null

export type V2FundingKind = 'credit_only' | 'mixed' | 'cash_only'

export interface V2FundingSummary {
  kind: V2FundingKind
  grossAmountMinor: string
  creditMicro: string
  cashMinor: string
  redemptionId: string | null
  merchantApprovalId: string | null
  quoteId: string
  quoteExpiresAt: string | null
}

export interface V2CashEvidence {
  razorpayOrderId: string
  razorpayPaymentId: string
  capturedAt: string
  currency: string
  amountMinor: string
}

export interface V2FrozenBinding {
  version: typeof UPI_REWARD_BINDING_VERSION
  fingerprint: string
  amountAtomic: string
  usdCents: string
  approvalId: string | null
  approvalValidUntil: string | null
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
  // http:// on a known provider host is upgraded to https:// so the stored
  // payUrl (encrypted, later resumed by the fulfiller) is always the TLS form.
  const url = normalizeInvoiceUrl(raw.trim())
  const provider = detectProvider(url)
  if (provider === 'coinbase') {
    const id = extractCoinbaseCheckoutId(url)
    if (!id) return null
    return {
      provider: isCoinbasePaymentSessionId(id) ? 'coinbase_v3' : 'coinbase_v1',
      invoiceKey: id,
      payUrl: url,
    }
  }
  if (provider === 'stripe_crypto') {
    if (!extractStripeSessionBlob(url)) return null
    return { provider: 'stripe_crypto', invoiceKey: null, payUrl: url }
  }
  return null
}

// ── Live provider lookups ───────────────────────────────────────────────────

export interface LiveInvoice {
  normalized: NormalizedInvoice
  // Coinbase only: the raw next-api payload the normalized view came from
  // (the v2 binding fingerprint needs fields normalization drops).
  raw?: unknown
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
  return { normalized, terminal, raw: payment }
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
  const base = {
    state: rec.state,
    provider_final_state: rec.providerFinalState,
    execution_ref: rec.executionRef,
    updated_at: rec.updatedAt,
  }
  // v1 records answer exactly as before; v2 adds its execution bookkeeping.
  if (rec.schemaVersion !== 2) return base
  return { ...base, ...v2Fields(rec) }
}

function v2Reason(rec: UpiFulfillmentRecord): string | null {
  if (rec.state === 'queued') return rec.queuedReason ?? null
  return rec.failureReason
}

function v2Fields(rec: UpiFulfillmentRecord) {
  return {
    schema_version: 2 as const,
    execution_phase: rec.executionPhase ?? 'not_started',
    failure_class: rec.failureClass ?? null,
    funding_kind: rec.funding?.kind ?? null,
    reason: v2Reason(rec),
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

/**
 * Read the raw body and verify X-Signature = hex HMAC-SHA256(key, rawBody).
 * Shared by verified-pay-in (v1) and verified-funding (v2); responses are the
 * v1 ones, unchanged.
 */
async function readSignedBody(request: Request, secret: string): Promise<{ rawBody: string } | Response> {
  const rawBody = await request.text()
  const sigHeader = (request.headers.get('x-signature') ?? '').trim().replace(/^sha256=/i, '')
  if (!/^[0-9a-f]{64}$/i.test(sigHeader)) {
    return err(401, 'invalid_signature', 'X-Signature must be hex HMAC-SHA256 of the raw body')
  }
  const expectedSig = await hmacSha256Hex(secret, rawBody)
  if (!timingSafeEqual(expectedSig, sigHeader.toLowerCase())) {
    return err(401, 'invalid_signature', 'X-Signature does not match the body')
  }
  return { rawBody }
}

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
  const signed = await readSignedBody(request, secret)
  if (signed instanceof Response) return signed
  const rawBody = signed.rawBody

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

  // 3b. Checkout emergency stop (checkout-control.ts): refuse before any record
  //     or claim exists, so the caller can resubmit the same order later.
  if (await checkoutDeliveryPaused(env)) {
    return err(503, 'checkout_paused', 'checkout delivery is paused; nothing was recorded, resubmit later')
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

  // A stop that landed after the entry check: nothing was sent, so this is a
  // definite refusal (the caller refunds the UPI capture), never `unknown`.
  if (await checkoutDeliveryPaused(env)) {
    await transition(env, orderId, 'failed', {
      kind: 'checkout_paused',
      failureReason: 'checkout_paused',
    })
    return
  }

  // Wallet inventory gate — identical to the crypto webhook: the funder's real
  // on-chain balance (the shared reservation counter was removed 2026-09-26).
  // An unreadable balance attempts anyway because the executor re-checks the
  // funder as the final gate.
  const balanceResult = await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)
  const balance = balanceResult.balance
  if (balance !== null) {
    if (balance < invoiceAtomic) {
      await transition(env, orderId, 'failed', {
        kind: 'insufficient_funder_balance',
        failureReason: 'insufficient_funder_balance',
        extra: { balance: balance.toString(), invoice: invoiceAtomic.toString() },
      })
      await sendInvoiceFailureAlert(env, {
        kind: 'failed_insufficient_balance',
        plId: `${invoiceKey} (UPI order ${orderId})`,
        invoiceAtomic,
        funderBalanceAtomic: balance,
        failureReason: 'UPI captured but funder cannot cover the invoice',
      })
      return
    }
  }

  if (provider === 'stripe_crypto') {
    await executeStripe(env, orderId, inv, payUrl, invoiceAtomic, now)
  } else {
    await executeCoinbase(env, orderId, invoiceKey, inv)
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
  if (rec.schemaVersion === 2) return confirmV2WithProvider(env, rec, nowMs)

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
  // `queued` means the record exists but execution never started (the
  // executor was not called), so a provider success here is someone else's
  // payment and can never be attributed to this order.
  if (rec.state === 'queued') {
    const createdMs = Date.parse(rec.createdAt)
    if (live.terminal === 'success') {
      return (await transition(env, orderId, 'failed', {
        kind: 'paid_by_other_party',
        providerFinalState: live.normalized.state,
        failureReason: 'invoice settled before this order executed',
      })) ?? rec
    }
    if (Number.isFinite(createdMs) && nowMs - createdMs > PROCESSING_STALE_MS) {
      return (await transition(env, orderId, 'failed', {
        kind: 'never_executed',
        providerFinalState: live.normalized.state,
        failureReason: 'execution never started',
      })) ?? rec
    }
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

// ── POST /api/invoice/verified-funding (v2, UPI rewards) ────────────────────
//
// Same internal protocol as verified-pay-in (X-Internal-Key, X-Signature =
// HMAC of the raw body, X-Idempotency-Key = order_id, raw-body hash replay
// check) and the same records, claim (`invoice-claim:v1:<invoice_key>`),
// wallet gate and executor. What v2 adds (design §5.4, §6, §6.1):
//   - a funding summary (credit_micro / cash_minor) instead of "cash captured"
//   - a merchant approval check against MuggleLink for any credit spend
//   - the upi-reward-binding-v1 fingerprint, recomputed from the LIVE payload,
//     frozen on the record and passed to the signer as expected_binding
//   - persistent execution_phase / failure_class / attempt_id, so a refusal is
//     a durable barrier and a crash after the call is never re-called
// Credit eligibility is Coinbase v1/v3 only; Stripe stays on verified-pay-in.

const V2_PROVIDERS: ReadonlySet<string> = new Set(['coinbase_v1', 'coinbase_v3'])
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

interface VerifiedFundingBody {
  order_id: string
  provider: 'coinbase_v1' | 'coinbase_v3'
  invoice_key: string
  quote_id: string
  quote_expires_at: string | null
  base_amount_minor: bigint
  gross_amount_minor: bigint
  credit_micro: bigint
  cash_minor: bigint
  redemption_id: string | null
  merchant_approval_id: string | null
  cash_payment: {
    razorpay_order_id: string
    razorpay_payment_id: string
    captured_at: string
    currency: string
    amount_minor: bigint
  } | null
  kind: V2FundingKind
}

function intOf(v: unknown, label: string, allowZero: boolean): bigint {
  // Throws RewardBindingError on anything but a canonical integer.
  return BigInt(canonicalInteger(v, label, allowZero))
}

export function parseVerifiedFundingBody(raw: string): VerifiedFundingBody | string {
  let b: Record<string, unknown>
  try {
    b = JSON.parse(raw)
  } catch {
    return 'body is not JSON'
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be an object'
  if (b.schema_version !== 2) return 'schema_version must be 2'
  const str = (o: Record<string, unknown>, k: string) =>
    typeof o[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : null
  const orderId = str(b, 'order_id')
  if (!orderId || !UUID_RE.test(orderId)) return 'order_id must be a UUID'
  const provider = str(b, 'provider')
  if (!provider || !V2_PROVIDERS.has(provider)) return 'provider must be coinbase_v1|coinbase_v3'
  const invoiceKey = str(b, 'invoice_key')
  if (!invoiceKey || invoiceKey.length > 200 || !/^[A-Za-z0-9_-]+$/.test(invoiceKey)) return 'invoice_key is invalid'
  const quoteId = str(b, 'quote_id')
  if (!quoteId || !/^[0-9a-f]{64}$/.test(quoteId)) return 'quote_id is invalid'
  let quoteExpiresAt: string | null = null
  if (b.quote_expires_at !== null) {
    quoteExpiresAt = str(b, 'quote_expires_at')
    if (!quoteExpiresAt || !Number.isFinite(Date.parse(quoteExpiresAt))) return 'quote_expires_at must be an ISO timestamp or null'
  }
  const f = b.funding as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'funding is required'
  let base: bigint, gross: bigint, credit: bigint, cash: bigint
  try {
    base = intOf(b.base_amount_minor, 'base_amount_minor', false)
    gross = intOf(b.gross_amount_minor, 'gross_amount_minor', false)
    credit = intOf(f.credit_micro, 'funding.credit_micro', true)
    cash = intOf(f.cash_minor, 'funding.cash_minor', true)
  } catch (e) {
    return e instanceof RewardBindingError ? e.message : 'amounts must be integers'
  }
  if (gross < base) return 'gross_amount_minor must be >= base_amount_minor'
  if (gross * 10_000n !== cash * 10_000n + credit) {
    return 'gross_amount_minor * 10000 must equal cash_minor * 10000 + credit_micro'
  }
  const optId = (k: string): string | null | false => {
    if (f[k] === null || f[k] === undefined) return null
    return typeof f[k] === 'string' && ID_RE.test(f[k] as string) ? (f[k] as string) : false
  }
  const redemptionId = optId('redemption_id')
  const approvalId = optId('merchant_approval_id')
  if (redemptionId === false || approvalId === false) return 'funding ids are malformed'
  if (credit > 0n && (!redemptionId || !approvalId)) {
    return 'credit funding requires redemption_id and merchant_approval_id'
  }
  let cashPayment: VerifiedFundingBody['cash_payment'] = null
  if (cash === 0n) {
    if (b.cash_payment !== null) return 'cash_payment must be null when cash_minor is 0'
    if (credit <= 0n) return 'a zero-cash order must carry credit'
  } else {
    const c = b.cash_payment as Record<string, unknown> | null | undefined
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'cash_payment is required when cash_minor > 0'
    const rzpOrder = str(c, 'razorpay_order_id')
    const rzpPayment = str(c, 'razorpay_payment_id')
    const capturedAt = str(c, 'captured_at')
    const currency = str(c, 'currency')
    if (!rzpOrder || !rzpPayment || !capturedAt || !currency) return 'cash_payment fields are required'
    if (!/^[A-Z]{3}$/.test(currency)) return 'cash_payment.currency must be an ISO 4217 code'
    let amount: bigint
    try {
      amount = intOf(c.amount_minor, 'cash_payment.amount_minor', false)
    } catch (e) {
      return e instanceof RewardBindingError ? e.message : 'cash_payment.amount_minor must be an integer'
    }
    // A USD capture must equal the fixed cash share exactly. Other currencies
    // are provider minor units and are vouched for by MuggleLink's ledger RPC.
    if (currency === 'USD' && amount !== cash) return 'cash_payment.amount_minor does not match cash_minor'
    cashPayment = {
      razorpay_order_id: rzpOrder,
      razorpay_payment_id: rzpPayment,
      captured_at: capturedAt,
      currency,
      amount_minor: amount,
    }
  }
  return {
    order_id: orderId,
    provider: provider as VerifiedFundingBody['provider'],
    invoice_key: invoiceKey,
    quote_id: quoteId,
    quote_expires_at: quoteExpiresAt,
    base_amount_minor: base,
    gross_amount_minor: gross,
    credit_micro: credit,
    cash_minor: cash,
    redemption_id: redemptionId,
    merchant_approval_id: approvalId,
    cash_payment: cashPayment,
    kind: credit > 0n ? (cash > 0n ? 'mixed' : 'credit_only') : 'cash_only',
  }
}

/** A v2 record that has not entered the executor and carries no outcome. */
function isV2Open(rec: UpiFulfillmentRecord): boolean {
  return (
    rec.schemaVersion === 2 &&
    rec.state === 'queued' &&
    (rec.executionPhase ?? 'not_started') === 'not_started' &&
    (rec.failureClass ?? null) === null
  )
}

/** Guarded CAS on a record: `fn` returns false (and must not mutate) to skip. */
async function casV2(
  env: Env,
  orderId: string,
  fn: (rec: UpiFulfillmentRecord) => boolean,
): Promise<{ applied: boolean; rec: UpiFulfillmentRecord }> {
  const out = await casUpdate<{ applied: boolean; rec: UpiFulfillmentRecord | null }>(
    env,
    fulfillmentKey(orderId),
    (raw) => {
      const rec = parseFulfillment(raw)
      if (!rec || !fn(rec)) return { op: 'noop', result: { applied: false, rec: parseFulfillment(raw) } }
      rec.updatedAt = new Date().toISOString()
      return { op: 'set', value: JSON.stringify(rec), result: { applied: true, rec } }
    },
  )
  if (!out.rec) throw new Error(`upi fulfillment ${orderId} disappeared`)
  return out as { applied: boolean; rec: UpiFulfillmentRecord }
}

/**
 * Persistent pre-execution refusal barrier. Only an open (not_started) record
 * can take it, through the same CAS that grants the execution right, so a
 * record that may have executed can never be relabelled "not executed".
 */
async function v2Refuse(
  env: Env,
  orderId: string,
  code: string,
  detail: { providerFinalState?: string | null; extra?: unknown } = {},
): Promise<{ applied: boolean; rec: UpiFulfillmentRecord }> {
  return casV2(env, orderId, (r) => {
    if (!isV2Open(r)) return false
    r.state = 'failed'
    r.executionPhase = 'not_started'
    r.failureClass = 'pre_execution_refusal'
    r.failureReason = code
    r.queuedReason = null
    if (detail.providerFinalState !== undefined) r.providerFinalState = detail.providerFinalState
    r.events.push({ kind: 'pre_execution_refusal', at: new Date().toISOString(), detail: { code, ...(detail.extra ? { extra: detail.extra } : {}) } })
    return true
  })
}

/** Keep an open record queued with a reason (nothing executed, nothing released). */
async function v2Queue(env: Env, orderId: string, reason: string, extra?: unknown): Promise<UpiFulfillmentRecord> {
  const { rec } = await casV2(env, orderId, (r) => {
    if (!isV2Open(r)) return false
    r.queuedReason = reason
    r.events.push({ kind: 'queued', at: new Date().toISOString(), detail: { reason, ...(extra ? { extra } : {}) } })
    return true
  })
  return rec
}

function v2Response(rec: UpiFulfillmentRecord): Response {
  const fields = { fulfillment_id: rec.orderId, state: rec.state, ...v2Fields(rec) }
  if (rec.state === 'failed' && rec.failureClass === 'pre_execution_refusal') {
    if (rec.failureReason === 'already_claimed') {
      return json(409, {
        error: 'already_claimed',
        message: 'invoice is already being settled by another channel',
        ...fields,
      })
    }
    return json(422, {
      error: rec.failureReason ?? 'refused',
      message: 'refused before execution; this order will never execute',
      ...fields,
    })
  }
  return json(202, fields)
}

type V2Gate =
  | { kind: 'ok'; inv: NormalizedInvoice; binding: V2FrozenBinding }
  | { kind: 'refuse'; code: string; providerFinalState?: string | null; extra?: unknown }
  | { kind: 'unavailable'; reason: string; extra?: unknown }

/**
 * Re-resolve the live invoice and decide whether this order may proceed.
 * Run before the claim and again right before the executor call. Never
 * executes anything; a transient failure is `unavailable`, not a refusal.
 */
async function v2Gate(
  env: Env,
  body: VerifiedFundingBody,
  frozen: V2FrozenBinding | null | undefined,
  nowMs: number,
): Promise<V2Gate> {
  let live: LiveInvoice
  try {
    live = await fetchLiveInvoice(body.provider, body.invoice_key, null, nowMs)
  } catch (e) {
    if (e instanceof CoinbaseResolveError && e.kind === 'expired') return { kind: 'refuse', code: 'invoice_gone' }
    if (e instanceof CoinbaseResolveError && e.kind === 'unsupported') return { kind: 'refuse', code: 'non_usd' }
    return { kind: 'unavailable', reason: 'provider_unavailable' }
  }
  const inv = live.normalized
  const pfs = inv.state
  if (inv.invoiceKey !== body.invoice_key) return { kind: 'refuse', code: 'invalid_quote', providerFinalState: pfs }
  const quote = await computeQuoteId(
    env.UPI_INTERNAL_KEY as string,
    body.provider,
    body.invoice_key,
    body.base_amount_minor.toString(),
    inv.validBefore,
  )
  const sameExpiry =
    body.quote_expires_at === null
      ? inv.validBefore === null
      : inv.validBefore !== null && Date.parse(body.quote_expires_at) === Date.parse(inv.validBefore)
  if (!timingSafeEqual(quote, body.quote_id) || !sameExpiry) {
    return { kind: 'refuse', code: 'invalid_quote', providerFinalState: pfs }
  }
  if (inv.fiatAmountMinor !== body.base_amount_minor.toString()) {
    return { kind: 'refuse', code: 'invoice_changed', providerFinalState: pfs }
  }
  if (live.terminal === 'success') return { kind: 'refuse', code: 'already_paid', providerFinalState: pfs }
  if (!inv.payable) {
    return { kind: 'refuse', code: 'not_payable', providerFinalState: pfs, extra: { reason: inv.payableReason } }
  }
  if (!providersEnabled(env).has(body.provider)) return { kind: 'refuse', code: 'provider_disabled', providerFinalState: pfs }

  let b
  try {
    b = await rewardBindingFromCoinbase(live.raw)
  } catch (e) {
    if (e instanceof RewardBindingError) {
      return { kind: 'refuse', code: 'binding_invalid', providerFinalState: pfs, extra: { code: e.code } }
    }
    throw e
  }
  if (
    b.provider_family !== body.provider ||
    b.invoice_key !== body.invoice_key ||
    b.usd_cents !== inv.fiatAmountMinor ||
    b.usdc_atomic !== inv.stablecoinAmountAtomic
  ) {
    return { kind: 'refuse', code: 'binding_invalid', providerFinalState: pfs }
  }
  if (frozen && frozen.fingerprint !== b.fingerprint) {
    return { kind: 'refuse', code: 'binding_changed', providerFinalState: pfs }
  }

  let approvalValidUntil: string | null = null
  if (body.credit_micro > 0n) {
    const a = await verifyInvoiceApproval(
      env,
      {
        approval_id: body.merchant_approval_id as string,
        provider: body.provider,
        invoice_key: body.invoice_key,
        fingerprint_version: UPI_REWARD_BINDING_VERSION,
        fingerprint: b.fingerprint,
        base_minor: Number(body.base_amount_minor),
        expires_at: inv.validBefore,
      },
      nowMs,
    )
    if (a.kind === 'unavailable') return { kind: 'unavailable', reason: 'eligibility_unavailable', extra: { detail: a.detail } }
    if (a.kind === 'refused') return { kind: 'refuse', code: a.reason, providerFinalState: pfs }
    approvalValidUntil = a.validUntil
  }
  return {
    kind: 'ok',
    inv,
    binding: {
      version: UPI_REWARD_BINDING_VERSION,
      fingerprint: b.fingerprint,
      amountAtomic: b.usdc_atomic,
      usdCents: b.usd_cents,
      approvalId: body.merchant_approval_id,
      approvalValidUntil,
    },
  }
}

function v2CreditLimit(env: Env): bigint | null {
  const raw = env.UPI_V2_MAX_CREDIT_MICRO
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,17}$/.test(raw)) return null
  return BigInt(raw)
}

export async function handleUpiVerifiedFunding(
  request: Request,
  env: Env,
  opts: VerifiedPayInOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') return err(405, 'method_not_allowed', 'POST only')
  const unauthorized = checkInternalKey(request, env)
  if (unauthorized) return unauthorized
  const signed = await readSignedBody(request, env.UPI_INTERNAL_KEY as string)
  if (signed instanceof Response) return signed
  const rawBody = signed.rawBody

  const parsed = parseVerifiedFundingBody(rawBody)
  if (typeof parsed === 'string') return err(400, 'invalid_body', parsed)
  const body = parsed
  const idem = request.headers.get('x-idempotency-key') ?? ''
  if (idem !== body.order_id) {
    return err(400, 'idempotency_key_mismatch', 'X-Idempotency-Key must equal order_id')
  }
  const bodyHash = await sha256Hex(rawBody)
  const nowMs = (opts.now ?? Date.now)()
  const nowIso = new Date(nowMs).toISOString()

  // Create-or-load in one CAS. Same order + same bytes → the existing record
  // (resumed only if it never left not_started); different bytes → 409.
  const fresh: UpiFulfillmentRecord = {
    orderId: body.order_id,
    provider: body.provider,
    invoiceKey: body.invoice_key,
    bodyHash,
    baseAmountMinor: body.base_amount_minor.toString(),
    stablecoinAmountAtomic: '',
    state: 'queued',
    providerFinalState: null,
    executionRef: null,
    failureReason: null,
    razorpayPaymentId: body.cash_payment?.razorpay_payment_id ?? null,
    createdAt: nowIso,
    updatedAt: nowIso,
    events: [{ kind: 'verified_funding_received', at: nowIso }],
    schemaVersion: 2,
    funding: {
      kind: body.kind,
      grossAmountMinor: body.gross_amount_minor.toString(),
      creditMicro: body.credit_micro.toString(),
      cashMinor: body.cash_minor.toString(),
      redemptionId: body.redemption_id,
      merchantApprovalId: body.merchant_approval_id,
      quoteId: body.quote_id,
      quoteExpiresAt: body.quote_expires_at,
    },
    cashEvidence: body.cash_payment
      ? {
          razorpayOrderId: body.cash_payment.razorpay_order_id,
          razorpayPaymentId: body.cash_payment.razorpay_payment_id,
          capturedAt: body.cash_payment.captured_at,
          currency: body.cash_payment.currency,
          amountMinor: body.cash_payment.amount_minor.toString(),
        }
      : null,
    executionPhase: 'not_started',
    failureClass: null,
    attemptId: null,
    queuedReason: 'received',
    binding: null,
  }
  const created = await casUpdate<{ kind: 'mismatch' } | { kind: 'rec'; rec: UpiFulfillmentRecord }>(
    env,
    fulfillmentKey(body.order_id),
    (raw) => {
      const cur = parseFulfillment(raw)
      if (cur) return { op: 'noop', result: cur.bodyHash === bodyHash ? { kind: 'rec', rec: cur } : { kind: 'mismatch' } }
      return { op: 'set', value: JSON.stringify(fresh), result: { kind: 'rec', rec: fresh } }
    },
  )
  if (created.kind === 'mismatch') {
    return err(409, 'order_body_mismatch', 'order_id was already submitted with a different body')
  }
  if (!isV2Open(created.rec)) return v2Response(created.rec)
  return runV2(env, body, created.rec, opts, nowMs)
}

async function runV2(
  env: Env,
  body: VerifiedFundingBody,
  rec: UpiFulfillmentRecord,
  opts: VerifiedPayInOptions,
  nowMs: number,
): Promise<Response> {
  const orderId = body.order_id
  let claimed = false
  const refuse = async (code: string, detail: { providerFinalState?: string | null; extra?: unknown } = {}) => {
    const out = await v2Refuse(env, orderId, code, detail)
    // The barrier makes this order permanently non-executing, so a claim it
    // took can go back (definite pre-payment failure, invoice-claim.ts).
    if (out.applied && claimed) await releaseInvoiceClaim(env, body.invoice_key, 'upi', orderId)
    return v2Response(out.rec)
  }

  // 1. Switches and limits. Fail closed.
  if (await checkoutDeliveryPaused(env)) return refuse('checkout_paused')
  if (env.UPI_VERIFIED_FUNDING_V2_ENABLED !== 'true') return refuse('v2_disabled')
  const limit = v2CreditLimit(env)
  if (limit === null) return refuse('limit_not_configured')
  if (body.credit_micro > limit) return refuse('over_credit_limit')

  // 2. Live quote, binding fingerprint and merchant approval.
  const g1 = await v2Gate(env, body, rec.binding, nowMs)
  if (g1.kind === 'refuse') return refuse(g1.code, g1)
  if (g1.kind === 'unavailable') return v2Response(await v2Queue(env, orderId, g1.reason, g1.extra))
  const frozen = await casV2(env, orderId, (r) => {
    if (!isV2Open(r)) return false
    if (r.binding && r.binding.fingerprint !== g1.binding.fingerprint) return false
    r.binding = g1.binding
    r.baseAmountMinor = g1.inv.fiatAmountMinor
    r.stablecoinAmountAtomic = g1.inv.stablecoinAmountAtomic
    r.queuedReason = 'claiming'
    r.events.push({ kind: 'binding_frozen', at: new Date().toISOString(), detail: { fingerprint: g1.binding.fingerprint } })
    return true
  })
  if (!frozen.applied) {
    if (isV2Open(frozen.rec)) return refuse('binding_changed')
    return v2Response(frozen.rec)
  }

  // 3. The one cross-channel claim shared with v1, crypto and coupon.
  const claim = await claimInvoiceKey(env, body.invoice_key, 'upi', orderId, new Date(nowMs))
  if (!claim.ok) {
    return refuse('already_claimed', { extra: { holder_channel: claim.holder.channel } })
  }
  claimed = true

  // 4. Re-check right before executing: fresh payload, same fingerprint,
  //    approval still valid (design §6.1).
  const g2 = await v2Gate(env, body, frozen.rec.binding, nowMs)
  if (g2.kind === 'refuse') return refuse(g2.code, g2)
  if (g2.kind === 'unavailable') return v2Response(await v2Queue(env, orderId, g2.reason, g2.extra))

  // 5. Wallet inventory gate, as v1. Unreadable → attempt (executor re-checks).
  const invoiceAtomic = BigInt(g2.inv.stablecoinAmountAtomic)
  const balance = (await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)).balance
  if (balance !== null && balance < invoiceAtomic) {
    await sendInvoiceFailureAlert(env, {
      kind: 'failed_insufficient_balance',
      plId: `${body.invoice_key} (UPI order ${orderId})`,
      invoiceAtomic,
      funderBalanceAtomic: balance,
      failureReason: 'UPI verified-funding refused: funder cannot cover the invoice',
    })
    return refuse('insufficient_funder_balance', {
      extra: { balance: balance.toString(), invoice: invoiceAtomic.toString() },
    })
  }
  if (await checkoutDeliveryPaused(env)) return refuse('checkout_paused')

  // 6. Take the execution right: one CAS, only from not_started.
  const expected: PayInvoiceExpectedBinding = {
    version: UPI_REWARD_BINDING_VERSION,
    invoice_key: body.invoice_key,
    amount_atomic: g2.binding.amountAtomic,
    fingerprint: g2.binding.fingerprint,
  }
  const attemptId = crypto.randomUUID()
  const acquired = await casV2(env, orderId, (r) => {
    if (!isV2Open(r)) return false
    r.state = 'processing'
    r.executionPhase = 'calling'
    r.attemptId = attemptId
    r.queuedReason = null
    r.binding = g2.binding
    r.events.push({ kind: 'execution_started', at: new Date().toISOString(), detail: { attempt_id: attemptId } })
    return true
  })
  if (!acquired.applied) return v2Response(acquired.rec)

  const run = executeCoinbaseV2(env, orderId, attemptId, body.invoice_key, expected, invoiceAtomic)
  if (opts.ctx) {
    opts.ctx.waitUntil(run.catch((e) => console.error('[upi-v2] execution error', e instanceof Error ? e.message : String(e))))
    return v2Response(acquired.rec)
  }
  await run
  return v2Response((await loadFulfillment(env, orderId)) ?? acquired.rec)
}

function isPreSignBindingMismatch(result: { status: number; body: unknown }): boolean {
  const b = result.body as Record<string, unknown> | null
  return (
    result.status === 422 &&
    !!b &&
    typeof b === 'object' &&
    b.error_code === 'PRE_SIGN_BINDING_MISMATCH' &&
    b.payment_attempted === false
  )
}

async function executeCoinbaseV2(
  env: Env,
  orderId: string,
  attemptId: string,
  invoiceKey: string,
  expected: PayInvoiceExpectedBinding,
  invoiceAtomic: bigint,
): Promise<void> {
  const mark = (kind: string, fn: (r: UpiFulfillmentRecord) => void, extra?: unknown) =>
    casV2(env, orderId, (r) => {
      if (r.attemptId !== attemptId || r.executionPhase !== 'calling' || TERMINAL_STATES.has(r.state)) return false
      fn(r)
      r.events.push({ kind, at: new Date().toISOString(), detail: extra })
      return true
    })

  let result: { ok: boolean; status: number; body: unknown }
  try {
    result = await callAgentApiPayInvoice(env, invoiceKey, expected)
  } catch {
    // The signer MAY have run. Ambiguous → unknown; never re-called.
    await mark('executor_ambiguous', (r) => {
      r.state = 'unknown'
      r.failureClass = 'ambiguous'
      r.failureReason = 'executor transport error'
    })
    return
  }
  if (result.ok) {
    await mark('executor_accepted', (r) => {
      r.state = 'processing'
      r.executionPhase = 'accepted'
      r.executionRef = pickExecutionRef(result.body)
    }, { status: result.status })
    await confirmWithProvider(env, orderId)
    return
  }
  if (isPreSignBindingMismatch(result)) {
    // Trusted, structured downstream answer: refused before any signature or
    // submission. The only post-call failure that is definite.
    const out = await mark('pre_sign_binding_mismatch', (r) => {
      r.state = 'failed'
      r.executionPhase = 'terminal'
      r.failureClass = 'definite_not_paid'
      r.failureReason = 'pre_sign_binding_mismatch'
    }, { status: result.status })
    if (out.applied) await releaseInvoiceClaim(env, invoiceKey, 'upi', orderId)
    return
  }
  // Any other post-call answer (4xx/5xx/unknown JSON) cannot rule out a spend.
  await mark('executor_ambiguous', (r) => {
    r.state = 'unknown'
    r.failureClass = 'ambiguous'
    r.failureReason = `executor status ${result.status}`
  }, { status: result.status })
  await sendInvoiceFailureAlert(env, {
    kind: 'failed_pay_invoice',
    plId: `${invoiceKey} (UPI order ${orderId})`,
    invoiceAtomic,
    funderBalanceAtomic: null,
    failureReason: `UPI verified-funding: pay-invoice returned ${result.status}; outcome unknown`,
  })
}

/**
 * v2 provider confirmation (observes only, never pays):
 *   not_started        → only "someone else paid it" ends it (refusal barrier);
 *                        no staleness auto-fail (eligibility_unavailable waits)
 *   calling / accepted → provider success = paid; a stale call or any
 *                        provider failure = unknown/ambiguous, never re-called
 *   unknown            → provider success = paid
 */
async function confirmV2WithProvider(
  env: Env,
  rec: UpiFulfillmentRecord,
  nowMs: number,
): Promise<UpiFulfillmentRecord> {
  let live: LiveInvoice | null = null
  try {
    live = await fetchLiveInvoice(rec.provider, rec.invoiceKey, null, nowMs)
  } catch {
    live = null
  }
  const phase = rec.executionPhase ?? 'not_started'
  if (phase === 'not_started') {
    if (rec.state === 'queued' && live?.terminal === 'success') {
      return (await v2Refuse(env, rec.orderId, 'paid_by_other_party', { providerFinalState: live.normalized.state })).rec
    }
    return rec
  }
  const notTerminal = (r: UpiFulfillmentRecord) => !TERMINAL_STATES.has(r.state) && (r.executionPhase ?? 'not_started') !== 'not_started'
  if (live?.terminal === 'success') {
    return (await casV2(env, rec.orderId, (r) => {
      if (!notTerminal(r)) return false
      r.state = 'paid'
      r.executionPhase = 'terminal'
      r.failureClass = null
      r.failureReason = null
      r.providerFinalState = live!.normalized.state
      r.events.push({ kind: 'provider_confirmed', at: new Date().toISOString() })
      return true
    })).rec
  }
  const updatedMs = Date.parse(rec.updatedAt)
  const stale = rec.state === 'processing' && Number.isFinite(updatedMs) && nowMs - updatedMs > PROCESSING_STALE_MS
  if (live?.terminal === 'failure' || stale) {
    return (await casV2(env, rec.orderId, (r) => {
      if (!notTerminal(r) || r.state === 'unknown' || r.updatedAt !== rec.updatedAt) return false
      r.state = 'unknown'
      r.failureClass = 'ambiguous'
      r.failureReason = stale ? 'no provider confirmation after the executor call' : 'provider_terminal_failure'
      if (live) r.providerFinalState = live.normalized.state
      r.events.push({ kind: stale ? 'processing_stale' : 'provider_failed', at: new Date().toISOString() })
      return true
    })).rec
  }
  if (!live) return rec
  return (await casV2(env, rec.orderId, (r) => {
    if (r.providerFinalState === live!.normalized.state) return false
    r.providerFinalState = live!.normalized.state
    return true
  })).rec
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
