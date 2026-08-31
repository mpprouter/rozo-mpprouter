import type { Env } from '../index'
import {
  normalizePayInvoiceBody,
  type PayInvoiceErrorCode,
  type PayInvoiceError,
} from './pay-invoice-admin'
import {
  resolveStripeInvoice,
  StripeResolveError,
  type NormalizedInvoice,
} from './invoice-provider'
import { stripeOrderId, seedStripeRecord } from './stripe-fulfillment'
import { checkCreateInvoiceGate } from './create-invoice-gate'
import { verifyQuoteReceipt, type QuoteReceiptPayload } from './quote-receipt'
import {
  CHECKOUT_PRICING_VERSION,
  CHECKOUT_WEB_CLIENT,
  computeServiceFeeAtomic,
  formatUsdcAtomic,
  isExactCheckoutWebClient,
  isStrictOpenRouterMerchant,
  normalizeCheckoutClient,
  parseUsdcAtomic,
  resolveCheckoutPricing,
  type CheckoutPricing,
} from './checkout-web-pricing'

const ROZO_INTENTS_URL = 'https://intentapiv4.rozo.ai/functions/v1/payment-api/'
const ROZO_INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'
const QUOTE_INVOICE_URL = 'https://agentapi.rozo.ai/quote-invoice'

const ROZO_APP_ID = 'wallet_rozopay'
// OpenRouter / Coinbase line runs under its own merchant appId (no discount,
// exactOut for Lightning). Stripe line keeps ROZO_APP_ID unchanged.
const OPENROUTER_APP_ID = 'merchant_openrouter'

const BASE_CHAIN_ID = '8453'
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Settlement: caller pays USDC on Base → merchant receives USDC on Base
// (same-chain). The receiver below is the merchant/API-developer wallet.
const SETTLEMENT_CHAIN_ID = BASE_CHAIN_ID
const SETTLEMENT_TOKEN_ADDRESS = BASE_USDC_ADDRESS
const SETTLEMENT_RECEIVER = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'

// ── Source override support (caller picks which chain/token to pay with) ──────
// Agents may optionally specify `source` to pay from a non-Base chain. Settlement
// (funder → Coinbase) is unchanged: bridge fee is absorbed by the funder wallet's
// pre-funded float, so callerPays stays the discounted USD amount regardless of
// source chain. tokenAddress is always resolved server-side from the table below
// — LLMs mistype Stellar issuers and pick wrong testnet addresses, so we ignore
// any tokenAddress the caller sends and warn them in the response.
type SourceToken = 'USDC' | 'USDT'

const SUPPORTED_SOURCE: Record<string, SourceToken[]> = {
  '1':    ['USDC', 'USDT'],   // Ethereum
  '56':   ['USDC', 'USDT'],   // BNB Smart Chain (BSC) — downstream sol/evm monitors live
  '137':  ['USDC', 'USDT'],   // Polygon
  '8453': ['USDC'],           // Base
  '900':  ['USDC', 'USDT'],   // Solana — USDT payin supported (sol-pool-monitor)
  '1500': ['USDC'],           // Stellar
}

