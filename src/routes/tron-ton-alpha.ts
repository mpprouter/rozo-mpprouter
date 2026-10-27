/**
 * TRON / TON fixed-address pay-in alpha, browser-facing proxy.
 *
 * Design: ainative docs/design/20261027-tron-ton-fixed-address-alpha.zh.md
 * (§8 frontend/API, §17 TON six-digit code, §18 one order with several coin
 * options). Backend contract: rozo-intents-api `tron-ton-alpha` edge function
 * (PR #854). That function needs the app API key, so the browser can never
 * call it directly; these two public routes hold the key server side.
 *
 *   GET  /v1/services/rozo-agent-api/tron-ton-alpha/capability
 *        -> { enabled, options[] }   whether to show TRON / TON at all
 *   POST /v1/services/rozo-agent-api/tron-ton-alpha/option
 *        { payment_id | url, network: 'tron'|'ton', token: 'USDT'|'TRX' }
 *        -> one payment option (exact amount, address, TON code, deadline)
 *
 * The business order key is derived HERE, never from the request body: the
 * Coinbase invoice id the quote resolves (`pl_*` or `paymentSession_*`) is
 * sent as both `merchantOrderId` and `providerInvoiceKey`, under the app the
 * router's API key belongs to (merchant_openrouter). Every create, coin
 * switch and status read for one payment link therefore lands on the same
 * alpha order, so switching coins back returns the same amount, the same TON
 * code and the same deadline (allocation is idempotent upstream). The amount
 * facts sent with it (invoice amount, existing checkout fee, destination) are
 * computed the same way on every call, because the upstream order digest
 * refuses a second call whose facts differ.
 *
 * Nothing here moves money and nothing here decides an amount: the exact
 * amount, the TON code and the shared 60-minute deadline all come from the
 * upstream allocation. Full payment links and API keys are never logged.
 */

import type { Env } from '../index'
import { normalizePayInvoiceBody } from './pay-invoice-admin'
import { resolveCheckoutPricing, formatUsdcAtomic, parseUsdcAtomic } from './checkout-web-pricing'
import { checkCreateInvoiceGate } from './create-invoice-gate'
import { resolveCoinbaseLinkExpiry } from './create-invoice'

export const TRON_TON_ALPHA_CAPABILITY_PATH = '/v1/services/rozo-agent-api/tron-ton-alpha/capability'
export const TRON_TON_ALPHA_OPTION_PATH = '/v1/services/rozo-agent-api/tron-ton-alpha/option'

export const TRON_TON_ALPHA_URL = 'https://intentapiv4.rozo.ai/functions/v1/tron-ton-alpha'
const QUOTE_INVOICE_URL = 'https://agentapi.rozo.ai/quote-invoice'
const UPSTREAM_TIMEOUT_MS = 8_000
const CAPABILITY_TIMEOUT_MS = 3_000
const CAPABILITY_TTL_MS = 60_000
// One waiting tab re-reads 120 times an hour; the IP cap leaves room for a few
// tabs behind one NAT. Global is a botnet backstop, not a business limit.
export const TRON_TON_ALPHA_GATE = {
  prefix: 'tta',
  limits: { ipPerHour: 600, globalPerHour: 20_000 },
  label: 'tron-ton-alpha option',
} as const

// Same settlement destination create-invoice uses for every Coinbase order.
// Part of the upstream order digest: it must be byte-identical on every call.
export const ALPHA_DESTINATION = Object.freeze({
  chainId: '8453',
  tokenSymbol: 'USDC',
  receiverAddress: '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739',
})

export interface AlphaOptionDef {
  network: 'tron' | 'ton'
  token: 'USDT' | 'TRX'
  chainId: string
  displayDecimals: 1 | 2
}

// Mirrors ALPHA_ASSETS in rozo-intents-api shared/tron-ton-alpha/chains.ts.
export const ALPHA_OPTIONS: readonly AlphaOptionDef[] = [
  { network: 'tron', token: 'USDT', chainId: '728126428', displayDecimals: 2 },
  { network: 'tron', token: 'TRX', chainId: '728126428', displayDecimals: 1 },
  { network: 'ton', token: 'USDT', chainId: '1600', displayDecimals: 2 },
]

