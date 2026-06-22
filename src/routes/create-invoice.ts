import type { Env } from '../index'
import {
  normalizePayInvoiceBody,
  type PayInvoiceErrorCode,
  type PayInvoiceError,
} from './pay-invoice-admin'

const ROZO_INTENTS_URL = 'https://intentapiv4.rozo.ai/functions/v1/payment-api/'
const ROZO_INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'
const QUOTE_INVOICE_URL = 'https://agentapi.rozo.ai/quote-invoice'

const ROZO_APP_ID = 'wallet_rozopay'

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
  tokenSymbol: SourceToken
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
  const tokenSymbol = src.tokenSymbol.toUpperCase() as SourceToken

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
  if (!allowedTokens.includes(tokenSymbol)) {
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

  const tokenAddress = TOKEN_ADDRS[chainId]?.[tokenSymbol]
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

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return errorResponse(400, { code: 'INVALID_INPUT', message: 'Invalid JSON body' })
  }

  const { normalized, error, link_id_detected } = normalizePayInvoiceBody(parsed)
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
  const callerPaysAtomic = computeCallerPaysAtomic(invoiceAtomic)
  const discountAtomic = invoiceAtomic - callerPaysAtomic

  const callerPays = formatUsdc(callerPaysAtomic)
  const originalStr = formatUsdc(invoiceAtomic)
  const discountStr = formatUsdc(discountAtomic)
  const title = buildTitle(merchantName, invoiceAtomic, callerPaysAtomic)

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
        `${ROZO_INTENTS_BASE}/payments/order/${encodeURIComponent(ROZO_APP_ID)}/${encodeURIComponent(orderId)}`,
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
  const intentsBody = {
    appId: ROZO_APP_ID,
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