const TOKEN_ADDRS: Record<string, Partial<Record<SourceToken, string>>> = {
  '1':    {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  '137':  {
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  // BNB Smart Chain (BSC). Addresses match downstream rozo-intents
  // rozo-address-service.ts / alchemy-client.ts. NOTE: BSC USDT/USDC are 18-decimals
  // (not 6) — decimal scaling is handled downstream (monitors/deposit-service), not
  // here; mpprouter only carries the (chainId, tokenSymbol, address) triple.
  '56':   {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
  },
  '8453': { USDC: BASE_USDC_ADDRESS },
  // Solana USDT mint. USDT payin is supported (sol-pool-monitor); Solana USDT *payout*
  // is not (rejected downstream) — irrelevant here since settlement is Base USDC.
  '900':  {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
  '1500': { USDC: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
}

export interface ResolvedSource {
  chainId: string
  tokenSymbol: SourceToken | 'BTC'
  // Empty string for chains without an ERC-20-style token address (e.g.
  // Lightning BTC, where the payment rail carries no contract address).
  tokenAddress: string
  warnings: string[]
}

export interface SourceError {
  code: 'INVALID_SOURCE' | 'UNSUPPORTED_SOURCE'
  message: string
  supported?: Record<string, SourceToken[]>
}

/**
 * Caller provenance: which surface created this order.
 *
 * The web checkout and the CLI both post to this endpoint with the same body
 * shape, so without a label every order is stored looking identical and a
 * scripted payment can only be inferred from its absence in frontend
 * analytics — negative evidence that is simply wrong for a browser user who
 * blocks analytics.
 *
 * Deliberately NOT a home for channel attribution. `attribution` is a separate
 * top-level intent field with a canonical normalizer in payment-api
 * (utm-attribution.ts), which owns the whitelist and writes it to
 * metadata.internal.attribution. Sanitizing it a second time here would be a
 * second parser for one format, and a weaker one: the canonical whitelist
 * rejects `/ : @ +` precisely because these values are persisted to JSONB and
 * read back by dashboards. We pass attribution through untouched and let the
 * one parser that owns it decide.
 *
 * `client` is ours because there is no canonical field for it. It uses the
 * same conservative charset as the attribution whitelist so it cannot
 * terminate a SQL string, open a tag or look like a URL, and it is capped
 * before it is scanned so an oversized value cannot burn Worker CPU on a
 * regex pass it was always going to discard. Malformed input is dropped, never
 * rejected: provenance is telemetry hanging off a money path and must never be
 * able to fail a payment.
 */
export interface CallerProvenance {
  client?: string
}

export function resolveClient(raw: unknown): string | null {
  return normalizeCheckoutClient(raw)
}

export function resolveSource(raw: unknown): { resolved: ResolvedSource; error?: never } | { resolved?: never; error: SourceError } {
  const warnings: string[] = []

  // No source provided → default Base USDC.
  if (raw === undefined || raw === null) {
    return {
      resolved: {
        chainId: BASE_CHAIN_ID,
        tokenSymbol: 'USDC',
        tokenAddress: BASE_USDC_ADDRESS,
        warnings,
      },
    }
  }

  if (typeof raw !== 'object') {
    return { error: { code: 'INVALID_SOURCE', message: 'source must be an object with chainId and tokenSymbol.' } }
  }

  const src = raw as Record<string, unknown>

  if (src.chainId === undefined || src.chainId === null || src.chainId === '') {
    return { error: { code: 'INVALID_SOURCE', message: 'source.chainId is required when source is provided.' } }
  }
  if (typeof src.tokenSymbol !== 'string' || !src.tokenSymbol) {
    return { error: { code: 'INVALID_SOURCE', message: 'source.tokenSymbol is required when source is provided.' } }
  }

  const chainId = String(src.chainId)
  const tokenSymbol = src.tokenSymbol.toUpperCase() as SourceToken | 'BTC'

  // Lightning (BTC) source: no chain contract address, settled via exactOut so
  // the caller pays the BTC equivalent while the merchant receives full USDC on
  // Base. Not part of the numeric-chainId USDC/USDT whitelist below.
  if (chainId === 'lightning') {
    if (tokenSymbol !== 'BTC') {
      return {
        error: {
          code: 'UNSUPPORTED_SOURCE',
          message: `tokenSymbol ${tokenSymbol} is not supported on chainId lightning — only BTC.`,
          supported: SUPPORTED_SOURCE,
        },
      }
    }
    return { resolved: { chainId: 'lightning', tokenSymbol: 'BTC', tokenAddress: '', warnings } }
  }

  const allowedTokens = SUPPORTED_SOURCE[chainId]
  if (!allowedTokens) {
    return {
      error: {
        code: 'UNSUPPORTED_SOURCE',
        message: `chainId ${chainId} is not supported as a source. See "supported" for valid (chainId, tokenSymbol) pairs.`,
        supported: SUPPORTED_SOURCE,
      },
    }
  }
  if (!allowedTokens.includes(tokenSymbol as SourceToken)) {
    return {
      error: {
        code: 'UNSUPPORTED_SOURCE',
        message: `tokenSymbol ${tokenSymbol} is not supported on chainId ${chainId}. See "supported" for valid (chainId, tokenSymbol) pairs.`,
        supported: SUPPORTED_SOURCE,
      },
    }
  }

  // Always resolve tokenAddress server-side. Caller-supplied tokenAddress is
  // ignored (with a warning) because LLM-generated Stellar issuers / wrong-net
  // contract addresses are a common failure mode.
  if ('tokenAddress' in src && src.tokenAddress !== undefined && src.tokenAddress !== null && src.tokenAddress !== '') {
    warnings.push(
      `source.tokenAddress was ignored — MPP resolves token addresses server-side from (chainId, tokenSymbol). Sent: ${String(src.tokenAddress).substring(0, 80)}`,
    )
  }

  const tokenAddress = TOKEN_ADDRS[chainId]?.[tokenSymbol as SourceToken]
  if (!tokenAddress) {
    // Should be unreachable given the whitelist above, but keep the safety net.
    return {
      error: {
        code: 'UNSUPPORTED_SOURCE',
        message: `no tokenAddress mapping for (${chainId}, ${tokenSymbol}).`,
        supported: SUPPORTED_SOURCE,
      },
    }
  }

  return { resolved: { chainId, tokenSymbol, tokenAddress, warnings } }
}

export type CreateInvoiceErrorCode =
  | PayInvoiceErrorCode
  | 'QUOTE_FETCH_FAILED'
  | 'INTENTS_API_FAILED'
  | 'SERVER_MISCONFIGURED'
  | 'INVALID_SOURCE'
  | 'UNSUPPORTED_SOURCE'
  | 'INVALID_INTENT'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'PAYMENT_ALREADY_PAID'
  | 'LEGACY_PRICING_ORDER_PENDING'
  | 'QUOTE_RECEIPT_INVALID_OR_EXPIRED'
  | 'QUOTE_RECEIPT_REQUIRED'

export interface CreateInvoiceError extends Omit<PayInvoiceError, 'code'> {
  code: CreateInvoiceErrorCode
  payment_status?: string
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, err: CreateInvoiceError): Response {
  return json(status, { error: err.message, ...err })
}

// ── Reuse of an existing Rozo intent ────────────────────────────────────────
// A row is only safe to hand back when it is still awaiting payment. Any other
// status means money is already in flight or settled, and re-serving the link
// invites a double payment.
const REUSABLE_PAYMENT_STATUS = 'payment_unpaid'

/** Status of an intents_payments row, whichever casing the API returned. */
function readPaymentStatus(row: any): string | null {
  return row?.status ?? row?.payment_status ?? null
}

/** Source (chain/token) an intents_payments row currently pays from. */
function readRowSource(row: any): { chainId: string | null; tokenSymbol: string | null } {
  const chainId = row?.source?.chainId ?? row?.source_chain_id ?? null
  const tokenSymbol = row?.source?.tokenSymbol ?? row?.source_token_symbol ?? null
  return {
    chainId: chainId === null || chainId === undefined ? null : String(chainId),
    tokenSymbol:
      tokenSymbol === null || tokenSymbol === undefined ? null : String(tokenSymbol).toUpperCase(),
  }
}

/**
 * True when the row's source is known AND differs from what this caller asked
 * for. An unknown row source is not treated as a mismatch (nothing to compare).
 */
function sourceDiffers(
  rowSource: { chainId: string | null; tokenSymbol: string | null },
  source: ResolvedSource,
): boolean {
  if (rowSource.chainId === null) return false
  return rowSource.chainId !== source.chainId || rowSource.tokenSymbol !== source.tokenSymbol
}

/**
 * Ask the Rozo payment-api to re-checkout an unpaid intent against a different
 * source chain/token, so a caller who wants to pay from another chain is not
 * silently handed the previous caller's chain.
 *
 * The upstream endpoint gates this itself: the row must still be
 * payment_unpaid, and EURC destinations / Stellar Direct orders are rejected
 * with `checkoutNotAllowed`. On success it returns the updated payment row.
 */
async function rotateExistingSource(
  env: Env,
  paymentId: string,
  source: ResolvedSource,
): Promise<{ ok: true; row: any } | { ok: false; code: string }> {
  let resp: Response
  try {
    resp = await fetch(
      `${ROZO_INTENTS_BASE}/payments/${encodeURIComponent(paymentId)}/checkout`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-API-Key': env.ROZO_INTENTS_API_KEY,
        },
        body: JSON.stringify({
          source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
        }),
      },
    )
  } catch (err: any) {
    return { ok: false, code: `network_error (${err?.message ?? 'unknown error'})` }
  }

  const text = await resp.text()
  if (!resp.ok) {
    let code = `HTTP ${resp.status}`
    try {
      const parsed: any = JSON.parse(text)
      const upstream = parsed?.error?.code ?? parsed?.code ?? parsed?.error
      if (typeof upstream === 'string' && upstream) code = upstream
    } catch {
      // Non-JSON error body — the HTTP status is the best code we have.
    }
    return { ok: false, code }
  }

  let row: any
  try {
    row = JSON.parse(text)
  } catch {
    return { ok: false, code: 'non_json_response' }
  }
  if (!row) return { ok: false, code: 'empty_response' }
  return { ok: true, row }
}

/**
 * Re-read a payment's current status straight from the Rozo payment-api.
 *
 * Used to close the lookup→rotate race: the row can leave payment_unpaid
 * between our idempotency lookup and the /checkout call (a payer funds it
 * mid-flight), in which case rotation fails with `checkoutNotAllowed` and the
 * pre-fetched row we hold is stale. Returns null when the status cannot be
 * determined (treated by callers as "unknown, keep the pre-fetched view").
 */
async function refetchPaymentStatus(env: Env, paymentId: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `${ROZO_INTENTS_BASE}/payments/${encodeURIComponent(paymentId)}`,
      { method: 'GET', headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY } },
    )
    if (!resp.ok) return null
    const row: any = await resp.json().catch(() => null)
    return readPaymentStatus(row)
  } catch {
    return null
  }
}

/** Human-readable note for a mismatch we could not rotate away. */
function sourceMismatchWarning(
  rowSource: { chainId: string | null; tokenSymbol: string | null },
  source: ResolvedSource,
  reason: string,
): string {
  return (
    `Requested ${source.tokenSymbol} on chain ${source.chainId}, but the existing ` +
    `order for this invoice pays ${rowSource.tokenSymbol ?? 'unknown'} on chain ` +
    `${rowSource.chainId ?? 'unknown'}; switching it failed (${reason}), so the ` +
    `requested source was not applied. Either pay with the existing source shown ` +
    `above, or wait for the order to expire and create a new one.`
  )
}

// Discount formula: callerPays = max(invoice - 5, invoice × 100/105)
// Small invoices get ~4.76% off; large invoices cap discount at exactly $5.
// All math done in atomic USDC (6 decimals) to avoid float drift.
export function computeCallerPaysAtomic(invoiceAtomic: bigint): bigint {
  const fiveAtomic = 5_000_000n
  const subFive = invoiceAtomic > fiveAtomic ? invoiceAtomic - fiveAtomic : 0n
  // floor(invoice × 100 / 105)
  const ratio = (invoiceAtomic * 100n) / 105n
  return subFive > ratio ? subFive : ratio
}

// USDC has 6 decimals. Parse "10.00" → 10_000_000n; "9.523809" → 9_523_809n.
// Truncates extra precision (no rounding). Throws on invalid input.
export function parseUsdc(amountDecimal: string): bigint {
  return parseUsdcAtomic(amountDecimal)
}

export function formatUsdc(atomic: bigint): string {
  return formatUsdcAtomic(atomic)
}