export function findAlphaOption(network: unknown, token: unknown): AlphaOptionDef | null {
  const n = String(network ?? '').trim().toLowerCase()
  const t = String(token ?? '').trim().toUpperCase()
  return ALPHA_OPTIONS.find((o) => o.network === n && o.token === t) ?? null
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { ok: false, code, message, ...extra })
}

// ── TON address display ──────────────────────────────────────────────────────
// Upstream returns the TON receiving address in canonical raw form
// (`0:<64 hex>`). Wallets and exchanges expect the user-friendly base64url
// form, so the page shows the non-bounceable one (`UQ...`, the form wallets
// recommend for receiving). Checked against @ton/core in the tests.

function crc16Xmodem(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

export function tonRawToFriendly(raw: string, bounceable = false): string | null {
  const m = /^(-1|0):([0-9a-fA-F]{64})$/.exec(String(raw ?? '').trim())
  if (!m) return null
  const bytes = new Uint8Array(36)
  bytes[0] = bounceable ? 0x11 : 0x51
  bytes[1] = m[1] === '-1' ? 0xff : 0x00
  for (let i = 0; i < 32; i++) bytes[2 + i] = parseInt(m[2].slice(i * 2, i * 2 + 2), 16)
  const crc = crc16Xmodem(bytes.subarray(0, 34))
  bytes[34] = crc >> 8
  bytes[35] = crc & 0xff
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_')
}

// ── Capability ───────────────────────────────────────────────────────────────

let capabilityCache: { at: number; enabled: boolean } | null = null

/** Test hook. */
export function resetTronTonAlphaCapabilityCache(): void {
  capabilityCache = null
}

/**
 * Whether the alpha is on for this router's app. The upstream function checks
 * its switch and app allowlist before it reads the body, so an empty body is a
 * read-only probe: 403 alpha_disabled / app_not_allowed = off, 400
 * unsupported_asset = on (nothing is allocated). Anything else, including a
 * timeout or the function not being deployed yet, is off.
 */
export async function probeTronTonAlpha(env: Env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const now = Date.now()
  if (capabilityCache && now - capabilityCache.at < CAPABILITY_TTL_MS) return capabilityCache.enabled
  let enabled = false
  try {
    const r = await fetchImpl(TRON_TON_ALPHA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ROZO_INTENTS_API_KEY },
      body: '{}',
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    })
    if (r.status === 400) {
      const body = (await r.json().catch(() => null)) as { error?: unknown } | null
      enabled = body?.error === 'unsupported_asset'
    }
  } catch {
    enabled = false
  }
  capabilityCache = { at: now, enabled }
  return enabled
}

export async function handleTronTonAlphaCapability(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  const enabled = env.ROZO_INTENTS_API_KEY ? await probeTronTonAlpha(env) : false
  return json(200, {
    ok: true,
    enabled,
    options: enabled ? ALPHA_OPTIONS.map((o) => ({ ...o })) : [],
  })
}

// ── Option ───────────────────────────────────────────────────────────────────

