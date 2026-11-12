/**
 * Bitrefill invoice payment (provider: "bitrefill").
 *
 * The caller already created a Bitrefill invoice and chose "USDC on Base".
 * We create ONE Rozo Intents exactOut payment whose destination is the
 * Bitrefill receiving address itself: Bitrefill receives exactly `amount`
 * Base USDC, the bridge fee is added to the source side. There is no funder
 * wallet, no pay-invoice call and no exec gate: settlement is the Rozo
 * payout itself, so the webhook ignores these orders (see webhook.ts).
 *
 * Idempotency follows the Coinbase line: the orderId is derived from the
 * Bitrefill invoice id, and the Rozo payment-api lookup
 * GET /payments/order/:appId/:orderId is the source of truth (an orderId can
 * only ever be created once upstream).
 */
import type { Env } from '../index'
import { forwardedClientHintHeader, withForwardedClientHint } from './client-hint-forward'
import { relayUpstreamRateLimit } from './upstream-rate-limit'
import { intentsReadBase, isIntentsPaymentNotFound } from './intents-base'
import { isNativeSymbol, nativeMaxUsd, parseNativeSources } from './native-sources'
import {
  CHECKOUT_PRICING_VERSION,
  type CheckoutPricing,
  buildCheckoutTitle,
  computeServiceFeeAtomic,
  formatUsdcAtomic,
  normalizeCheckoutClient,
  parseUsdcAtomic,
} from './checkout-web-pricing'
import { OPENROUTER_APP_ID } from './existing-order'
import { casUpdate } from './stripe-atomic'
import {
  BITREFILL_FEE_BPS,
  BITREFILL_FUNDER,
  bitrefillMetadataBlock,
  bitrefillReceiverRefusal,
  isBitrefillUuid,
  readBitrefillFacts,
} from './bitrefill-binding'

const ROZO_INTENTS_URL = 'https://intentapiv4.rozo.ai/functions/v1/payment-api/'
// Dedicated WALLET-type account. It must not be a merchant account: payment-api
// rewrites destination to the merchant's own to_address for any appId with a
// merchants row (index.ts merchant config override), which would send the USDC
// to Rozo custody instead of the Bitrefill invoice. Wallet accounts keep the
// caller's destination. payment-api also overrides body.appId with the API
// key's app_id, so the key (ROZO_BITREFILL_API_KEY) is what actually selects it.
export const BITREFILL_APP_ID = 'wallet_bitrefillpay'
const BASE_CHAIN_ID = '8453'
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/**
 * Max USDC a single Bitrefill invoice may route through us (founder
 * 2026-11-11: "上限 1050", was 200). Compared against `bitrefill.amount`, the
 * invoice amount Bitrefill receives on Base, NOT the larger amount the payer
 * sends (that adds the bridge fee). Bitrefill prices a card above its face
 * value (a 200 card is a 204 invoice), so 1050 covers cards up to the ~1,000
 * USD tier. Native sources are still bounded separately by NATIVE_MAX_USD,
 * and payment-api applies its own pay-in and liquidity caps upstream.
 */
export const BITREFILL_MAX_USDC = 1050
/** Minimum time left on the Bitrefill invoice before we open a deposit. */
export const BITREFILL_MIN_REMAINING_MS = 5 * 60 * 1000
/**
 * Bitrefill invoices live 60 min (measured on real invoices 2026-11-11; the
 * earlier ~15 min assumption was wrong and rejected freshly created invoices).
 * Anything further out is not a Bitrefill expiry. The extra minute absorbs
 * clock skew between Bitrefill, the caller and this Worker.
 */
export const BITREFILL_MAX_REMAINING_MS = 61 * 60 * 1000
/** orderId prefix; the webhook uses it to skip router-side settlement. */
export const BITREFILL_ORDER_PREFIX = 'bitrefill_'

/** Earliest parseable ISO timestamp among the inputs, or null if none parse. */
export function earlierIso(...values: unknown[]): string | null {
  const ts = values
    .map((v) => (typeof v === 'string' ? Date.parse(v) : NaN))
    .filter(Number.isFinite)
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null
}
const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/
const INVOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isBitrefillOrderId(orderId: unknown): boolean {
  return typeof orderId === 'string' && orderId.startsWith(BITREFILL_ORDER_PREFIX)
}