// Renders an amount for display in the title. Integers come back as "$105"
// (no trailing .00), non-integers as "$9.52" (truncated to 2 decimals).
export function formatTitleAmount(atomic: bigint): string {
  if (atomic % 1_000_000n === 0n) {
    return `$${atomic / 1_000_000n}`
  }
  const whole = atomic / 1_000_000n
  const cents = (atomic % 1_000_000n) / 10_000n // 6 decimals → 2 decimals (truncate)
  return `$${whole}.${cents.toString().padStart(2, '0')}`
}

export function buildTitle(
  merchant: string,
  invoiceAtomic: bigint,
  callerPaysAtomic: bigint,
): string {
  const discountAtomic = invoiceAtomic - callerPaysAtomic
  return (
    `Pay ${merchant} ${formatTitleAmount(callerPaysAtomic)}` +
    ` (originally ${formatTitleAmount(invoiceAtomic)},` +
    ` ${formatTitleAmount(discountAtomic)} Discount)`
  )
}

// OpenRouter / Coinbase line has no discount — the caller pays the full invoice
// amount, so the title is a plain "Pay <merchant> $<amount>" with no
// "originally.../Discount" clause.
export function buildFullAmountTitle(merchant: string, invoiceAtomic: bigint): string {
  return `Pay ${merchant} ${formatTitleAmount(invoiceAtomic)}`
}

function formatExactCheckoutTitleAmount(atomic: bigint): string {
  const [whole, fraction = ''] = formatUsdc(atomic).split('.')
  return `$${whole}.${fraction.padEnd(2, '0')}`
}

export function buildCheckoutTitle(merchant: string, pricing: CheckoutPricing): string {
  if (pricing.serviceFeeAtomic === 0n) {
    return buildFullAmountTitle(merchant, pricing.originalAtomic)
  }
  return (
    `Pay ${merchant} ${formatExactCheckoutTitleAmount(pricing.callerPaysAtomic)}` +
    ` (includes ${formatExactCheckoutTitleAmount(pricing.serviceFeeAtomic)} service fee)`
  )
}

function pricingFields(pricing: CheckoutPricing) {
  return {
    original: formatUsdc(pricing.originalAtomic),
    serviceFee: formatUsdc(pricing.serviceFeeAtomic),
    callerPays: formatUsdc(pricing.callerPaysAtomic),
    feeBps: pricing.feeBps,
    pricingVersion: pricing.pricingVersion,
  }
}

/**
 * Recover the exact signed pricing snapshot from a v2 quote receipt.
 * The raw fee-eligibility client identity is bound too, so a zero-fee CLI or
 * sanitized lookalike quote cannot be replayed by the browser when its canary
 * is enabled. v1 receipts simply return null and are repriced using the current
 * policy (safe backwards compatibility).
 */
function pricingFromReceipt(
  receipt: QuoteReceiptPayload | null,
  originalAtomic: bigint,
  merchant: string,
  pricingClient: string | null,
): CheckoutPricing | null {
  // Bind the raw eligibility identity, not the lossy provenance label. For
  // example `rozo-checkout-web!!!` normalizes to the browser label for
  // telemetry but is deliberately NOT fee-eligible and must not mint a zero-
  // fee receipt that can later be replayed by the exact browser client.
  if (receipt?.v !== 2 || receipt.client !== pricingClient) return null
  if (
    receipt.pricingVersion !== CHECKOUT_PRICING_VERSION ||
    receipt.original === undefined ||
    receipt.serviceFee === undefined ||
    receipt.callerPays === undefined ||
    receipt.feeBps === undefined
  ) {
    return null
  }
  try {
    const signedOriginal = parseUsdc(receipt.original)
    const signedFee = parseUsdc(receipt.serviceFee)
    const signedCallerPays = parseUsdc(receipt.callerPays)
    if (
      signedOriginal !== originalAtomic ||
      signedOriginal + signedFee !== signedCallerPays ||
      computeServiceFeeAtomic(signedOriginal, receipt.feeBps) !== signedFee
    ) {
      return null
    }
    const eligible =
      pricingClient === CHECKOUT_WEB_CLIENT && isStrictOpenRouterMerchant(merchant)
    if (!eligible && (receipt.feeBps !== 0 || signedFee !== 0n)) return null
    return {
      originalAtomic: signedOriginal,
      serviceFeeAtomic: signedFee,
      callerPaysAtomic: signedCallerPays,
      feeBps: receipt.feeBps,
      pricingVersion: CHECKOUT_PRICING_VERSION,
    }
  } catch {
    return null
  }
}

function readMetadataObject(row: any): Record<string, unknown> | null {
  let metadata = row?.metadata
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata)
    } catch {
      return null
    }
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null
}

/**
 * Reuse is safe only when the payable intent still represents this exact
 * price. Legacy zero-fee rows are accepted when their amount matches; once a
 * fee is enabled, missing/partial pricing metadata fails closed.
 */
function pendingPricingMatches(row: any, pricing: CheckoutPricing): boolean {
  const source = readRowSource(row)
  const rowAmountRaw =
    source.chainId === 'lightning'
      ? row?.destination?.amount ?? row?.destination_amount
      : row?.source?.amount ?? row?.source_amount

  let amountMatches: boolean | null = null
  if (typeof rowAmountRaw === 'string') {
    try {
      amountMatches = parseUsdc(rowAmountRaw) === pricing.callerPaysAtomic
    } catch {
      amountMatches = null
    }
  }

  const metadata = readMetadataObject(row)
  const candidates = [metadata, metadata?.internal]
  const expected = pricingFields(pricing)
  const stored = candidates.find((candidate) =>
    candidate &&
    typeof candidate === 'object' &&
    ['original', 'serviceFee', 'callerPays', 'feeBps', 'pricingVersion'].some(
      (key) => key in candidate,
    ),
  ) as Record<string, unknown> | undefined

  const metadataMatches = !!stored && (
    stored.original === expected.original &&
    stored.serviceFee === expected.serviceFee &&
    stored.callerPays === expected.callerPays &&
    stored.feeBps === expected.feeBps &&
    stored.pricingVersion === expected.pricingVersion
  )

  // Reuse requires positive pricing evidence. A readable exact amount is
  // sufficient when upstream omits metadata. If amount is unavailable, an
  // exact persisted pricing tuple is required; otherwise rollback could report
  // the original price while returning a link that still collects a fee.
  if (amountMatches === false) return false
  if (amountMatches === true) return !stored || metadataMatches
  return metadataMatches
}

function pricingMismatchResponse(
  providerFields: Record<string, unknown>,
  row: any,
): Response {
  return json(409, {
    ok: false,
    ...providerFields,
    error: {
      code: 'LEGACY_PRICING_ORDER_PENDING',
      message:
        'An unpaid order for this invoice exists under different pricing and ' +
        'cannot be reused. Wait for it to expire, then create a new order.',
    },
    rozoPaymentId: row?.id ?? null,
    expiresAt: row?.expiresAt ?? null,
  })
}

function quoteReceiptErrorResponse(
  providerFields: Record<string, unknown> = {},
): Response {
  return json(409, {
    ok: false,
    ...providerFields,
    error: {
      code: 'QUOTE_RECEIPT_INVALID_OR_EXPIRED',
      message:
        'The signed quote is invalid, expired, or does not match this request. ' +
        'Request a fresh quote before creating the invoice.',
    },
  })
}

function quoteReceiptRequiredResponse(
  providerFields: Record<string, unknown> = {},
): Response {
  return json(409, {
    ok: false,
    ...providerFields,
    error: {
      code: 'QUOTE_RECEIPT_REQUIRED',
      message:
        'This priced checkout requires a signed quote from invoice-details. ' +
        'Refresh the invoice details before creating it.',
    },
  })
}