const UPSTREAM_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  alpha_disabled: { status: 404, code: 'ALPHA_UNAVAILABLE', message: 'TRON and TON payments are not available.' },
  app_not_allowed: { status: 404, code: 'ALPHA_UNAVAILABLE', message: 'TRON and TON payments are not available.' },
  unsupported_asset: { status: 400, code: 'UNSUPPORTED_SOURCE', message: 'Unsupported network or token.' },
  order_conflict: { status: 409, code: 'ALPHA_ORDER_CONFLICT', message: 'This payment link already has a different TRON / TON order. Contact support.' },
  provider_invoice_conflict: { status: 409, code: 'ALPHA_ORDER_CONFLICT', message: 'This payment link already has a different TRON / TON order. Contact support.' },
  order_not_open: { status: 409, code: 'ALPHA_ORDER_CLOSED', message: 'This TRON / TON order is closed.' },
  order_expired: { status: 410, code: 'ALPHA_ORDER_EXPIRED', message: 'This TRON / TON order has expired.' },
  order_cap_exceeded: { status: 422, code: 'ALPHA_AMOUNT_TOO_HIGH', message: 'This invoice is above the TRON / TON alpha limit.' },
  daily_budget_exhausted: { status: 503, code: 'ALPHA_CAPACITY', message: 'TRON / TON payments are full for today. Pay with another coin.' },
  amount_space_exhausted: { status: 503, code: 'ALPHA_CAPACITY', message: 'TRON / TON payments are temporarily unavailable. Pay with another coin.' },
  payment_reference_exhausted: { status: 503, code: 'ALPHA_CAPACITY', message: 'TRON / TON payments are temporarily unavailable. Pay with another coin.' },
  increment_budget_unset: { status: 503, code: 'ALPHA_CAPACITY', message: 'TRON / TON payments are temporarily unavailable. Pay with another coin.' },
  price_unavailable: { status: 503, code: 'ALPHA_PRICE_UNAVAILABLE', message: 'The TRX price is unavailable right now. Try again later or pay with USDT.' },
}
const UPSTREAM_FALLBACK = { status: 502, code: 'ALPHA_UPSTREAM_FAILED', message: 'TRON / TON payments are temporarily unavailable. Pay with another coin.' }

/** Upstream gross_usd (numeric from SQL, string or number) to a cent string. */
function usdCents(v: unknown): bigint | null {
  const s = typeof v === 'number' ? v.toFixed(6) : typeof v === 'string' ? v.trim() : ''
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const atomic = parseUsdcAtomic(s)
  return (atomic + 9_999n) / 10_000n // round up to the cent, never under-state
}
function centsStr(c: bigint): string {
  return `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`
}

export interface AlphaUpstreamBody {
  merchantOrderId: string
  providerInvoiceKey: string
  baseServiceUsd: number
  existingAppFeeUsd: number
  destination: typeof ALPHA_DESTINATION
  network: string
  token: string
}

/** The exact body sent upstream. Pure, so a test can prove two coin choices share every order fact. */
export function buildAlphaUpstreamBody(
  invoiceKey: string,
  originalAtomic: bigint,
  serviceFeeAtomic: bigint,
  option: AlphaOptionDef,
): AlphaUpstreamBody {
  return {
    merchantOrderId: invoiceKey,
    providerInvoiceKey: invoiceKey,
    baseServiceUsd: Number(formatUsdcAtomic(originalAtomic)),
    existingAppFeeUsd: Number(formatUsdcAtomic(serviceFeeAtomic)),
    destination: ALPHA_DESTINATION,
    network: option.network,
    token: option.token,
  }
}

const COINBASE_INVOICE_KEY = /^(pl_[A-Za-z0-9_-]+|paymentSession_[0-9a-fA-F-]{36})$/