export function bitrefillOrderId(invoiceId: string): string {
  return `${BITREFILL_ORDER_PREFIX}${invoiceId}`
}

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// payment-api error codes that mean "this request cannot be served as asked"
// rather than "we are down". Anything not listed keeps the 502 path.
const CALLER_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalidRequest',
  'amountTooLow',
  'amountTooHigh',
  'invalidAmount',
  'invalidTokenSymbol',
  'unsupportedCurrency',
  'unsupported',
])

/** payment-api errors are { error: { code, message } }; keep a short message. */
function upstreamError(text: string): { code: string; message: string } | null {
  try {
    const e = JSON.parse(text)?.error
    if (!e || typeof e.code !== 'string') return null
    return { code: e.code, message: typeof e.message === 'string' ? e.message.substring(0, 200) : '' }
  } catch {
    return null
  }
}

function ok(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

type ResolveSource = (
  raw: unknown,
  nativeAllowed: ReadonlySet<string>,
) => { resolved?: { chainId: string; tokenSymbol: string }; error?: { code: string; message: string; supported?: unknown } }

export async function handleBitrefillCreateInvoice(
  request: Request,
  env: Env,
  parsed: Record<string, unknown>,
  resolveSource: ResolveSource,
  // Optional payer contact email, already normalized by handleCreateInvoice.
  contactEmail: string | null = null,
): Promise<Response> {
  if (String(env.BITREFILL_ENABLED ?? 'false').toLowerCase() !== 'true') {
    return fail(403, 'BITREFILL_DISABLED', 'Bitrefill invoice payment is not enabled.')
  }
  // Funder model (founder 2026-11-11): order under merchant_openrouter, 1% fee
  // in the price, the funder pays Bitrefill. Off = today's direct model below.
  if (bitrefillFunderSendEnabled(env)) {
    return handleBitrefillFunderCreate(request, env, parsed, resolveSource, contactEmail)
  }
  // Never fall back to the OpenRouter key: payment-api derives the merchant
  // from the key, so that would file these orders under merchant_openrouter.
  const apiKey = env.ROZO_BITREFILL_API_KEY
  if (!apiKey) {
    return fail(503, 'BITREFILL_NOT_CONFIGURED', 'Bitrefill invoice payment is not configured.')
  }

  const br = parsed.bitrefill
  if (!br || typeof br !== 'object' || Array.isArray(br)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill must be an object with invoiceId, address and amount.')
  }
  const { invoiceId, address, amount, expiresAt } = br as Record<string, unknown>

  if (typeof invoiceId !== 'string' || !INVOICE_ID_RE.test(invoiceId)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.invoiceId must be 1-128 chars of [A-Za-z0-9_-].')
  }
  // Same refusal set as the funder model (bitrefill-binding.ts, the 17 charter
  // EVM entries incl. the funder lookalike, plus zero, the funder itself and
  // the USDC contract). Response codes are unchanged: malformed =
  // INVALID_ADDRESS, refused = BLOCKED_ADDRESS.
  const receiverRefusal = bitrefillReceiverRefusal(address)
  if (receiverRefusal || typeof address !== 'string') {
    return receiverRefusal === null || receiverRefusal.startsWith('not a')
      ? fail(400, 'INVALID_ADDRESS', 'bitrefill.address must be a 0x-prefixed 40-hex Base address.')
      : fail(400, 'BLOCKED_ADDRESS', 'This receiving address is not allowed.')
  }
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    return fail(400, 'INVALID_AMOUNT', 'bitrefill.amount must be a positive decimal string with at most 6 decimals.')
  }
  if (Number(amount) > BITREFILL_MAX_USDC) {
    return fail(400, 'AMOUNT_OUT_OF_RANGE', `bitrefill.amount (the invoice amount) must be at most ${BITREFILL_MAX_USDC} USDC.`)
  }
  // expiresAt is required. Rozo's deposit TTL is fixed at ~1h by payment-api
  // and cannot be shortened by the caller, so the deposit can stay payable
  // after the Bitrefill invoice dies (always when less than an hour was left
  // at create time). The CLIENT must stop the payment at the
  // returned expiresAt; funds sent later still reach the (dead) invoice
  // address and need Bitrefill support to recover.
  const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN
  if (!Number.isFinite(t)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.expiresAt is required and must be an ISO-8601 timestamp.')
  }
  const remaining = t - Date.now()
  if (remaining < BITREFILL_MIN_REMAINING_MS) {
    return fail(400, 'INVOICE_EXPIRING', 'The Bitrefill invoice expires in under 5 minutes. Create a new invoice.')
  }
  if (remaining > BITREFILL_MAX_REMAINING_MS) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.expiresAt is more than 60 minutes away; pass the Bitrefill invoice expiry.')
  }
  const expiresAtIso = new Date(t).toISOString()

  const src = resolveSource(parsed.source, parseNativeSources(env.NATIVE_SOURCES))
  if (!src.resolved) {
    return fail(400, 'UNSUPPORTED_SOURCE', src.error?.message ?? 'Unsupported source.', {
      supported: src.error?.supported,
    })
  }
  const source = src.resolved
  if (isNativeSymbol(source.chainId, source.tokenSymbol) && Number(amount) > nativeMaxUsd(env.NATIVE_MAX_USD)) {
    return fail(400, 'AMOUNT_OUT_OF_RANGE', `Native coin payment is limited to $${nativeMaxUsd(env.NATIVE_MAX_USD)} per invoice. Pay with USDC/USDT instead.`)
  }

  const orderId = bitrefillOrderId(invoiceId)

  const lookupExisting = async (): Promise<{ state: 'found'; row: any } | { state: 'missing' } | { state: 'error' }> => {
    try {
      const r = await fetch(
        `${intentsReadBase(env)}/payments/order/${encodeURIComponent(BITREFILL_APP_ID)}/${encodeURIComponent(orderId)}`,
        { method: 'GET', headers: { 'X-API-Key': apiKey } },
      )
      // Only intents' own paymentNotFound 404 means "no order yet"; any
      // other 404 (e.g. undeployed read function) is an error, never a create.
      if (r.status === 404) return (await isIntentsPaymentNotFound(r)) ? { state: 'missing' } : { state: 'error' }
      if (!r.ok) return { state: 'error' }
      const row = await r.json().catch(() => undefined)
      return row === undefined ? { state: 'error' } : { state: 'found', row }
    } catch {
      return { state: 'error' }
    }
  }
  const duplicate = (row: any) =>
    !row?.id
      ? fail(503, 'RETRY_LATER', 'A payment for this Bitrefill invoice is being created. Retry in a few seconds to get its id; do not pay yet.')
      : fail(409, 'DUPLICATE_INVOICE', 'A payment already exists for this Bitrefill invoice. Resume it instead of paying again.', {
      invoiceId,
      rozoPaymentId: row?.id ?? null,
      // Effective expiry: the earlier of the Bitrefill expiry stored at create
      // time and the Rozo deposit's (~1h). Both are now about an hour, so either
      // can come first.
      expiresAt: earlierIso(row?.metadata?.bitrefillExpiresAt, row?.expiresAt),
      ...(row?.source ? { source: row.source } : {}),
    })

  // One order per invoice across BOTH accounts (direct and funder model): a
  // switch flip must never open a second payable order for the same invoice.
  const claim = await claimInvoiceAccount(env, invoiceId, BITREFILL_APP_ID)
  if (claim === 'error') {
    return fail(503, 'RETRY_LATER', 'Could not reserve this Bitrefill invoice. Retry shortly; do not pay yet.')
  }
  const existing = await lookupAnyAccount(env, invoiceId)
  if (claim !== BITREFILL_APP_ID && existing.state !== 'found') {
    return fail(409, 'DUPLICATE_INVOICE', 'A payment for this Bitrefill invoice was started under another checkout model. Resume it instead of paying again.', { invoiceId })
  }
  if (existing.state === 'found') return duplicate(existing.row)
  if (existing.state === 'error') {
    return fail(502, 'INTENTS_API_FAILED', 'Could not check for an existing payment for this invoice. Retry shortly.')
  }

  const client = normalizeCheckoutClient(parsed.client)
  const attribution = parsed.attribution
  const attributionField =
    attribution && typeof attribution === 'object' && !Array.isArray(attribution) ? { attribution } : {}

  const intentsBody = {
    appId: BITREFILL_APP_ID,
    orderId,
    type: 'exactOut',
    display: {
      title: `Bitrefill invoice ${invoiceId}`,
      currency: 'USD',
      merchantName: 'Bitrefill',
      merchantDescription: 'Bitrefill via ROZO Checkout',
    },
    source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    destination: {
      chainId: BASE_CHAIN_ID,
      receiverAddress: address,
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
      amount,
    },
    ...attributionField,
    ...(contactEmail ? { email: contactEmail } : {}),
    metadata: {
      source: 'mpprouter-create-invoice',
      provider: 'bitrefill',
      bitrefillInvoiceId: invoiceId,
      bitrefillExpiresAt: expiresAtIso,
      ...(client ? { client } : {}),
    },
  }

  let resp: Response
  try {
    resp = await fetch(ROZO_INTENTS_URL, {
      method: 'POST',
      headers: withForwardedClientHint(
        { 'content-type': 'application/json', 'X-API-Key': apiKey },
        forwardedClientHintHeader(request, client),
      ),
      body: JSON.stringify(intentsBody),
    })
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API unreachable.')
  }
  const text = await resp.text()
  if (!resp.ok) {
    const rateLimited = relayUpstreamRateLimit(resp, text, { error: 'RATE_LIMITED' })
    if (rateLimited) return rateLimited
    if (resp.status === 409 && /orderIdConflict/i.test(text)) {
      const raced = await lookupExisting()
      return duplicate(raced.state === 'found' ? raced.row : null)
    }
    // payment-api answers some caller mistakes with 400. Since NATIVE_SOURCES
    // opened native coins for the Coinbase line (#224), the common one is a
    // native source for an app that payment-api has not enabled
    // (merchant_native_tokens; wallet_bitrefillpay is not). Those get a 4xx the
    // caller can act on. Operational 400s (insufficientLiquidity,
    // priceCheckUnavailable, providerError, configError, ...) stay 502.
    const upstream = upstreamError(text)
    if (resp.status === 400 || resp.status === 422) {
      if (upstream && CALLER_ERROR_CODES.has(upstream.code)) {
        const extra = { upstream_code: upstream.code, upstream_message: upstream.message }
        if (
          isNativeSymbol(source.chainId, source.tokenSymbol) &&
          upstream.code === 'invalidRequest' &&
          /^Native .*not (enabled|available)/i.test(upstream.message)
        ) {
          return fail(
            400,
            'UNSUPPORTED_SOURCE',
            `Native ${source.tokenSymbol} on chainId ${source.chainId} is not available for Bitrefill invoices. Pay with USDC or USDT.`,
            extra,
          )
        }
        if (upstream.code === 'amountTooLow' || upstream.code === 'amountTooHigh') {
          return fail(400, 'AMOUNT_OUT_OF_RANGE', upstream.message || 'Amount is out of range for this source.', extra)
        }
        return fail(400, 'INTENTS_API_REJECTED', upstream.message || `Rozo intents API rejected the request (${resp.status}).`, extra)
      }
    }
    // Name the upstream code (not the message) so a 502 is diagnosable from
    // the response alone.
    return fail(502, 'INTENTS_API_FAILED', `Rozo intents API returned ${resp.status}.`, {
      upstream_status: resp.status,
      ...(upstream ? { upstream_code: upstream.code } : {}),
    })
  }
  let created: any
  try {
    created = JSON.parse(text)
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API returned a malformed body.')
  }

  // Effective expiry: the earlier of Bitrefill's and the Rozo deposit's.
  const effectiveExpiresAt = earlierIso(expiresAtIso, created?.expiresAt)

  return ok({
    provider: 'bitrefill',
    invoiceId,
    rozoPaymentId: created?.id ?? null,
    destination: { chainId: BASE_CHAIN_ID, tokenSymbol: 'USDC', address, amount },
    expiresAt: effectiveExpiresAt,
    // Rozo's hosted paymentLink is intentionally withheld: that page stays
    // payable on Rozo's own ~1h clock, which can outlive the Bitrefill invoice.
    ...(created?.source ? { source: created.source } : {}),
  })
}

