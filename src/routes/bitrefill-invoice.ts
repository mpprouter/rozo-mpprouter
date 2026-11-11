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
 * Service fee (founder 2026-11-11: "Bitrefill 收 1%"): the order is created
 * with `partnerFeeBps = BITREFILL_FEE_BPS` and payment-api's partner-fee
 * mechanism (rozo-intents-api shared/partner-fee.ts) adds 1% of the invoice
 * amount to what the payer sends. Bitrefill still receives exactly `amount`;
 * the fee stays in the Rozo hub, is booked on the order (partner_fee) and is
 * settled to the wallet_bitrefillpay partner_fee_configs recipient (the Base
 * USDC funder). That needs a partner_fee_configs row for wallet_bitrefillpay;
 * without it payment-api refuses the order with 400. The fee figures in our
 * response are copied from payment-api's reply, never computed on our side
 * alone, and an order priced with any other rate is refused.
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
import { isNativeSymbol, parseNativeSources } from './native-sources'
import { formatUsdcAtomic, normalizeCheckoutClient, parseUsdcAtomic } from './checkout-web-pricing'

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
/**
 * Rozo service fee on Bitrefill invoices, in basis points of the invoice
 * amount (founder 2026-11-11: "Bitrefill 收 1%"). Sent to payment-api as
 * partnerFeeBps; 1% of a 204 invoice is 2.04, so the payer sends 206.04 plus
 * the bridge fee.
 */
export const BITREFILL_FEE_BPS = 100

/**
 * Largest fee payment-api can quote for `originalAtomic` at `bps`: it rounds
 * the partner fee UP to 4 decimals (shared/partner-fee.ts quotePartnerFee,
 * formatDecimalUp4). 4 decimals = 100 atomic USDC units. Its float epsilon can
 * only make the quoted fee smaller, never larger.
 */
export function maxBitrefillFeeAtomic(originalAtomic: bigint, bps: number): bigint {
  const raw = originalAtomic * BigInt(bps) // atomic * 10_000
  const unit = 10_000n * 100n
  return ((raw + unit - 1n) / unit) * 100n
}

/**
 * Pricing of an order as payment-api reports it in `source.partnerFee` /
 * `source.partnerFeeBps`. `legacy` = the order has no partner fee fields
 * (created before the fee existed). Returns null when the fields are present
 * but unusable (fee above what the rate can produce, malformed, negative).
 */
export function bitrefillPricingFromOrder(
  source: any,
  amount: string,
): { original: string; serviceFee: string; feeBps: number; callerPays: string; legacy: boolean } | null {
  const originalAtomic = parseUsdcAtomic(amount)
  const hasBps = source && source.partnerFeeBps !== undefined && source.partnerFeeBps !== null
  if (!hasBps) {
    return { original: formatUsdcAtomic(originalAtomic), serviceFee: '0', feeBps: 0, callerPays: formatUsdcAtomic(originalAtomic), legacy: true }
  }
  const bps = source.partnerFeeBps
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > BITREFILL_FEE_BPS) return null
  const feeRaw = source.partnerFee
  if (typeof feeRaw !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(feeRaw)) return null
  const feeAtomic = parseUsdcAtomic(feeRaw)
  const maxFee = maxBitrefillFeeAtomic(originalAtomic, bps)
  // payment-api's float epsilon can land one 4 dp step (100 atomic) below the
  // exact round-up, never more; anything lower is not this rate's fee.
  const minFee = maxFee > 100n ? maxFee - 100n : 0n
  if (feeAtomic > maxFee || feeAtomic < minFee) return null
  return {
    original: formatUsdcAtomic(originalAtomic),
    serviceFee: formatUsdcAtomic(feeAtomic),
    feeBps: bps,
    callerPays: formatUsdcAtomic(originalAtomic + feeAtomic),
    legacy: false,
  }
}

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