export async function handleTronTonAlphaOption(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!env.ROZO_INTENTS_API_KEY || !env.PAYINVOICE_ADMIN_SECRET) {
    return fail(500, 'SERVER_MISCONFIGURED', 'Router is not configured for TRON / TON payments.')
  }

  // Coarse per-IP / global volume cap with its OWN counters (codex P2): the
  // pages re-read the option every 30 s while waiting, and those reads must
  // never spend create-invoice's hourly budget. A new option still allocates
  // upstream, where the per-chain daily alpha budget is the real money cap.
  const gate = await checkCreateInvoiceGate(request, env, TRON_TON_ALPHA_GATE)
  if (!gate.ok) {
    const res = gate.reason === 'global_circuit_open'
      ? fail(503, 'SERVICE_UNAVAILABLE', 'Invoice creation is temporarily paused. Please try again shortly.')
      : fail(429, 'RATE_LIMITED', 'Too many requests. Please try again later.')
    res.headers.set('Retry-After', String(gate.retryAfterSeconds))
    return res
  }

  let parsed: Record<string, unknown>
  try {
    const p = await request.json()
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not an object')
    parsed = p as Record<string, unknown>
  } catch {
    return fail(400, 'INVALID_INPUT', 'Invalid JSON body')
  }

  const option = findAlphaOption(parsed.network, parsed.token)
  if (!option) {
    return fail(400, 'UNSUPPORTED_SOURCE', 'Unsupported network or token.', {
      supported: ALPHA_OPTIONS.map((o) => ({ network: o.network, token: o.token })),
    })
  }

  // Only the invoice reference is read from the body. Any orderId-like field
  // the caller sends is ignored: the order key is the invoice id below.
  const { normalized, error, provider_detected } = normalizePayInvoiceBody({
    url: parsed.url,
    payment_id: parsed.payment_id,
  })
  if (!normalized || error) {
    return fail(400, error?.code ?? 'INVALID_INPUT', error?.message ?? 'Could not read the payment link.')
  }
  if (provider_detected === 'stripe_crypto') {
    return fail(400, 'UNSUPPORTED_INVOICE', 'TRON / TON payments support Coinbase payment links only.')
  }

  // Fresh server-side quote every time (no client receipt): the amount facts
  // come from the provider, never from the page.
  let quote: any
  try {
    const qr = await fetch(QUOTE_INVOICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET },
      body: JSON.stringify(normalized),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!qr.ok) {
      const detail = await qr.text().catch(() => '')
      if (qr.status === 409 || qr.status === 410) {
        const paid = /PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED|already fully used/i.test(detail)
        return paid
          ? fail(409, 'PAYMENT_ALREADY_PAID', 'This payment link has already been paid.')
          : fail(qr.status, 'LINK_USED_OR_EXPIRED', 'Payment link has already been used or has expired.')
      }
      if (qr.status === 404) return fail(404, 'LINK_NOT_FOUND', 'No such payment link.')
      if (qr.status >= 400 && qr.status < 500 && ![401, 403, 408, 429].includes(qr.status)) {
        return fail(422, 'LINK_NOT_PAYABLE', 'This payment link cannot be quoted.')
      }
      return fail(502, 'QUOTE_FETCH_FAILED', 'Quote upstream returned an error.')
    }
    quote = await qr.json()
  } catch {
    return fail(502, 'QUOTE_FETCH_FAILED', 'Quote upstream unreachable.')
  }

  const invoiceKey: string = typeof quote?.linkId === 'string' ? quote.linkId : ''
  const merchant: string = typeof quote?.merchant === 'string' ? quote.merchant : ''
  const amount: string = typeof quote?.invoice?.amount === 'string' ? quote.invoice.amount : ''
  if (!COINBASE_INVOICE_KEY.test(invoiceKey) || !merchant || !/^\d+(\.\d+)?$/.test(amount)) {
    return fail(502, 'QUOTE_FETCH_FAILED', 'Quote response is missing the invoice id, merchant or amount.')
  }
  const pricing = resolveCheckoutPricing(parseUsdcAtomic(amount), merchant, env.CHECKOUT_WEB_FEE_BPS)
  const upstreamBody = buildAlphaUpstreamBody(invoiceKey, pricing.originalAtomic, pricing.serviceFeeAtomic, option)

  const linkExpiresAtPromise = resolveCoinbaseLinkExpiry(invoiceKey)

  let upstream: Response
  try {
    upstream = await fetch(TRON_TON_ALPHA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ROZO_INTENTS_API_KEY },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return fail(UPSTREAM_FALLBACK.status, UPSTREAM_FALLBACK.code, UPSTREAM_FALLBACK.message)
  }
  const data = (await upstream.json().catch(() => null)) as Record<string, any> | null
  if (!upstream.ok || !data || data.alpha !== true) {
    const reason = typeof data?.error === 'string' ? data.error : ''
    const mapped = UPSTREAM_ERRORS[reason] ?? UPSTREAM_FALLBACK
    // Reason code only: never the upstream body, the link or the key.
    console.warn('[tron-ton-alpha] option refused', upstream.status, reason || 'unknown')
    return fail(mapped.status, mapped.code, mapped.message)
  }

  const expected = typeof data.expectedAmount === 'string' ? data.expectedAmount : ''
  const decimalsOk = new RegExp(`^\\d+\\.\\d{${option.displayDecimals}}$`).test(expected)
  // Atomic amount (6 decimals) for wallet links (TON QR). Must be the same
  // number as the displayed amount, or neither is shown.
  const expectedAtomic = typeof data.expectedAmountAtomic === 'string' ? data.expectedAmountAtomic : ''
  const atomicOk = decimalsOk && /^\d+$/.test(expectedAtomic) && parseUsdcAtomic(expected) === BigInt(expectedAtomic)
  // TON: the USDT jetton master in wallet form for the transfer link.
  const tokenIdentity = typeof data.tokenIdentity === 'string' ? data.tokenIdentity : ''
  const tokenIdentityDisplay = option.network === 'ton' ? tonRawToFriendly(tokenIdentity, true) : tokenIdentity || null
  const address = typeof data.receivingAddress === 'string' ? data.receivingAddress : ''
  const ref = data.paymentReference == null ? null : String(data.paymentReference)
  const expiresAt = typeof data.expiresAt === 'string' ? data.expiresAt : ''
  const addressDisplay = option.network === 'ton' ? tonRawToFriendly(address) : address
  if (
    !atomicOk || (option.network === 'ton' && !tokenIdentityDisplay) || !address || !addressDisplay || !Number.isFinite(Date.parse(expiresAt)) ||
    data.network !== option.network || data.tokenSymbol !== option.token ||
    (option.network === 'ton' ? !(ref && /^\d{6}$/.test(ref)) : ref !== null)
  ) {
    console.warn('[tron-ton-alpha] option response failed validation')
    return fail(UPSTREAM_FALLBACK.status, UPSTREAM_FALLBACK.code, UPSTREAM_FALLBACK.message)
  }

  // The order deadline is shared by every option and never renewed. A link
  // that dies before it would let us take money we can no longer deliver, so
  // the instructions are never shown for it, on a first pick, a retry or a
  // switch back alike (codex P1: `reused` does not mean the page saw them).
  // Unknown link expiry = no limit known.
  const linkExpiresAt = await linkExpiresAtPromise
  if (linkExpiresAt && Date.parse(linkExpiresAt) < Date.parse(expiresAt)) {
    return fail(422, 'LINK_EXPIRES_TOO_SOON', 'This payment link expires before a TRON / TON payment could finish. Pay with another coin.')
  }

  const originalCents = pricing.originalAtomic / 10_000n
  const feeCents = pricing.serviceFeeAtomic / 10_000n
  const grossCents = usdCents(data.grossUsd)
  const alphaFeeCents = grossCents !== null && grossCents >= originalCents + feeCents
    ? grossCents - originalCents - feeCents
    : null

  return json(200, {
    ok: true,
    alpha: true,
    linkId: invoiceKey,
    merchant,
    reused: data.reused === true,
    orderState: typeof data.orderState === 'string' ? data.orderState : 'open',
    expired: data.expired === true,
    network: option.network,
    chainId: option.chainId,
    tokenSymbol: option.token,
    tokenIdentity: tokenIdentity || null,
    tokenIdentityDisplay,
    displayDecimals: option.displayDecimals,
    receivingAddress: address,
    receivingAddressDisplay: addressDisplay,
    expectedAmount: expected,
    expectedAmountAtomic: expectedAtomic,
    paymentReference: ref,
    expiresAt,
    serverTime: typeof data.serverTime === 'string' ? data.serverTime : new Date().toISOString(),
    linkExpiresAt: linkExpiresAt ?? null,
    fees: {
      invoiceUsd: centsStr(originalCents),
      serviceFeeUsd: centsStr(feeCents),
      feeBps: pricing.feeBps,
      networkFeeUsd: alphaFeeCents === null ? null : centsStr(alphaFeeCents),
      totalUsd: grossCents === null ? null : centsStr(grossCents),
    },
  })
}