// ── Funder model (BITREFILL_FUNDER_SEND_ENABLED=true) ───────────────────────
//
// One Rozo Intents order per Bitrefill invoice under merchant_openrouter (the
// OpenRouter API key; payment-api rewrites the destination to the funder).
// exactOut: the funder receives exactly callerPays = invoice + 1% in Base
// USDC, the bridge fee is added on the source side. The facts the funder pays
// from are frozen into metadata.bitrefill with an HMAC binding
// (bitrefill-binding.ts); the webhook (bitrefill-settle.ts) asks pay-invoice
// to pay the invoice amount once the order is paid out to the funder.
//
// Idempotency: orderId bitrefill_<uuid> cannot collide with a Coinbase orderId
// (pl_*, paymentSession_*, rozotest_*, mpprouter-*). Before creating, both the
// merchant_openrouter slot and the legacy wallet_bitrefillpay slot are read:
// an invoice that already has an order under either account is never given a
// second one.

export function bitrefillFunderSendEnabled(env: Env): boolean {
  return String(env.BITREFILL_FUNDER_SEND_ENABLED ?? '').toLowerCase() === 'true'
}

/**
 * Parse BITREFILL_FUNDER_ALLOWED_INVOICES. After trim it is either exactly "*"
 * (every invoice) or a comma-separated list of lowercase invoice UUIDs
 * (whitespace around items tolerated). Unset, empty, or ANY malformed token
 * ("*" mixed with ids, uppercase, non-UUID, empty item) = null: nothing is
 * allowed (fail closed). The same grammar is used by pay-invoice's
 * BITREFILL_FUNDER_PAY_INVOICE_ALLOWLIST.
 */
