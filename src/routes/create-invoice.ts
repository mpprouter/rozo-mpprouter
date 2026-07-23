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
  '137':  ['USDC', 'USDT'],   // Polygon
  '8453': ['USDC'],           // Base
  '900':  ['USDC'],           // Solana
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
  '8453': { USDC: BASE_USDC_ADDRESS },
  '900':  { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
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
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'

export interface CreateInvoiceError extends Omit<PayInvoiceError, 'code'> {
  code: CreateInvoiceErrorCode
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
  const m = amountDecimal.match(/^(\d+)(?:\.(\d+))?$/)
  if (!m) throw new Error(`invalid decimal amount: ${amountDecimal}`)
  const whole = BigInt(m[1])
  const fracRaw = (m[2] ?? '').padEnd(6, '0').slice(0, 6)
  return whole * 1_000_000n + BigInt(fracRaw)
}

export function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = atomic % 1_000_000n
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return `${whole}.${fracStr}`
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
    return handleStripeCreateInvoice(stripeUrl, env)
  }

  // Source override (optional). If caller provided `source`, validate against
  // the whitelist; otherwise default to Base USDC.
  const sourceRaw = (parsed as Record<string, unknown> | null)?.source
  const sourceResult = resolveSource(sourceRaw)
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

  // Step 1: fetch the quote (price + merchant name) by calling our own
  // upstream quote-invoice with the router's admin secret.
  let quoteResp: Response
  try {
    quoteResp = await fetch(QUOTE_INVOICE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify(normalized),
    })
  } catch (err: any) {
    return errorResponse(502, {
      code: 'QUOTE_FETCH_FAILED',
      message: `Quote upstream unreachable: ${err?.message ?? 'unknown error'}`,
      normalized_input: normalized,
      link_id_detected,
    })
  }

  if (!quoteResp.ok) {
    const detail = await quoteResp.text()
    if (quoteResp.status === 409 || quoteResp.status === 410) {
      return errorResponse(quoteResp.status, {
        code: 'LINK_USED_OR_EXPIRED',
        message: 'Payment link has already been used or has expired.',
        hint: 'Request a new payment link from the merchant.',
        normalized_input: normalized,
        link_id_detected,
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

  let quote: any
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

  // Step 2: compute discounted price.
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
  // OpenRouter / Coinbase line: no discount (founder decision). Caller pays the
  // full invoice amount; discount fields are kept in the response for shape
  // stability but are always the full amount / "0".
  const callerPays = formatUsdc(invoiceAtomic)
  const originalStr = formatUsdc(invoiceAtomic)
  const discountStr = '0'
  const title = buildFullAmountTitle(merchantName, invoiceAtomic)

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
        return json(200, {
          ok: true,
          reused: true,
          linkId,
          merchant: merchantName,
          original: originalStr,
          callerPays,
          discount: discountStr,
          title,
          paymentLink:
            existing?.paymentLink ??
            existing?.url ??
            existing?.payment_link ??
            null,
          rozoPaymentId: existing?.id ?? null,
          expiresAt: existingExpiresAt,
          // Echo the source the existing intent was created with (from Rozo),
          // not the source the current caller asked for — those may differ if
          // a previous caller used a different chain for the same pl_ id.
          source: {
            chainId: existing?.source?.chainId ?? existing?.source_chain_id ?? null,
            tokenSymbol: existing?.source?.tokenSymbol ?? existing?.source_token_symbol ?? null,
          },
          ...(source.warnings.length ? { warnings: source.warnings } : {}),
          raw: existing,
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
        metadata: {
          source: 'mpprouter-create-invoice',
          coinbasePaymentLinkId: linkId,
        },
      }
    : {
        appId: OPENROUTER_APP_ID,
        orderId: orderId ?? `mpprouter-${Date.now()}`,
        type: 'exactIn',
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
        metadata: {
          source: 'mpprouter-create-invoice',
          coinbasePaymentLinkId: linkId,
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
    callerPays,
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
export async function handleStripeCreateInvoice(stripeUrl: string, env: Env): Promise<Response> {
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

  // 3. Discount (unchanged formula; founder decision: Stripe keeps it).
  let invoiceAtomic: bigint
  try {
    invoiceAtomic = BigInt(invoice.stablecoinAmountAtomic)
  } catch {
    return json(502, { ok: false, provider: 'stripe_crypto', error: 'Unparseable invoice amount.' })
  }
  if (invoiceAtomic <= 0n) {
    return json(422, { ok: false, provider: 'stripe_crypto', error: 'Invoice amount must be positive.' })
  }
  const callerPaysAtomic = computeCallerPaysAtomic(invoiceAtomic)
  const discountAtomic = invoiceAtomic - callerPaysAtomic
  const callerPays = formatUsdc(callerPaysAtomic)
  const originalStr = formatUsdc(invoiceAtomic)
  const discountStr = formatUsdc(discountAtomic)
  const title = buildTitle(invoice.merchantTitle, invoiceAtomic, callerPaysAtomic)

  // 4. Provider-qualified orderId (design §6): stripe_crypto_<cpis_*>.
  const orderId = stripeOrderId(invoice.invoiceKey)

  // 5. Idempotency: reuse an existing, still-valid Rozo intent for this order.
  let existing: any = null
  try {
    const lookup = await fetch(
      `${ROZO_INTENTS_BASE}/payments/order/${encodeURIComponent(ROZO_APP_ID)}/${encodeURIComponent(orderId)}`,
      { method: 'GET', headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY } },
    )
    if (lookup.ok) {
      const found: any = await lookup.json().catch(() => null)
      const expiresAt: string | null = found?.expiresAt ?? null
      if (found && expiresAt && Date.parse(expiresAt) > Date.now()) existing = found
    }
  } catch {
    // Non-fatal — fall through to create.
  }

  // 6. Locked metadata (design §6). NO url / session hash / secrets.
  const lockedMetadata = {
    source: 'mpprouter-create-invoice',
    invoiceProvider: 'stripe_crypto',
    invoiceKey: invoice.invoiceKey,
    invoiceLockFingerprint: invoice.lockFingerprint,
    merchantAccount: invoice.merchantAccount,
    invoiceAmountAtomic: invoice.stablecoinAmountAtomic,
    invoiceCurrency: invoice.fiatCurrency,
    settlementChainId: SETTLEMENT_CHAIN_ID,
    settlementToken: 'USDC',
  }

  let rozoPaymentId: string | null
  let paymentLink: string | null
  let expiresAt: string | null
  let reused: boolean

  if (existing) {
    rozoPaymentId = existing?.id ?? null
    paymentLink = existing?.paymentLink ?? existing?.url ?? existing?.payment_link ?? null
    expiresAt = existing?.expiresAt ?? null
    reused = true
  } else {
    // 7. Create the Rozo intent. Caller pays the discounted amount on Base USDC;
    // settlement receiver is the funder wallet (same as Coinbase).
    const intentsBody = {
      appId: ROZO_APP_ID,
      orderId,
      type: 'exactIn',
      display: { title, currency: 'USD' },
      source: {
        chainId: BASE_CHAIN_ID,
        tokenSymbol: 'USDC',
        amount: callerPays,
        tokenAddress: BASE_USDC_ADDRESS,
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
  return json(200, {
    ok: true,
    reused,
    provider: 'stripe_crypto',
    invoiceKey: invoice.invoiceKey,
    merchant: invoice.merchantTitle,
    merchantAccount: invoice.merchantAccount,
    original: originalStr,
    callerPays,
    discount: discountStr,
    title,
    paymentLink,
    rozoPaymentId,
    expiresAt,
    invoice,
  })
}