// Known compromised / attacker EVM addresses. No shared blocklist exists in
// this repo, so these are hard-coded here and compared lowercased.
const BLOCKED_ADDRESSES: ReadonlySet<string> = new Set(
  [
    '0x0000000000000000000000000000000000000000',
    '0x8FE7155119d2975780c9e19B07dD98393965Bc2a',
    '0xa9E3Da13EF5eADFC6EcB2BB6BDddE95016B567dB',
    '0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897',
    '0x44d6B5a11FFc5Ba1043734d88af5E5dea36a648A',
    '0x467AeD16d024405116cF4Ba12976Bf63B404517b',
    '0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6',
    '0x49CD5655Cc9bf7c7C93fBb2DF36AA3020d11eEe0',
    '0xa9BacE1614d6cFf8aa159A2A41eE8BaA9a91Cc7B',
    '0xfD0e6fA2ABA8436e95f3Fb3523AC14Ba299c0e79',
  ].map((a) => a.toLowerCase()),
)

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

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
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return fail(400, 'INVALID_ADDRESS', 'bitrefill.address must be a 0x-prefixed 40-hex Base address.')
  }
  if (BLOCKED_ADDRESSES.has(address.toLowerCase())) {
    return fail(400, 'BLOCKED_ADDRESS', 'This receiving address is not allowed.')
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
  // payment-api charges the partner fee only on USDC/USDT sources: native
  // coins and Lightning would carry partnerFeeBps 100 but a 0 fee
  // (shared/partner-fee.ts first-phase scope). Refuse them before any order
  // exists instead of creating an unpayable or unpriced one.
  if (source.chainId === 'lightning' || isNativeSymbol(source.chainId, source.tokenSymbol)) {
    return fail(400, 'UNSUPPORTED_SOURCE', 'Bitrefill invoices can be paid with USDC or USDT only. Native coins and Lightning are not available for Bitrefill.')
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
  const duplicate = (row: any) => {
    if (!row?.id) {
      return fail(503, 'RETRY_LATER', 'A payment for this Bitrefill invoice is being created. Retry in a few seconds to get its id; do not pay yet.')
    }
    // Report the existing order's pricing exactly as payment-api froze it, so
    // a resumed order shows the fee it really carries (0 for orders created
    // before the fee). An order whose fee fields cannot be trusted is not
    // offered for resume.
    const rowAmount = typeof row?.destination?.amount === 'string' && AMOUNT_RE.test(row.destination.amount) ? row.destination.amount : amount
    const pricing = bitrefillPricingFromOrder(row?.source, rowAmount)
    // Orders created by this version carry metadata.serviceFeeBps. Those must
    // carry exactly that fee, so a create refused with FEE_MISMATCH cannot be
    // resumed through a retry. Only orders without the marker (created before
    // the fee existed) may resume with their frozen zero fee.
    const markedBps = row?.metadata?.serviceFeeBps
    const markedOk = markedBps === undefined || markedBps === null ||
      (pricing && !pricing.legacy && pricing.feeBps === markedBps && pricing.serviceFee !== '0')
    if (!pricing || !markedOk) {
      return fail(502, 'FEE_MISMATCH', 'The existing payment for this Bitrefill invoice has unexpected fee data. Do not pay it; create a new Bitrefill invoice.', {
        invoiceId,
        rozoPaymentId: row.id,
      })
    }
    return fail(409, 'DUPLICATE_INVOICE', 'A payment already exists for this Bitrefill invoice. Resume it instead of paying again.', {
      invoiceId,
      rozoPaymentId: row?.id ?? null,
      original: pricing.original,
      serviceFee: pricing.serviceFee,
      feeBps: pricing.feeBps,
      callerPays: pricing.callerPays,
      // Effective expiry: the earlier of the Bitrefill expiry stored at create
      // time and the Rozo deposit's (~1h). Both are now about an hour, so either
      // can come first.
      expiresAt: earlierIso(row?.metadata?.bitrefillExpiresAt, row?.expiresAt),
      ...(row?.source ? { source: row.source } : {}),
    })
  }

  const existing = await lookupExisting()
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
    // Per-order partner fee: payment-api adds it on top of `amount` and the
    // Rozo bridge fee; Bitrefill still receives exactly `amount`.
    partnerFeeBps: BITREFILL_FEE_BPS,
    ...attributionField,
    ...(contactEmail ? { email: contactEmail } : {}),
    metadata: {
      source: 'mpprouter-create-invoice',
      provider: 'bitrefill',
      bitrefillInvoiceId: invoiceId,
      bitrefillExpiresAt: expiresAtIso,
      // Marks this order as created with the service fee (see duplicate()).
      serviceFeeBps: BITREFILL_FEE_BPS,
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

  // The fee must be exactly what we asked for: rate BITREFILL_FEE_BPS, a
  // non-zero fee no larger than that rate can produce. Anything else (missing
  // partner config, out-of-scope route) and no deposit is shown; the unpaid
  // order simply expires.
  const pricing = bitrefillPricingFromOrder(created?.source, amount)
  if (!pricing || pricing.legacy || pricing.feeBps !== BITREFILL_FEE_BPS || pricing.serviceFee === '0') {
    return fail(502, 'FEE_MISMATCH', 'The payment was not priced with the Bitrefill service fee. Do not pay it; retry later with a new Bitrefill invoice.', {
      invoiceId,
      rozoPaymentId: created?.id ?? null,
    })
  }

  // Effective expiry: the earlier of Bitrefill's and the Rozo deposit's.
  const effectiveExpiresAt = earlierIso(expiresAtIso, created?.expiresAt)

  return ok({
    provider: 'bitrefill',
    invoiceId,
    rozoPaymentId: created?.id ?? null,
    destination: { chainId: BASE_CHAIN_ID, tokenSymbol: 'USDC', address, amount },
    // Same field names as the Coinbase line: original = invoice amount
    // Bitrefill receives, serviceFee = Rozo's fee (copied from payment-api),
    // callerPays = original + serviceFee. The deposit (source.amount) adds
    // the bridge fee (source.fee) on top.
    original: pricing.original,
    serviceFee: pricing.serviceFee,
    feeBps: pricing.feeBps,
    callerPays: pricing.callerPays,
    expiresAt: effectiveExpiresAt,
    // Rozo's hosted paymentLink is intentionally withheld: that page stays
    // payable on Rozo's own ~1h clock, which can outlive the Bitrefill invoice.
    ...(created?.source ? { source: created.source } : {}),
  })
}