export function parseBitrefillInvoiceAllowlist(raw: unknown): { all: true } | { all: false; ids: ReadonlySet<string> } | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (v === '') return null
  if (v === '*') return { all: true }
  const ids = new Set<string>()
  for (const item of v.split(',')) {
    const id = item.trim()
    if (!isBitrefillUuid(id)) return null
    ids.add(id)
  }
  return { all: false, ids }
}

/** True only when the allowlist parses and contains this invoice (or is "*"). */
export function bitrefillInvoiceAllowed(env: Env, invoiceId: string): boolean {
  const list = parseBitrefillInvoiceAllowlist(env.BITREFILL_FUNDER_ALLOWED_INVOICES)
  if (!list) return false
  if (list.all) return true
  return list.ids.has(invoiceId.trim().toLowerCase())
}

const BASE_USDC_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

type Lookup = { state: 'found'; row: any } | { state: 'missing' } | { state: 'error' }

async function lookupOrder(env: Env, appId: string, apiKey: string | undefined, orderId: string): Promise<Lookup> {
  try {
    const r = await fetch(
      `${intentsReadBase(env)}/payments/order/${encodeURIComponent(appId)}/${encodeURIComponent(orderId)}`,
      // A key scopes the read to ITS app (payment-api overrides the path
      // appId), so each account is read with its own key, or keyless.
      { method: 'GET', headers: apiKey ? { 'X-API-Key': apiKey } : {} },
    )
    if (r.status === 404) return (await isIntentsPaymentNotFound(r)) ? { state: 'missing' } : { state: 'error' }
    if (!r.ok) return { state: 'error' }
    const row = await r.json().catch(() => undefined)
    return row === undefined ? { state: 'error' } : { state: 'found', row }
  } catch {
    return { state: 'error' }
  }
}