export async function handleCreateInvoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return errorResponse(500, {
      code: 'SERVER_MISCONFIGURED',
      message: 'PAYINVOICE_ADMIN_SECRET is not configured',
    })
  }
  if (!env.ROZO_INTENTS_API_KEY) {
    return errorResponse(500, {
      code: 'SERVER_MISCONFIGURED',
      message: 'ROZO_INTENTS_API_KEY is not configured',
    })
  }

  // Anti-abuse gate: per-IP hourly rate limit + global hourly creation circuit
  // breaker (fail-open on DO error). Same-payment reuse is handled below via the
  // idempotency lookup; this caps raw creation volume from a spray/botnet.
  const gate = await checkCreateInvoiceGate(request, env)
  if (!gate.ok) {
    if (gate.reason === 'global_circuit_open') {
      return errorResponse(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Invoice creation is temporarily paused. Please try again shortly.',
      })
    }
    return errorResponse(429, {
      code: 'RATE_LIMITED',
      message: 'Too many invoice creation requests. Please try again later.',
    })
  }

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return errorResponse(400, { code: 'INVALID_INPUT', message: 'Invalid JSON body' })
  }

  const { normalized, error, link_id_detected, provider_detected } =
    normalizePayInvoiceBody(parsed)
  if (!normalized || error) {
    return errorResponse(400, {
      code: error?.code ?? 'INVALID_INPUT',
      message: error?.message ?? 'Could not normalize request body.',
      hint: error?.hint,
      normalized_input: error?.normalized_input,
      link_id_detected: link_id_detected ?? null,
      route_capabilities: error?.route_capabilities,
    })
  }

  // Source override (optional). If caller provided `source`, validate against
  // the whitelist; otherwise default to Base USDC.
  //
  // This runs BEFORE the provider branch on purpose. It used to sit after the
  // Stripe early-return, so a Stripe caller's `source` was silently dropped and
  // the intent was forced to Base USDC — worse than rejecting it, because the
  // caller was charged on a chain they did not ask for with no error. Both
  // providers now share one source-resolution path and one error contract.
  const sourceRaw = (parsed as Record<string, unknown> | null)?.source
  const sourceResult = resolveSource(sourceRaw)

  // Caller provenance. Never fails the request — bad input is dropped, not rejected.
  const provenance: CallerProvenance = {}
  const clientRaw = (parsed as Record<string, unknown> | null)?.client
  const clientLabel = resolveClient(clientRaw)
  const pricingClient = isExactCheckoutWebClient(clientRaw) ? CHECKOUT_WEB_CLIENT : null
  if (clientLabel) provenance.client = clientLabel

  // Channel attribution rides as a top-level intent field, untouched. The web
  // checkout has been sending it since launch and this route dropped it, so
  // every order was stored unattributed. payment-api owns the whitelist.
  const attributionRaw = (parsed as Record<string, unknown> | null)?.attribution
  const attributionField =
    attributionRaw && typeof attributionRaw === 'object' && !Array.isArray(attributionRaw)
      ? { attribution: attributionRaw }
      : {}
  const receiptRaw = (parsed as Record<string, unknown> | null)?.quoteReceipt
  if (sourceResult.error) {
    return errorResponse(400, {
      code: sourceResult.error.code,
      message: sourceResult.error.message,
      normalized_input: normalized,
      link_id_detected,
      // Surface supported (chainId, tokenSymbol) combos so agents self-correct.
      ...(sourceResult.error.supported ? { supported_sources: sourceResult.error.supported } : {}),
    } as CreateInvoiceError & { supported_sources?: Record<string, SourceToken[]> })
  }
  const source = sourceResult.resolved

  // Pay-in intent override (optional). Only 'stellar_payin_contracts' is
  // recognized: the upstream payment-api then freezes the order in contract
  // pay-in mode (per-payment Stellar C-address, no memo needed) instead of the
  // classic hub G-address + memo, and its response exposes
  // receiverAddressContract + receiverMemoContract (emitted together, contract
  // orders only — database.ts gates the fields on the frozen mode). The mode is
  // frozen at create time upstream, so a reused unpaid order created without it
  // cannot be upgraded by rotation — that case is reported, not silently kept.
  const intentRaw = (parsed as Record<string, unknown> | null)?.intent
  let payinIntent: 'stellar_payin_contracts' | null = null
  if (intentRaw !== undefined && intentRaw !== null && intentRaw !== '') {
    if (intentRaw !== 'stellar_payin_contracts') {
      return errorResponse(400, {
        code: 'INVALID_INTENT',
        message:
          'intent must be "stellar_payin_contracts" when provided. Sent: ' +
          (typeof intentRaw === 'string'
            ? intentRaw.substring(0, 60)
            : `(${typeof intentRaw})`),
        normalized_input: normalized,
        link_id_detected,
      })
    }
    if (source.chainId !== '1500') {
      return errorResponse(400, {
        code: 'INVALID_INTENT',
        message:
          'intent "stellar_payin_contracts" requires source {"chainId":"1500","tokenSymbol":"USDC"} (Stellar).',
        normalized_input: normalized,
        link_id_detected,
      })
    }
    payinIntent = 'stellar_payin_contracts'
  }

  // Stripe crypto create-invoice: resolve the session, create/reuse a Rozo
  // intent, and seed the locked fulfillment record. Fulfillment itself is
  // money movement done by the (disabled-by-default) Supabase pay-invoice
  // Stripe branch, driven later by the webhook. Coinbase is unaffected.
  if (provider_detected === 'stripe_crypto') {
    const stripeUrl = (normalized as { url?: string }).url
    if (!stripeUrl) {
      // Should be unreachable: provider_detected requires a URL. Never echo it.
      return errorResponse(400, {
        code: 'INVALID_INPUT',
        message: 'Stripe invoice requires a url.',
      })
    }
    if (payinIntent) {
      // The Stripe branch builds its own intents body and does not carry the
      // intent through; dropping it silently would hand the caller a classic
      // G-address order they did not ask for (same rationale as source above).
      return errorResponse(400, {
        code: 'INVALID_INTENT',
        message: 'intent "stellar_payin_contracts" is not supported for Stripe invoices yet.',
        normalized_input: normalized,
        link_id_detected,
      })
    }
    return handleStripeCreateInvoice(
      stripeUrl,
      env,
      source,
      provenance,
      pricingClient,
      typeof receiptRaw === 'string' ? receiptRaw : null,
    )
  }

  let quote: any
  const normalizedPaymentId =
    'payment_id' in normalized ? normalized.payment_id : link_id_detected
  const receipt =
    typeof receiptRaw === 'string' && normalizedPaymentId
      ? await verifyQuoteReceipt(
          receiptRaw,
          normalizedPaymentId,
          env.PAYINVOICE_ADMIN_SECRET,
        )
      : null

  if (receipt) {
    quote = {
      invoice: { amount: receipt.amount },
      merchant: receipt.merchant,
      linkId: receipt.paymentId,
    }
  } else {
    // Backward compatibility: a missing or invalid receipt gets a fresh
    // server-side quote while pricing is disabled. Once a browser fee is active,
    // the policy check below rejects invalid receipts instead of silently
    // changing a price the customer may already have seen.
    let quoteResp: Response
    let quoteErrorDetail: string | null = null
    try {
      quoteResp = await fetch(QUOTE_INVOICE_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
        },
        body: JSON.stringify(normalized),
      })

      // A freshly-created Coinbase v3 session can briefly read as not payable
      // before its CREATED state is visible on the next provider read. Retry one
      // ambiguous conflict after a short bounded delay. Definitive paid/used
      // states are never retried or softened.
      if (
        !quoteResp.ok &&
        quoteResp.status === 409 &&
        normalizedPaymentId?.startsWith('paymentSession_')
      ) {
        const firstDetail = await quoteResp.text()
        quoteErrorDetail = firstDetail
        const definitive =
          /PAYMENT_SESSION_STATUS_[A-Z_]+/.test(firstDetail) ||
          /already fully used/i.test(firstDetail)
        if (!definitive) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          quoteResp = await fetch(QUOTE_INVOICE_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
            },
            body: JSON.stringify(normalized),
          })
          quoteErrorDetail = null
        }
      }
    } catch (err: any) {
      return errorResponse(502, {
        code: 'QUOTE_FETCH_FAILED',
        message: `Quote upstream unreachable: ${err?.message ?? 'unknown error'}`,
        normalized_input: normalized,
        link_id_detected,
      })
    }

    if (!quoteResp.ok) {
      const detail = quoteErrorDetail ?? await quoteResp.text()
      if (quoteResp.status === 409 || quoteResp.status === 410) {
        // Upstream 409 detail carries the real Coinbase state, e.g.
        // "payment session is not payable: PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED"
        // or "payment link already fully used (1/1)". A captured session or a
        // fully-used single-use link means the invoice was PAID — surface that
        // distinctly so the FE can show a success state instead of "expired".
        const paymentStatus =
          detail.match(/PAYMENT_SESSION_STATUS_[A-Z_]+/)?.[0] ?? null
        const alreadyPaid =
          paymentStatus === 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' ||
          /already fully used/i.test(detail)
        if (alreadyPaid) {
          return errorResponse(409, {
            code: 'PAYMENT_ALREADY_PAID',
            message: 'This payment link has already been paid.',
            hint: 'No further action needed — the payment completed successfully.',
            normalized_input: normalized,
            link_id_detected,
            ...(paymentStatus ? { payment_status: paymentStatus } : {}),
          })
        }
        return errorResponse(quoteResp.status, {
          code: 'LINK_USED_OR_EXPIRED',
          message: 'Payment link has already been used or has expired.',
          hint: 'Request a new payment link from the merchant.',
          normalized_input: normalized,
          link_id_detected,
          ...(paymentStatus ? { payment_status: paymentStatus } : {}),
        })
      }
      return errorResponse(502, {
        code: 'QUOTE_FETCH_FAILED',
        message: 'Quote upstream returned an error.',
        hint: detail.substring(0, 300),
        normalized_input: normalized,
        link_id_detected,
      })
    }

    try {
      quote = await quoteResp.json()
    } catch {
      return errorResponse(502, {
        code: 'QUOTE_FETCH_FAILED',
        message: 'Quote upstream returned non-JSON body.',
        normalized_input: normalized,
        link_id_detected,
      })
    }
  }

  const invoiceAmount: string | undefined = quote?.invoice?.amount
  const merchantName: string | null = quote?.merchant ?? null
  const linkId: string | null = quote?.linkId ?? link_id_detected ?? null
  if (!invoiceAmount || !merchantName) {
    return errorResponse(502, {
      code: 'QUOTE_FETCH_FAILED',
      message: 'Quote response missing invoice.amount or merchant.',
      hint: JSON.stringify(quote).substring(0, 300),
      normalized_input: normalized,
      link_id_detected,
    })
  }

  // Step 2: compute the browser-only fee (default off), or honor the exact
  // signed v2 quote snapshot when the same client submits it within its TTL.
  let invoiceAtomic: bigint
  try {
    invoiceAtomic = parseUsdc(invoiceAmount)
  } catch (e: any) {
    return errorResponse(502, {
      code: 'QUOTE_FETCH_FAILED',
      message: `Quote returned unparseable amount: ${e?.message ?? invoiceAmount}`,
      normalized_input: normalized,
      link_id_detected,
    })
  }
  const currentPricing = resolveCheckoutPricing(
    invoiceAtomic,
    merchantName,
    pricingClient,
    env.CHECKOUT_WEB_FEE_BPS,
  )
  if (!receipt && currentPricing.feeBps > 0) {
    return typeof receiptRaw === 'string'
      ? quoteReceiptErrorResponse({ linkId })
      : quoteReceiptRequiredResponse({ linkId })
  }
  const receiptPricing = pricingFromReceipt(
    receipt,
    invoiceAtomic,
    merchantName,
    pricingClient,
  )
  if (
    (currentPricing.feeBps > 0 && receipt?.v === 2 && !receiptPricing) ||
    (receipt?.v === 1 && currentPricing.feeBps !== 0)
  ) {
    return quoteReceiptErrorResponse({ linkId })
  }
  const pricing = receiptPricing ?? currentPricing
  const priced = pricingFields(pricing)
  const callerPays = priced.callerPays
  const originalStr = priced.original
  const discountStr = '0'
  const title = buildCheckoutTitle(merchantName, pricing)

  // Step 3a: idempotency — if an intent already exists for this Coinbase
  // link, reuse it instead of creating a new one. The Rozo payment-api
  // exposes GET /payments/order/:appId/:orderId for this purpose; we use
  // the pl_* id as the orderId so the same Coinbase link always maps to
  // the same Rozo intent. An expired hit is treated as a miss (so callers
  // never get a dead payment link back).
  const orderId = linkId
  if (orderId) {
    let lookup: Response | null = null
    try {
      lookup = await fetch(
        `${ROZO_INTENTS_BASE}/payments/order/${encodeURIComponent(OPENROUTER_APP_ID)}/${encodeURIComponent(orderId)}`,
        {
          method: 'GET',
          headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY },
        },
      )
    } catch {
      // Network blip on lookup is non-fatal — fall through to create.
      lookup = null
    }

    if (lookup && lookup.ok) {
      const existing: any = await lookup.json().catch(() => null)
      const existingExpiresAt: string | null = existing?.expiresAt ?? null
      const stillValid =
        existingExpiresAt && Date.parse(existingExpiresAt) > Date.now()
      if (existing && stillValid) {
        const existingStatus = readPaymentStatus(existing)
        if (existingStatus !== REUSABLE_PAYMENT_STATUS) {
          // Unexpired but already funded / settled / in flight. Falling through
          // to create would only earn a 409 orderIdConflict upstream, so answer
          // the caller directly instead of letting them pay a second time.
          return json(409, {
            ok: false,
            error: {
              code: 'ORDER_ALREADY_ACTIVE',
              message:
                `An order already exists for this invoice and is no longer awaiting ` +
                `payment (status: ${existingStatus ?? 'unknown'}). Do not pay again — ` +
                `poll the payment status instead.`,
            },
            linkId,
            rozoPaymentId: existing?.id ?? null,
            status: existingStatus,
            expiresAt: existingExpiresAt,
          })
        }

        if (!pendingPricingMatches(existing, pricing)) {
          return pricingMismatchResponse({ linkId }, existing)
        }

        // Unpaid and unexpired → reusable. If this caller asked for a different
        // chain/token than the order currently pays from, try to rotate the
        // order onto the requested source rather than silently echoing the old
        // one back (which used to make agents abort and lose the sale).
        let row: any = existing
        let rowSource = readRowSource(existing)
        let sourceRotated = false
        let rotationFailure: string | null = null
        // Lightning has a BOLT11 invoice lifecycle that re-checkout does not
        // support, so a mismatch on either side is reported, never rotated.
        const lightningInvolved =
          source.chainId === 'lightning' || rowSource.chainId === 'lightning'
        if (sourceDiffers(rowSource, source) && existing?.id) {
          if (lightningInvolved) {
            rotationFailure = 'lightning_not_rotatable'
          } else {
            const rotated = await rotateExistingSource(env, String(existing.id), source)
            if (rotated.ok) {
              row = rotated.row
              rowSource = readRowSource(rotated.row)
              sourceRotated = true
            } else {
              rotationFailure = rotated.code
            }
          }
        }

        // Close the lookup→rotate race (codex P1): the row can leave
        // payment_unpaid while the /checkout call is in flight, in which case
        // returning the pre-fetched link as payable invites a double payment.
        // The rotated row carries its own status; after a failure we re-read it.
        const postRotationStatus = sourceRotated
          ? readPaymentStatus(row)
          : rotationFailure
            ? await refetchPaymentStatus(env, String(existing?.id ?? ''))
            : REUSABLE_PAYMENT_STATUS
        if (postRotationStatus !== null && postRotationStatus !== REUSABLE_PAYMENT_STATUS) {
          return json(409, {
            ok: false,
            error: {
              code: 'ORDER_ALREADY_ACTIVE',
              message:
                `An order already exists for this invoice and is no longer awaiting ` +
                `payment (status: ${postRotationStatus}). Do not pay again — ` +
                `poll the payment status instead.`,
            },
            linkId,
            rozoPaymentId: row?.id ?? existing?.id ?? null,
            status: postRotationStatus,
            expiresAt: row?.expiresAt ?? existingExpiresAt,
          })
        }

        const warnings = [...source.warnings]
        if (rotationFailure) {
          warnings.push(sourceMismatchWarning(rowSource, source, rotationFailure))
        }

        // Contract pay-in mode is frozen upstream at create time; /checkout
        // rotation preserves the stored intent but can never add or remove it.
        // Flag a mismatch in BOTH directions: contract requested but the row is
        // classic (a C-address will never come), and intent omitted but the row
        // is contract-mode (a classic G-wallet cannot pay the contract rail).
        const rowIsContractMode = Boolean(row?.source?.receiverAddressContract)
        const intentMismatch = (payinIntent !== null) !== rowIsContractMode
        if (intentMismatch) {
          const rowIsClassicStellar = rowSource.chainId === '1500'
          warnings.push(
            payinIntent !== null
              ? 'Requested intent "stellar_payin_contracts", but the existing unpaid ' +
                'order for this invoice was created without it and the pay-in mode ' +
                'cannot be changed after creation. ' +
                (rowIsClassicStellar
                  ? 'Pay the classic G-address + memo in raw.source ' +
                    '(receiverAddress + receiverMemo), or wait'
                  : 'Pay the source shown in raw.source, or wait') +
                ' for the order to expire and re-create with the intent.'
              : 'The existing unpaid order for this invoice was created with intent ' +
                '"stellar_payin_contracts" (contract pay-in): pay via the contract ' +
                'rail in raw.source (receiverAddressContract + receiverMemoContract), ' +
                'NOT a classic G-address payment, or wait for the order to expire ' +
                'and re-create without the intent.',
          )
        }

        return json(200, {
          ok: true,
          reused: true,
          linkId,
          merchant: merchantName,
          original: originalStr,
          serviceFee: priced.serviceFee,
          callerPays,
          feeBps: priced.feeBps,
          pricingVersion: priced.pricingVersion,
          discount: discountStr,
          title,
          paymentLink:
            row?.paymentLink ?? row?.url ?? row?.payment_link ?? null,
          rozoPaymentId: row?.id ?? existing?.id ?? null,
          expiresAt: row?.expiresAt ?? existingExpiresAt,
          // The source the order actually pays from now — rotated to the
          // requested one when that worked, otherwise the pre-existing one.
          source: {
            chainId: rowSource.chainId,
            tokenSymbol: rowSource.tokenSymbol,
          },
          ...(sourceRotated ? { sourceRotated: true } : {}),
          ...(rotationFailure ? { sourceMismatch: true } : {}),
          ...(intentMismatch ? { intentMismatch: true } : {}),
          ...(warnings.length ? { warnings } : {}),
          raw: row,
        })
      }
    }
  }

  // Step 3b: no usable existing intent → create one.
  //
  // Lightning (BTC) source → exactOut: the caller pays the BTC equivalent, and
  // the destination.amount pins the full USDC the merchant must receive. Rozo
  // has no fixed source.amount to quote against here (BTC price floats), so we
  // omit source.amount / source.tokenAddress and let Rozo quote the input.
  //
  // Non-Lightning (existing EVM USDC/USDT) source → exactIn: the caller pays the
  // full invoice amount on source, destination carries no amount.
  const isLightning = source.chainId === 'lightning'
  const intentsBody = isLightning
    ? {
        appId: OPENROUTER_APP_ID,
        orderId: orderId ?? `mpprouter-${Date.now()}`,
        type: 'exactOut',
        display: {
          title,
          currency: 'USD',
        },
        source: {
          chainId: 'lightning',
          tokenSymbol: 'BTC',
        },
        destination: {
          chainId: SETTLEMENT_CHAIN_ID,
          receiverAddress: SETTLEMENT_RECEIVER,
          tokenSymbol: 'USDC',
          tokenAddress: SETTLEMENT_TOKEN_ADDRESS,
          amount: callerPays,
        },
        ...attributionField,
        metadata: {
          source: 'mpprouter-create-invoice',
          coinbasePaymentLinkId: linkId,
          ...provenance,
          ...priced,
        },
      }
    : {
        appId: OPENROUTER_APP_ID,
        orderId: orderId ?? `mpprouter-${Date.now()}`,
        type: 'exactIn',
        // Optional Stellar contract pay-in — validated above (Stellar source
        // only); upstream payment-api freezes the C-address mode from this.
        ...(payinIntent ? { intent: payinIntent } : {}),
        display: {
          title,
          currency: 'USD',
        },
        source: {
          chainId: source.chainId,
          tokenSymbol: source.tokenSymbol,
          amount: callerPays,
          tokenAddress: source.tokenAddress,
        },
        destination: {
          chainId: SETTLEMENT_CHAIN_ID,
          receiverAddress: SETTLEMENT_RECEIVER,
          tokenSymbol: 'USDC',
          tokenAddress: SETTLEMENT_TOKEN_ADDRESS,
        },
        ...attributionField,
        metadata: {
          source: 'mpprouter-create-invoice',
          coinbasePaymentLinkId: linkId,
          ...provenance,
          ...priced,
        },
  }

  let intentsResp: Response
  try {
    intentsResp = await fetch(ROZO_INTENTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': env.ROZO_INTENTS_API_KEY,
      },
      body: JSON.stringify(intentsBody),
    })
  } catch (err: any) {
    return errorResponse(502, {
      code: 'INTENTS_API_FAILED',
      message: `Rozo intents API unreachable: ${err?.message ?? 'unknown error'}`,
      normalized_input: normalized,
      link_id_detected,
    })
  }

  const intentsText = await intentsResp.text()
  if (!intentsResp.ok) {
    // A 409 orderIdConflict means this orderId (derived from the payment link)
    // was already used to create an intent. The link is spent, not our outage —
    // classify it as such so the FE can tell the user to get a fresh link
    // instead of showing a generic "try again shortly".
    if (
      intentsResp.status === 409 &&
      /orderIdConflict/i.test(intentsText)
    ) {
      return errorResponse(409, {
        code: 'LINK_USED_OR_EXPIRED',
        message: 'Payment link has already been used or has expired.',
        hint: 'Request a new payment link from the merchant.',
        normalized_input: normalized,
        link_id_detected,
      })
    }
    return errorResponse(502, {
      code: 'INTENTS_API_FAILED',
      message: `Rozo intents API returned ${intentsResp.status}.`,
      hint: intentsText.substring(0, 500),
      normalized_input: normalized,
      link_id_detected,
    })
  }

  let intentsJson: any
  try {
    intentsJson = JSON.parse(intentsText)
  } catch {
    return errorResponse(502, {
      code: 'INTENTS_API_FAILED',
      message: 'Rozo intents API returned non-JSON body.',
      hint: intentsText.substring(0, 300),
      normalized_input: normalized,
      link_id_detected,
    })
  }

  const paymentLink =
    intentsJson?.paymentLink ??
    intentsJson?.url ??
    intentsJson?.payment_link ??
    intentsJson?.data?.url ??
    null
  const rozoPaymentId =
    intentsJson?.id ?? intentsJson?.paymentId ?? intentsJson?.data?.id ?? null
  const expiresAt = intentsJson?.expiresAt ?? null

  return json(200, {
    ok: true,
    reused: false,
    linkId,
    merchant: merchantName,
    original: originalStr,
    serviceFee: priced.serviceFee,
    callerPays,
    feeBps: priced.feeBps,
    pricingVersion: priced.pricingVersion,
    discount: discountStr,
    title,
    paymentLink,
    rozoPaymentId,
    expiresAt,
    source: {
      chainId: source.chainId,
      tokenSymbol: source.tokenSymbol,
      tokenAddress: source.tokenAddress,
    },
    ...(source.warnings.length ? { warnings: source.warnings } : {}),
    raw: intentsJson,
  })
}