/**
 * Permanently bind a Bitrefill invoice (normalized lowercase id) to the ONE
 * account its order may live under (DO CAS, linearizable). Upstream enforces
 * one order per (app_id, order_id), so binding the account closes the race
 * where a direct-model and a funder-model request for the same invoice both
 * pass the lookups during a switch flip. Returns the bound account, or
 * 'error' when the claim store is unavailable (caller must not create).
 */
export async function claimInvoiceAccount(env: Env, invoiceId: string, appId: string): Promise<string | 'error'> {
  try {
    return await casUpdate<string>(env, `bitrefill-invoice-account:v1:${invoiceId.trim().toLowerCase()}`, (raw) => {
      if (raw) return { op: 'noop', result: raw }
      return { op: 'set', value: appId, result: appId }
    })
  } catch {
    return 'error'
  }
}

/**
 * Existing order for this Bitrefill invoice under either account, checking the
 * id as given and lowercased (the funder model stores lowercase UUIDs, the
 * direct model the id as sent). Any read that cannot answer = error: the
 * caller must not create.
 */
export async function lookupAnyAccount(env: Env, rawInvoiceId: string): Promise<Lookup> {
  if (!env.ROZO_INTENTS_API_KEY) return { state: 'error' }
  // Legacy orders kept the id as sent. Bitrefill issues lowercase UUIDs, so
  // as-sent, lowercase and uppercase cover every real legacy spelling; the
  // account claim above covers every order created after this release.
  const ids = Array.from(new Set([rawInvoiceId, rawInvoiceId.toLowerCase(), rawInvoiceId.toUpperCase()])).map(bitrefillOrderId)
  const reads: Array<Promise<Lookup>> = []
  for (const id of ids) {
    reads.push(lookupOrder(env, OPENROUTER_APP_ID, env.ROZO_INTENTS_API_KEY, id))
    reads.push(lookupOrder(env, BITREFILL_APP_ID, env.ROZO_BITREFILL_API_KEY, id))
  }
  const results = await Promise.all(reads)
  const found = results.find((r) => r.state === 'found')
  if (found) return found
  return results.some((r) => r.state === 'error') ? { state: 'error' } : { state: 'missing' }
}