// ── Stripe Crypto create-invoice ────────────────────────────────────────────
//
// Resolves the Stripe session (read-only, via invoice-provider), applies the
// same discount formula as Coinbase, creates/reuses a Rozo intent under a
// provider-qualified orderId, and seeds the locked fulfillment record so the
// webhook can settle later WITHOUT trusting the Rozo webhook payload to carry
// metadata. Moves no money here.
//
// SECURITY: the Stripe URL carries a replayable /pay/<blob> session hash. It is
// stored ONLY in the seeded KV record (never in Rozo metadata, never in any
// response, never logged). The Rozo metadata carries only the non-secret locked
// fields (design §6).
/**
 * Stripe crypto create-invoice.
 *
 * `source` is the caller's chosen pay-with chain/token, already validated by
 * `resolveSource()` — the SAME resolution the Coinbase branch uses. It controls
 * only the leg the caller funds. It does NOT change:
 *   - `destination` — always Base USDC to SETTLEMENT_RECEIVER (the funder wallet)
 *   - the downstream payment to Stripe itself — always Base USDC
 */
export async function handleStripeCreateInvoice(
  stripeUrl: string,
  env: Env,
  source: ResolvedSource,
  provenance: CallerProvenance = {},
  pricingClient: string | null = null,
  quoteReceiptRaw: string | null = null,
): Promise<Response> {
  // 1. Resolve the session (read-only).
  let invoice: NormalizedInvoice
  try {
    invoice = await resolveStripeInvoice(stripeUrl)
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
      return json(status, { ok: false, provider: 'stripe_crypto', error: err.message, reason: err.kind })
    }
    return json(502, { ok: false, provider: 'stripe_crypto', error: 'Failed to resolve Stripe invoice' })
  }

  // 2. Refuse to create an unfulfillable order (design §12: 422 no wallet_connect).
  if (!invoice.payable) {
    return json(422, {
      ok: false,
      provider: 'stripe_crypto',
      invoiceKey: invoice.invoiceKey,
      error: 'Stripe invoice is not payable under Phase 1 constraints.',
      reason: invoice.payableReason,
    })
  }

  // 3. Apply the same narrow browser-only pricing policy as Coinbase. A
  // fee-bearing browser create must present the signed snapshot issued by
  // invoice-details, so the confirm card and payable intent cannot diverge.
  let invoiceAtomic: bigint
  try {
    invoiceAtomic = BigInt(invoice.stablecoinAmountAtomic)
  } catch {
    return json(502, { ok: false, provider: 'stripe_crypto', error: 'Unparseable invoice amount.' })
  }
  if (invoiceAtomic <= 0n) {
    return json(422, { ok: false, provider: 'stripe_crypto', error: 'Invoice amount must be positive.' })
  }
  const receipt = quoteReceiptRaw !== null
    ? await verifyQuoteReceipt(
        quoteReceiptRaw,
        invoice.invoiceKey,
        env.PAYINVOICE_ADMIN_SECRET,
      )
    : null
  const currentPricing = resolveCheckoutPricing(
    invoiceAtomic,
    invoice.merchantTitle,
    pricingClient,
    env.CHECKOUT_WEB_FEE_BPS,
  )
  if (!receipt && currentPricing.feeBps > 0) {
    return quoteReceiptRaw !== null
      ? quoteReceiptErrorResponse({
          provider: 'stripe_crypto',
          invoiceKey: invoice.invoiceKey,
        })
      : quoteReceiptRequiredResponse({
          provider: 'stripe_crypto',
          invoiceKey: invoice.invoiceKey,
        })
  }
  const receiptPricing = pricingFromReceipt(
    receipt,
    invoiceAtomic,
    invoice.merchantTitle,
    pricingClient,
  )
  if (
    (currentPricing.feeBps > 0 && receipt?.v === 2 && !receiptPricing) ||
    (receipt?.v === 1 && currentPricing.feeBps !== 0)
  ) {
    return quoteReceiptErrorResponse({
      provider: 'stripe_crypto',
      invoiceKey: invoice.invoiceKey,
    })
  }
  const pricing = receiptPricing ?? currentPricing
  const priced = pricingFields(pricing)
  const callerPays = priced.callerPays
  const originalStr = priced.original
  const discountStr = '0'
  const title = buildCheckoutTitle(invoice.merchantTitle, pricing)

  // 4. Provider-qualified orderId (design §6): stripe_crypto_<cpis_*>.
  const orderId = stripeOrderId(invoice.invoiceKey)

  // 5. Idempotency: reuse an existing, still-valid Rozo intent for this order.
  // "Valid" means unexpired AND still awaiting payment — an unexpired row in any
  // other status is already funded/settled and must never be handed back.
  let existing: any = null
  let activeConflict: any = null
  try {
    const lookup = await fetch(
      `${ROZO_INTENTS_BASE}/payments/order/${encodeURIComponent(ROZO_APP_ID)}/${encodeURIComponent(orderId)}`,
      { method: 'GET', headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY } },
    )
    if (lookup.ok) {
      const found: any = await lookup.json().catch(() => null)
      const foundExpiresAt: string | null = found?.expiresAt ?? null
      if (found && foundExpiresAt && Date.parse(foundExpiresAt) > Date.now()) {
        if (readPaymentStatus(found) === REUSABLE_PAYMENT_STATUS) existing = found
        else activeConflict = found
      }
    }
  } catch {
    // Non-fatal — fall through to create.
  }

  if (existing && !pendingPricingMatches(existing, pricing)) {
    return pricingMismatchResponse(
      { provider: 'stripe_crypto', invoiceKey: invoice.invoiceKey },
      existing,
    )
  }

  // Creating again under the same orderId would just 409 orderIdConflict
  // upstream, so tell the caller the order is already active instead.
  if (activeConflict) {
    const conflictStatus = readPaymentStatus(activeConflict)
    return json(409, {
      ok: false,
      provider: 'stripe_crypto',
      error: {
        code: 'ORDER_ALREADY_ACTIVE',
        message:
          `An order already exists for this invoice and is no longer awaiting ` +
          `payment (status: ${conflictStatus ?? 'unknown'}). Do not pay again — ` +
          `poll the payment status instead.`,
      },
      invoiceKey: invoice.invoiceKey,
      rozoPaymentId: activeConflict?.id ?? null,
      status: conflictStatus,
      expiresAt: activeConflict?.expiresAt ?? null,
    })
  }

  // 6. Locked metadata (design §6). NO url / session hash / secrets.
  const lockedMetadata = {
    source: 'mpprouter-create-invoice',
    ...provenance,
    invoiceProvider: 'stripe_crypto',
    invoiceKey: invoice.invoiceKey,
    invoiceLockFingerprint: invoice.lockFingerprint,
    merchantAccount: invoice.merchantAccount,
    invoiceAmountAtomic: invoice.stablecoinAmountAtomic,
    invoiceCurrency: invoice.fiatCurrency,
    settlementChainId: SETTLEMENT_CHAIN_ID,
    settlementToken: 'USDC',
    ...priced,
  }

  let rozoPaymentId: string | null
  let paymentLink: string | null
  let expiresAt: string | null
  let reused: boolean
  // The Rozo intent payload (deposit instructions incl. lnInvoice), echoed as
  // `raw` exactly like the Coinbase branch so the checkout frontend can render
  // the payin QR. Contains no Stripe URL/secrets — it is Rozo's own object.
  let rawIntent: unknown = null

  // Source the reused order actually pays from, plus how we got there.
  let reusedSource: { chainId: string | null; tokenSymbol: string | null } = {
    chainId: null,
    tokenSymbol: null,
  }
  let sourceRotated = false
  let rotationFailure: string | null = null

  if (existing) {
    // The order is unpaid, so if this caller wants a different chain/token we
    // can try to move the order onto it instead of silently billing them on the
    // previous caller's chain.
    let row: any = existing
    reusedSource = readRowSource(existing)
    const lightningInvolved =
      source.chainId === 'lightning' || reusedSource.chainId === 'lightning'
    if (sourceDiffers(reusedSource, source) && existing?.id) {
      if (lightningInvolved) {
        // BOLT11 lifecycle — re-checkout does not support it.
        rotationFailure = 'lightning_not_rotatable'
      } else {
        const rotated = await rotateExistingSource(env, String(existing.id), source)
        if (rotated.ok) {
          row = rotated.row
          reusedSource = readRowSource(rotated.row)
          sourceRotated = true
        } else {
          rotationFailure = rotated.code
        }
      }
    }
    // Close the lookup→rotate race (codex P1): the row can leave
    // payment_unpaid while the /checkout call is in flight, in which case
    // returning the pre-fetched link as payable invites a double payment.
    const postRotationStatus = sourceRotated
      ? readPaymentStatus(row)
      : rotationFailure
        ? await refetchPaymentStatus(env, String(existing?.id ?? ''))
        : REUSABLE_PAYMENT_STATUS
    if (postRotationStatus !== null && postRotationStatus !== REUSABLE_PAYMENT_STATUS) {
      return json(409, {
        ok: false,
        provider: 'stripe_crypto',
        error: {
          code: 'ORDER_ALREADY_ACTIVE',
          message:
            `An order already exists for this invoice and is no longer awaiting ` +
            `payment (status: ${postRotationStatus}). Do not pay again — ` +
            `poll the payment status instead.`,
        },
        invoiceKey: invoice.invoiceKey,
        rozoPaymentId: row?.id ?? existing?.id ?? null,
        status: postRotationStatus,
        expiresAt: row?.expiresAt ?? existing?.expiresAt ?? null,
      })
    }
    rozoPaymentId = row?.id ?? existing?.id ?? null
    paymentLink = row?.paymentLink ?? row?.url ?? row?.payment_link ?? null
    expiresAt = row?.expiresAt ?? existing?.expiresAt ?? null
    reused = true
    rawIntent = row ?? existing ?? null
  } else {
    // 7. Create the Rozo intent. The caller pays the discounted amount on the
    // source they chose; the settlement receiver is always the funder wallet on
    // Base USDC (same as Coinbase).
    //
    // Lightning (BTC) source → exactOut: the caller pays the BTC equivalent and
    // destination.amount pins the USDC we must receive. BTC price floats, so we
    // omit source.amount / source.tokenAddress and let Rozo quote the input.
    // Every other source → exactIn: the caller pays `callerPays` on that chain.
    // This mirrors the Coinbase branch exactly.
    const isLightning = source.chainId === 'lightning'
    const intentsBody = isLightning
      ? {
          appId: ROZO_APP_ID,
          orderId,
          type: 'exactOut',
          display: { title, currency: 'USD' },
          source: {
            chainId: 'lightning',
            tokenSymbol: 'BTC',
          },
          destination: {
            chainId: SETTLEMENT_CHAIN_ID,
            receiverAddress: SETTLEMENT_RECEIVER,
            tokenSymbol: 'USDC',
            tokenAddress: SETTLEMENT_TOKEN_ADDRESS,
            amount: callerPays,
          },
          metadata: lockedMetadata,
        }
      : {
          appId: ROZO_APP_ID,
          orderId,
          type: 'exactIn',
          display: { title, currency: 'USD' },
          source: {
            chainId: source.chainId,
            tokenSymbol: source.tokenSymbol,
            amount: callerPays,
            tokenAddress: source.tokenAddress,
          },
          destination: {
            chainId: SETTLEMENT_CHAIN_ID,
            receiverAddress: SETTLEMENT_RECEIVER,
            tokenSymbol: 'USDC',
            tokenAddress: SETTLEMENT_TOKEN_ADDRESS,
          },
          metadata: lockedMetadata,
        }
    let intentsResp: Response
    try {
      intentsResp = await fetch(ROZO_INTENTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-Key': env.ROZO_INTENTS_API_KEY },
        body: JSON.stringify(intentsBody),
      })
    } catch (err: any) {
      return json(502, {
        ok: false,
        provider: 'stripe_crypto',
        error: `Rozo intents API unreachable: ${err?.message ?? 'unknown error'}`,
      })
    }
    const intentsText = await intentsResp.text()
    if (!intentsResp.ok) {
      return json(502, {
        ok: false,
        provider: 'stripe_crypto',
        error: `Rozo intents API returned ${intentsResp.status}.`,
        hint: intentsText.substring(0, 300),
      })
    }
    let intentsJson: any
    try {
      intentsJson = JSON.parse(intentsText)
    } catch {
      return json(502, { ok: false, provider: 'stripe_crypto', error: 'Rozo intents API returned non-JSON.' })
    }
    rozoPaymentId = intentsJson?.id ?? intentsJson?.paymentId ?? intentsJson?.data?.id ?? null
    paymentLink =
      intentsJson?.paymentLink ?? intentsJson?.url ?? intentsJson?.payment_link ?? intentsJson?.data?.url ?? null
    expiresAt = intentsJson?.expiresAt ?? null
    reused = false
    rawIntent = intentsJson
  }

  // 8. Seed the locked fulfillment record so the webhook has the binding fields
  // + the (sensitive) Stripe URL without depending on the Rozo webhook payload.
  //
  // This record is the ONLY authoritative source of the lock binding. If we
  // can't persist it, the webhook could never settle this order (it would fall
  // into manual_review), so we must NOT hand the caller a payable link for an
  // order we're guaranteed not to fulfill automatically. Fail the request
  // instead. (P1-1)
  try {
    await seedStripeRecord(env, {
      invoiceKey: invoice.invoiceKey,
      merchantAccount: invoice.merchantAccount,
      invoiceAmountAtomic: invoice.stablecoinAmountAtomic,
      invoiceCurrency: invoice.fiatCurrency,
      lockFingerprint: invoice.lockFingerprint,
      stripeUrl,
      rozoPaymentId,
    })
  } catch {
    return json(503, {
      ok: false,
      provider: 'stripe_crypto',
      error:
        'Could not persist the fulfillment lock record; not returning a payable ' +
        'link for an order that cannot be settled. Please retry.',
      code: 'SEED_FAILED',
    })
  }

  // 9. Response. provider-neutral v2 fields; NEVER echo the Stripe URL.
  //
  // On reuse, echo the source the order actually pays from — the requested one
  // when the rotation above succeeded, otherwise the pre-existing one, in which
  // case we say so explicitly rather than letting the caller assume their
  // request took effect.
  const warnings = [...source.warnings]
  if (reused && rotationFailure) {
    warnings.push(sourceMismatchWarning(reusedSource, source, rotationFailure))
  }

  return json(200, {
    ok: true,
    reused,
    provider: 'stripe_crypto',
    source: reused
      ? { chainId: reusedSource.chainId, tokenSymbol: reusedSource.tokenSymbol }
      : { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    ...(sourceRotated ? { sourceRotated: true } : {}),
    ...(rotationFailure ? { sourceMismatch: true } : {}),
    ...(warnings.length ? { warnings } : {}),
    invoiceKey: invoice.invoiceKey,
    merchant: invoice.merchantTitle,
    merchantAccount: invoice.merchantAccount,
    original: originalStr,
    serviceFee: priced.serviceFee,
    callerPays,
    feeBps: priced.feeBps,
    pricingVersion: priced.pricingVersion,
    discount: discountStr,
    title,
    paymentLink,
    rozoPaymentId,
    expiresAt,
    invoice,
    raw: rawIntent,
  })
}