function funderPricingFields(row: any): Record<string, unknown> {
  const f = readBitrefillFacts(row)
  if (!f) return { original: null, serviceFee: null, feeBps: null, callerPays: null, callerPaysAtomicUsdc: null }
  return {
    original: formatUsdcAtomic(f.amountAtomic),
    serviceFee: formatUsdcAtomic(f.serviceFeeAtomic),
    feeBps: f.feeBps,
    callerPays: formatUsdcAtomic(f.callerPaysAtomic),
    callerPaysAtomicUsdc: f.callerPaysAtomic.toString(),
  }
}

export async function handleBitrefillFunderCreate(
  request: Request,
  env: Env,
  parsed: Record<string, unknown>,
  resolveSource: ResolveSource,
  contactEmail: string | null = null,
): Promise<Response> {
  const apiKey = env.ROZO_INTENTS_API_KEY
  if (!apiKey || !env.PAYINVOICE_ADMIN_SECRET) {
    return fail(503, 'BITREFILL_NOT_CONFIGURED', 'Bitrefill invoice payment is not configured.')
  }
  const br = parsed.bitrefill
  if (!br || typeof br !== 'object' || Array.isArray(br)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill must be an object with invoiceId, address and amount.')
  }
  const { invoiceId: rawId, address, amount, expiresAt } = br as Record<string, unknown>
  const invoiceId = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
  // Single-invoice isolation (fail closed). Checked before the account claim,
  // the duplicate lookups and any create, so a non-listed invoice can neither
  // open an order nor be handed the deposit of an existing one (the 409
  // DUPLICATE_INVOICE body carries the order's source). Never falls back to
  // the direct model while the funder switch is on: an empty list is the
  // "pause all Bitrefill creation" state.
  if (!bitrefillInvoiceAllowed(env, invoiceId)) {
    return fail(403, 'BITREFILL_INVOICE_NOT_ALLOWED', 'This Bitrefill invoice is not open for payment right now.')
  }
  if (!isBitrefillUuid(invoiceId)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.invoiceId must be the Bitrefill invoice UUID.')
  }
  const refusal = bitrefillReceiverRefusal(address)
  if (refusal) {
    return refusal.startsWith('not a')
      ? fail(400, 'INVALID_ADDRESS', 'bitrefill.address must be a 0x-prefixed 40-hex Base address.')
      : fail(400, 'BLOCKED_ADDRESS', 'This receiving address is not allowed.')
  }
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    return fail(400, 'INVALID_AMOUNT', 'bitrefill.amount must be a positive decimal string with at most 6 decimals.')
  }
  const invoiceAtomic = parseUsdcAtomic(amount)
  if (invoiceAtomic <= 0n) {
    return fail(400, 'INVALID_AMOUNT', 'bitrefill.amount must be a positive decimal string with at most 6 decimals.')
  }
  if (invoiceAtomic > BigInt(BITREFILL_MAX_USDC) * 1_000_000n) {
    return fail(400, 'AMOUNT_OUT_OF_RANGE', `bitrefill.amount (the invoice amount) must be at most ${BITREFILL_MAX_USDC} USDC.`)
  }
  const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN
  if (!Number.isFinite(t)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.expiresAt is required and must be an ISO-8601 timestamp.')
  }
  const remaining = t - Date.now()
  if (remaining < BITREFILL_MIN_REMAINING_MS) {
    return fail(400, 'INVOICE_EXPIRING', 'The Bitrefill invoice expires in under 5 minutes. Create a new invoice.')
  }
  if (remaining > BITREFILL_MAX_REMAINING_MS) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.expiresAt is more than 60 minutes away; pass the Bitrefill invoice expiry.')
  }
  const expiresAtIso = new Date(t).toISOString()

  // Same sources as the Coinbase line (USDC/USDT chains, Lightning, the native
  // coins NATIVE_SOURCES opens). Beta coins (ZEC) are not offered: their
  // 1Click window outlives a 60-minute Bitrefill invoice.
  const src = resolveSource(parsed.source, parseNativeSources(env.NATIVE_SOURCES))
  if (!src.resolved) {
    return fail(400, 'UNSUPPORTED_SOURCE', src.error?.message ?? 'Unsupported source.', { supported: src.error?.supported })
  }
  const source = src.resolved
  if (source.tokenSymbol === 'ZEC') {
    return fail(400, 'UNSUPPORTED_SOURCE', 'ZEC is not available for Bitrefill invoices.')
  }

  const serviceFeeAtomic = computeServiceFeeAtomic(invoiceAtomic, BITREFILL_FEE_BPS)
  const callerPaysAtomic = invoiceAtomic + serviceFeeAtomic
  const pricing: CheckoutPricing = {
    originalAtomic: invoiceAtomic,
    serviceFeeAtomic,
    callerPaysAtomic,
    feeBps: BITREFILL_FEE_BPS,
    pricingVersion: CHECKOUT_PRICING_VERSION,
  }
  const isNative = isNativeSymbol(source.chainId, source.tokenSymbol)
  if (isNative && Number(callerPaysAtomic) / 1e6 > nativeMaxUsd(env.NATIVE_MAX_USD)) {
    return fail(400, 'AMOUNT_OUT_OF_RANGE', `Native coin payment is limited to $${nativeMaxUsd(env.NATIVE_MAX_USD)} per invoice. Pay with USDC/USDT instead.`)
  }

  const orderId = bitrefillOrderId(invoiceId)
  const duplicate = (row: any) =>
    !row?.id
      ? fail(503, 'RETRY_LATER', 'A payment for this Bitrefill invoice is being created. Retry in a few seconds to get its id; do not pay yet.')
      : fail(409, 'DUPLICATE_INVOICE', 'A payment already exists for this Bitrefill invoice. Resume it instead of paying again.', {
        invoiceId,
        rozoPaymentId: row?.id ?? null,
        expiresAt: earlierIso(row?.metadata?.bitrefillExpiresAt, row?.expiresAt),
        ...funderPricingFields(row),
        ...(row?.source ? { source: row.source } : {}),
      })

  const claim = await claimInvoiceAccount(env, invoiceId, OPENROUTER_APP_ID)
  if (claim === 'error') {
    return fail(503, 'RETRY_LATER', 'Could not reserve this Bitrefill invoice. Retry shortly; do not pay yet.')
  }
  // Orders created before the switch live under the legacy wallet account;
  // both accounts are always checked (keyless when the legacy key is unset).
  const existing = await lookupAnyAccount(env, typeof rawId === 'string' ? rawId.trim() : invoiceId)
  if (existing.state === 'found') return duplicate(existing.row)
  if (claim !== OPENROUTER_APP_ID && existing.state === 'missing') {
    return fail(409, 'DUPLICATE_INVOICE', 'A payment for this Bitrefill invoice was started under another checkout model. Resume it instead of paying again.', { invoiceId })
  }
  if (existing.state === 'error') {
    return fail(502, 'INTENTS_API_FAILED', 'Could not check for an existing payment for this invoice. Retry shortly.')
  }

  const client = normalizeCheckoutClient(parsed.client)
  const attribution = parsed.attribution
  const attributionField =
    attribution && typeof attribution === 'object' && !Array.isArray(attribution) ? { attribution } : {}
  const bitrefillBlock = await bitrefillMetadataBlock(env.PAYINVOICE_ADMIN_SECRET, {
    invoiceId,
    address: (address as string).toLowerCase(),
    amountAtomic: invoiceAtomic,
    expiresAt: expiresAtIso,
    feeBps: BITREFILL_FEE_BPS,
    serviceFeeAtomic,
    callerPaysAtomic,
  })
  const callerPays = formatUsdcAtomic(callerPaysAtomic)

  const intentsBody = {
    appId: OPENROUTER_APP_ID,
    orderId,
    type: 'exactOut',
    display: {
      title: buildCheckoutTitle('Bitrefill', pricing),
      currency: 'USD',
      merchantName: 'Bitrefill',
      merchantDescription: 'Bitrefill via ROZO Checkout',
    },
    source: source.chainId === 'lightning'
      ? { chainId: 'lightning', tokenSymbol: 'BTC' }
      : { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    destination: {
      chainId: BASE_CHAIN_ID,
      receiverAddress: BITREFILL_FUNDER,
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_TOKEN,
      amount: callerPays,
    },
    ...attributionField,
    ...(contactEmail ? { email: contactEmail } : {}),
    metadata: {
      source: 'mpprouter-create-invoice',
      provider: 'bitrefill',
      bitrefillInvoiceId: invoiceId,
      bitrefillExpiresAt: expiresAtIso,
      original: formatUsdcAtomic(invoiceAtomic),
      serviceFee: formatUsdcAtomic(serviceFeeAtomic),
      callerPays,
      feeBps: BITREFILL_FEE_BPS,
      pricingVersion: CHECKOUT_PRICING_VERSION,
      bitrefill: bitrefillBlock,
      ...(client ? { client } : {}),
    },
  }

  let resp: Response
  try {
    resp = await fetch(ROZO_INTENTS_URL, {
      method: 'POST',
      headers: withForwardedClientHint(
        { 'content-type': 'application/json', 'X-API-Key': apiKey },
        forwardedClientHintHeader(request, client),
      ),
      body: JSON.stringify(intentsBody),
    })
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API unreachable.')
  }
  const text = await resp.text()
  if (!resp.ok) {
    const rateLimited = relayUpstreamRateLimit(resp, text, { error: 'RATE_LIMITED' })
    if (rateLimited) return rateLimited
    if (resp.status === 409 && /orderIdConflict/i.test(text)) {
      const raced = await lookupOrder(env, OPENROUTER_APP_ID, apiKey, orderId)
      return duplicate(raced.state === 'found' ? raced.row : null)
    }
    const upstream = upstreamError(text)
    if ((resp.status === 400 || resp.status === 422) && upstream && CALLER_ERROR_CODES.has(upstream.code)) {
      const extra = { upstream_code: upstream.code, upstream_message: upstream.message }
      if (upstream.code === 'amountTooLow' || upstream.code === 'amountTooHigh') {
        return fail(400, 'AMOUNT_OUT_OF_RANGE', upstream.message || 'Amount is out of range for this source.', extra)
      }
      return fail(400, 'INTENTS_API_REJECTED', upstream.message || `Rozo intents API rejected the request (${resp.status}).`, extra)
    }
    return fail(502, 'INTENTS_API_FAILED', `Rozo intents API returned ${resp.status}.`, {
      upstream_status: resp.status,
      ...(upstream ? { upstream_code: upstream.code } : {}),
    })
  }
  let created: any
  try {
    created = JSON.parse(text)
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API returned a malformed body.')
  }

  return ok({
    provider: 'bitrefill',
    model: 'funder',
    invoiceId,
    rozoPaymentId: created?.id ?? null,
    destination: { chainId: BASE_CHAIN_ID, tokenSymbol: 'USDC', address: (address as string), amount },
    original: formatUsdcAtomic(invoiceAtomic),
    serviceFee: formatUsdcAtomic(serviceFeeAtomic),
    feeBps: BITREFILL_FEE_BPS,
    callerPays,
    callerPaysAtomicUsdc: callerPaysAtomic.toString(),
    pricingVersion: CHECKOUT_PRICING_VERSION,
    expiresAt: earlierIso(expiresAtIso, created?.expiresAt),
    ...(created?.source ? { source: created.source } : {}),
  })
}
