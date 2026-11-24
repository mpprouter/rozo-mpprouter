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
 *        { network: 'ton', token: 'TON' } = native TON (Gram), public Beta,
 *        listed by the capability only while the upstream admits it.
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
import { checkoutIntakePaused, checkoutIntakePausedResponse } from './checkout-control'
import { resolveCoinbaseLinkExpiry } from './create-invoice'
import { isTestPaymentId, TEST_MERCHANT_NAME, verifyTestPaymentId } from './native-sources'
import { ensureAlphaBusinessOrder } from './tron-ton-alpha-order'
import { forwardedClientHintHeader } from './client-hint-forward'
import { readDeviceId } from './device-id-forward'
import { attributionMetadata, buildOrderAttribution, forwardedAttributionField } from './order-attribution'
import { BASE_FUNDER_ADDRESS } from '../funder-address'

export const TRON_TON_ALPHA_CAPABILITY_PATH = '/v1/services/rozo-agent-api/tron-ton-alpha/capability'
export const TRON_TON_ALPHA_OPTION_PATH = '/v1/services/rozo-agent-api/tron-ton-alpha/option'

export const TRON_TON_ALPHA_URL = 'https://intentapiv4.rozo.ai/functions/v1/tron-ton-alpha'
const QUOTE_INVOICE_URL = 'https://agentapi.rozo.ai/quote-invoice'
const UPSTREAM_TIMEOUT_MS = 8_000
const CAPABILITY_TIMEOUT_MS = 5_000
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
  receiverAddress: BASE_FUNDER_ADDRESS,
})
// Funder rotation 2026-11-24: an alpha order allocated before it froze the old
// (compromised) funder into its digest, and its intents business order pays
// out to that old address. Such an order is deliberately NOT replayed with the
// old destination: upstream answers order_conflict and the page shows
// ALPHA_ORDER_CONFLICT, so no new payment can be steered into it.

export interface AlphaOptionDef {
  network: 'tron' | 'ton'
  token: 'USDT' | 'TRX' | 'TON'
  chainId: string
  displayDecimals: 1 | 2 | 4
}

// Mirrors ALPHA_ASSETS in rozo-intents-api shared/tron-ton-alpha/chains.ts.
export const ALPHA_OPTIONS: readonly AlphaOptionDef[] = [
  { network: 'tron', token: 'USDT', chainId: '728126428', displayDecimals: 2 },
  { network: 'tron', token: 'TRX', chainId: '728126428', displayDecimals: 1 },
  { network: 'ton', token: 'USDT', chainId: '1600', displayDecimals: 2 },
]

// Native TON (Gram), public Beta (ainative docs/design/20261122-ton-native-
// payin-implementation.zh.md; founder 2026-11-23 "yes for everyone, with a
// limit"). Accepted on /option without any beta parameter. The capability
// route lists it (with `beta: true`) only while the upstream admits this
// router's app for native TON (TON_NATIVE_PAYIN_ENABLED and
// TON_NATIVE_PAYIN_APPS, probed read-only below), so the page never offers a
// coin the backend would refuse. Upstream off = 400 unsupported_asset here.
export const TON_NATIVE_OPTION: AlphaOptionDef = Object.freeze({
  network: 'ton', token: 'TON', chainId: '1600', displayDecimals: 4,
})
const TON_NATIVE_DECIMALS = 9

export function findAlphaOption(network: unknown, token: unknown): AlphaOptionDef | null {
  const n = String(network ?? '').trim().toLowerCase()
  const t = String(token ?? '').trim().toUpperCase()
  const listed = ALPHA_OPTIONS.find((o) => o.network === n && o.token === t)
  if (listed) return listed
  if (n === TON_NATIVE_OPTION.network && t === TON_NATIVE_OPTION.token) return TON_NATIVE_OPTION
  return null
}

/** Decimal string to integer units at `decimals`; null when it does not fit exactly. */
function decimalToAtomic(s: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > decimals) return null
  return BigInt(m[1] + frac.padEnd(decimals, '0'))
}

export interface TonNativeChecked {
  expected: string
  expectedAtomic: string
  rawAddress: string
  addressDisplay: string
  transferUri: string
}

/**
 * Native TON answer from upstream, or null when any part of it cannot be
 * shown to a payer: 4-decimal amount, nanoton atomic amount equal to it, no
 * jetton, the per-order non-bounceable UQ address that is exactly the wallet
 * form of the raw address (an EQ address to a fresh wallet bounces the
 * coins), no code, and the transfer link rebuilt from those two values.
 */
export function checkTonNativeAnswer(data: Record<string, any>): TonNativeChecked | null {
  if (data.network !== 'ton' || data.tokenSymbol !== 'TON' || data.tokenIdentity !== 'native') return null
  if (Number(data.tokenDecimals) !== TON_NATIVE_DECIMALS) return null
  if (Number(data.displayDecimals) !== TON_NATIVE_OPTION.displayDecimals) return null
  if (data.addressPerOrder !== true || data.paymentReference != null) return null
  const expected = typeof data.expectedAmount === 'string' ? data.expectedAmount : ''
  if (!/^\d+\.\d{4}$/.test(expected)) return null
  const atomic = decimalToAtomic(expected, TON_NATIVE_DECIMALS)
  const expectedAtomic = typeof data.expectedAmountAtomic === 'string' ? data.expectedAmountAtomic : ''
  if (atomic === null || atomic <= 0n || !/^[1-9]\d*$/.test(expectedAtomic) || BigInt(expectedAtomic) !== atomic) return null
  const rawAddress = typeof data.receivingAddressRaw === 'string' ? data.receivingAddressRaw : ''
  if (!/^0:[0-9a-f]{64}$/.test(rawAddress)) return null
  const addressDisplay = tonRawToFriendly(rawAddress)
  if (!addressDisplay || !/^UQ[A-Za-z0-9_-]{46}$/.test(addressDisplay)) return null
  if (data.receivingAddressDisplay !== addressDisplay || data.receivingAddress !== addressDisplay) return null
  const transferUri = `ton://transfer/${addressDisplay}?amount=${expectedAtomic}`
  if (data.tonTransferUri !== transferUri) return null
  if (!Number.isFinite(Date.parse(typeof data.expiresAt === 'string' ? data.expiresAt : ''))) return null
  return { expected, expectedAtomic, rawAddress, addressDisplay, transferUri }
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

type CapabilityCache = { at: number; enabled: boolean; knownAt: number }

/**
 * One read-only upstream probe. `body` is sent as is; a 400 whose `error` is
 * `on400` means on, any other definitive client-error answer means off.
 */
interface ProbeSpec {
  name: 'alpha' | 'ton_native'
  body: string
  on400: string
  kvKey: string
}

// Per isolate, per probe. `at` is when the cached answer should next be
// re-probed from; `knownAt` is when the upstream last gave a definitive answer.
const capabilityCaches: Record<ProbeSpec['name'], CapabilityCache | null> = { alpha: null, ton_native: null }

/** Test hook. */
export function resetTronTonAlphaCapabilityCache(): void {
  capabilityCaches.alpha = null
  capabilityCaches.ton_native = null
}

// Shared last definitive answer, so a fresh isolate whose first probe times
// out does not report the route as off (2026-11-17 flapping: capability read
// true / false on alternate requests while the backend switch was on).
export const CAPABILITY_LAST_KNOWN_KEY = 'tta:capability:last-known'
export const TON_NATIVE_CAPABILITY_LAST_KNOWN_KEY = 'tta:capability:ton-native:last-known'

/**
 * The function checks its switch and app allowlist before it reads the body,
 * so an empty body is read-only: 400 unsupported_asset = on (nothing is
 * allocated).
 */
const ALPHA_PROBE: ProbeSpec = { name: 'alpha', body: '{}', on400: 'unsupported_asset', kvKey: CAPABILITY_LAST_KNOWN_KEY }

/**
 * Native TON (rozo-intents-api handler.ts): `{ network: 'ton', token: 'TON' }`
 * reaches ton-native-create.ts only when TON_NATIVE_PAYIN_ENABLED is 'true'
 * and this app is in TON_NATIVE_PAYIN_APPS, and that code answers 400
 * bad_request for a body without merchantOrderId before it reads a price,
 * an index or the database. Not admitted = 400 unsupported_asset (off).
 * Nothing is allocated either way.
 */
const TON_NATIVE_PROBE: ProbeSpec = {
  name: 'ton_native',
  body: JSON.stringify({ network: 'ton', token: 'TON' }),
  on400: 'bad_request',
  kvKey: TON_NATIVE_CAPABILITY_LAST_KNOWN_KEY,
}
// How long a definitive answer may stand in for probes that fail transiently.
export const CAPABILITY_STALE_MAX_MS = 30 * 60_000
// After a failed probe, try again this soon instead of waiting the full TTL.
const CAPABILITY_RETRY_MS = 10_000
// Refresh the shared copy at most this often while the answer is unchanged.
const CAPABILITY_KV_REFRESH_MS = 5 * 60_000

type ProbeOutcome = 'on' | 'off' | 'unknown'

/**
 * One upstream probe (see ProbeSpec). 400 with the spec's `on400` error = on;
 * any other definitive client-error answer (another 400 error, 403
 * alpha_disabled / app_not_allowed, 404 not deployed, ...) = off. Timeouts,
 * network errors, 408 / 429 and 5xx say nothing about the switch = unknown.
 */
async function probeOnce(spec: ProbeSpec, env: Env, fetchImpl: typeof fetch): Promise<ProbeOutcome> {
  try {
    const r = await fetchImpl(TRON_TON_ALPHA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ROZO_INTENTS_API_KEY },
      body: spec.body,
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    })
    if (r.status === 400) {
      // A body that cannot be read (timeout, reset, not JSON) says nothing.
      const body = (await r.json().catch(() => undefined)) as { error?: unknown } | null | undefined
      if (body === undefined) {
        console.warn('[tron-ton-alpha] capability probe body unreadable', spec.name, r.status)
        return 'unknown'
      }
      return body?.error === spec.on400 ? 'on' : 'off'
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return 'off'
    console.warn('[tron-ton-alpha] capability probe inconclusive', spec.name, r.status)
    return 'unknown'
  } catch (e) {
    console.warn('[tron-ton-alpha] capability probe failed', spec.name, e instanceof Error ? e.name : 'error')
    return 'unknown'
  }
}

async function readLastKnown(spec: ProbeSpec, env: Env): Promise<{ enabled: boolean; at: number } | null> {
  try {
    const raw = await env.MPP_STORE?.get(spec.kvKey)
    if (!raw) return null
    const v = JSON.parse(raw) as { enabled?: unknown; at?: unknown }
    if (typeof v.enabled !== 'boolean' || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null
    return { enabled: v.enabled, at: v.at }
  } catch {
    return null
  }
}

async function writeLastKnown(spec: ProbeSpec, env: Env, enabled: boolean, at: number): Promise<void> {
  try {
    const prev = await readLastKnown(spec, env)
    if (prev && prev.enabled === enabled && at - prev.at < CAPABILITY_KV_REFRESH_MS) return
    // A late probe must not overwrite a newer answer another request stored.
    if (prev && prev.at > at) return
    await env.MPP_STORE?.put(spec.kvKey, JSON.stringify({ enabled, at }))
  } catch {
    // best effort: the in-isolate cache still holds the answer
  }
}

/**
 * Whether the alpha is on for this router's app. A definitive upstream answer
 * is cached for CAPABILITY_TTL_MS and shared through KV. A transient probe
 * failure does not turn the route off: the last definitive answer (this
 * isolate's, else the shared one) stands for up to CAPABILITY_STALE_MAX_MS and
 * the probe is retried after CAPABILITY_RETRY_MS. With no definitive answer in
 * that window the route is reported off, as before.
 */
async function probeCapability(spec: ProbeSpec, env: Env, fetchImpl: typeof fetch): Promise<boolean> {
  const now = Date.now()
  const cached = capabilityCaches[spec.name]
  if (cached && now < cached.at) return cached.enabled
  const outcome = await probeOnce(spec, env, fetchImpl)
  if (outcome !== 'unknown') {
    const enabled = outcome === 'on'
    capabilityCaches[spec.name] = { at: now + CAPABILITY_TTL_MS, enabled, knownAt: now }
    await writeLastKnown(spec, env, enabled, now)
    return enabled
  }
  let fallback: { enabled: boolean; at: number } | null =
    cached ? { enabled: cached.enabled, at: cached.knownAt } : null
  const shared = await readLastKnown(spec, env)
  if (shared && (!fallback || shared.at > fallback.at)) fallback = shared
  const usable = fallback && now - fallback.at <= CAPABILITY_STALE_MAX_MS ? fallback : null
  const enabled = usable ? usable.enabled : false
  capabilityCaches[spec.name] = { at: now + CAPABILITY_RETRY_MS, enabled, knownAt: usable ? usable.at : 0 }
  return enabled
}

export function probeTronTonAlpha(env: Env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return probeCapability(ALPHA_PROBE, env, fetchImpl)
}

/**
 * Whether the upstream offers native TON (Gram) to this router's app. Same
 * caching and transient-failure rules as probeTronTonAlpha, separate state.
 * Only a listing decision: /option still forwards the request and shows
 * nothing unless the upstream answer passes checkTonNativeAnswer.
 */
export function probeTonNative(env: Env, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return probeCapability(TON_NATIVE_PROBE, env, fetchImpl)
}

export async function handleTronTonAlphaCapability(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  if (!env.ROZO_INTENTS_API_KEY) return json(200, { ok: true, enabled: false, options: [] })
  const [enabled, tonNative] = await Promise.all([probeTronTonAlpha(env), probeTonNative(env)])
  const options: Array<AlphaOptionDef & { beta?: true }> = enabled ? ALPHA_OPTIONS.map((o) => ({ ...o })) : []
  // Native TON is listed last, marked Beta, and only inside an open alpha.
  if (enabled && tonNative) options.push({ ...TON_NATIVE_OPTION, beta: true })
  return json(200, { ok: true, enabled, options })
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
// Native TON (Gram) beta refusals (rozo-intents-api ton-native-create.ts).
// Read for the native option only, so the listed coins keep main's mapping.
const NATIVE_UPSTREAM_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  ton_native_disabled: { status: 404, code: 'ALPHA_UNAVAILABLE', message: 'TRON and TON payments are not available.' },
  order_already_fulfilled: { status: 409, code: 'ALPHA_ORDER_CLOSED', message: 'This TRON / TON order is closed.' },
  exposure_full: { status: 503, code: 'ALPHA_CAPACITY', message: 'TRON / TON payments are temporarily unavailable. Pay with another coin.' },
}
const TON_PRICE_UNAVAILABLE_MESSAGE = 'The TON price is unavailable right now. Try again later or pay with USDT.'
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

/** What the page is shown, after validation. */
interface ShownOption {
  expected: string
  expectedAtomic: string
  tokenIdentity: string
  tokenIdentityDisplay: string | null
  address: string
  addressDisplay: string
  ref: string | null
  expiresAt: string
  /** Extra response fields: native TON beta, TON USDT per-order address. */
  extra: Record<string, unknown>
}

function nativeShown(data: Record<string, any>): ShownOption | null {
  const c = checkTonNativeAnswer(data)
  if (!c) return null
  return {
    expected: c.expected,
    expectedAtomic: c.expectedAtomic,
    tokenIdentity: 'native',
    tokenIdentityDisplay: null,
    address: c.rawAddress,
    addressDisplay: c.addressDisplay,
    ref: null,
    expiresAt: data.expiresAt,
    extra: {
      tokenName: 'TON (Gram)',
      tokenDecimals: TON_NATIVE_DECIMALS,
      addressPerOrder: true,
      tonTransferUri: c.transferUri,
      beta: true,
    },
  }
}

/** TRON USDT, TRON TRX and TON USDT: the checks the route has always made. */
function listedShown(option: AlphaOptionDef, data: Record<string, any>): ShownOption | null {
  const expected = typeof data.expectedAmount === 'string' ? data.expectedAmount : ''
  const decimalsOk = new RegExp(`^\\d+\\.\\d{${option.displayDecimals}}$`).test(expected)
  // Atomic amount (6 decimals) for wallet links (TON QR). Must be the same
  // number as the displayed amount, or neither is shown.
  const expectedAtomic = typeof data.expectedAmountAtomic === 'string' ? data.expectedAmountAtomic : ''
  const atomicOk = decimalsOk && /^\d+$/.test(expectedAtomic) && parseUsdcAtomic(expected) === BigInt(expectedAtomic)
  // TON: the USDT jetton master in wallet form for the transfer link.
  const tokenIdentity = typeof data.tokenIdentity === 'string' ? data.tokenIdentity : ''
  const tokenIdentityDisplay = option.network === 'ton' ? tonRawToFriendly(tokenIdentity, true) : tokenIdentity || null
  // TON: upstream sends the wallet form in receivingAddress and the canonical
  // raw form in receivingAddressRaw (rozo-intents-api #854). This route
  // returns the raw form and derives the wallet form itself, so read the raw
  // one; an older upstream that sent raw in receivingAddress still works.
  const rawAddress = option.network === 'ton' && typeof data.receivingAddressRaw === 'string'
    ? data.receivingAddressRaw
    : data.receivingAddress
  const address = typeof rawAddress === 'string' ? rawAddress : ''
  const ref = data.paymentReference == null ? null : String(data.paymentReference)
  const expiresAt = typeof data.expiresAt === 'string' ? data.expiresAt : ''
  const addressDisplay = option.network === 'ton' ? tonRawToFriendly(address) : address
  if (
    !atomicOk || (option.network === 'ton' && !tokenIdentityDisplay) || !address || !addressDisplay || !Number.isFinite(Date.parse(expiresAt)) ||
    data.network !== option.network || data.tokenSymbol !== option.token ||
    (option.network === 'ton' ? !(ref && /^\d{6}$/.test(ref)) : ref !== null)
  ) {
    return null
  }
  // TON USDT per-order address (rozo-intents-api handler.ts optionResponse,
  // ainative design 20261031-ton-usdt-per-order-address section 10): the
  // address alone identifies the order, so the page hides the code box. The
  // flag is passed on only when upstream's wallet form is exactly the one
  // derived here; otherwise the answer is shown the way it always was.
  const perOrder = option.network === 'ton' && data.addressPerOrder === true &&
    typeof data.receivingAddressDisplay === 'string' && data.receivingAddressDisplay === addressDisplay
  return {
    expected, expectedAtomic, tokenIdentity, tokenIdentityDisplay, address, addressDisplay, ref, expiresAt,
    extra: perOrder ? { addressPerOrder: true } : {},
  }
}

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

  // `admin stop checkout-intake`: no new TRON / TON option (it allocates an
  // address and opens the business order upstream). Before anything upstream.
  if (await checkoutIntakePaused(env)) return checkoutIntakePausedResponse()

  let parsed: Record<string, unknown>
  try {
    const p = await request.json()
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not an object')
    parsed = p as Record<string, unknown>
  } catch {
    return fail(400, 'INVALID_INPUT', 'Invalid JSON body')
  }

  const option = findAlphaOption(parsed.network, parsed.token)
  const native = option === TON_NATIVE_OPTION
  if (!option) {
    return fail(400, 'UNSUPPORTED_SOURCE', 'Unsupported network or token.', {
      supported: ALPHA_OPTIONS.map((o) => ({ network: o.network, token: o.token })),
    })
  }

  // Only the invoice reference is read from the body. Any orderId-like field
  // the caller sends is ignored: the order key is the invoice id below. (The
  // optional browser `deviceId` and channel `attribution` are read further
  // down, only for the business order create; see device-id-forward.ts and
  // order-attribution.ts.)
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

  // Internal test invoice (rozotest_<cents>_<nonce>_<sig>, signed with
  // ROZO_TEST_LINK_SECRET): the amount comes from the signed id, there is no
  // Coinbase link to quote or expire, and the router's fund guard keeps it
  // away from the funder and Coinbase (webhook.ts closes it as test_settled).
  const testId = 'payment_id' in normalized && isTestPaymentId(normalized.payment_id)
    ? String(normalized.payment_id)
    : null
  let testCents: number | null = null
  if (testId !== null) {
    testCents = await verifyTestPaymentId(env.ROZO_TEST_LINK_SECRET, testId)
    if (testCents === null) return fail(400, 'INVALID_INPUT', 'Invalid test payment id.')
  }

  // Fresh server-side quote every time (no client receipt): the amount facts
  // come from the provider, never from the page.
  let quote: any
  if (testId !== null && testCents !== null) {
    quote = { linkId: testId, merchant: TEST_MERCHANT_NAME, invoice: { amount: (testCents / 100).toFixed(2) } }
  } else {
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
  }

  const invoiceKey: string = typeof quote?.linkId === 'string' ? quote.linkId : ''
  const merchant: string = typeof quote?.merchant === 'string' ? quote.merchant : ''
  const amount: string = typeof quote?.invoice?.amount === 'string' ? quote.invoice.amount : ''
  const keyOk = testId !== null ? invoiceKey === testId : COINBASE_INVOICE_KEY.test(invoiceKey)
  if (!keyOk || !merchant || !/^\d+(\.\d+)?$/.test(amount)) {
    return fail(502, 'QUOTE_FETCH_FAILED', 'Quote response is missing the invoice id, merchant or amount.')
  }
  const pricing = resolveCheckoutPricing(parseUsdcAtomic(amount), merchant, env.CHECKOUT_WEB_FEE_BPS)
  const upstreamBody = buildAlphaUpstreamBody(invoiceKey, pricing.originalAtomic, pricing.serviceFeeAtomic, option)

  const linkExpiresAtPromise: Promise<string | null> = testId !== null
    ? Promise.resolve(null)
    : resolveCoinbaseLinkExpiry(invoiceKey)

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
    const mapped = (native ? NATIVE_UPSTREAM_ERRORS[reason] : undefined) ?? UPSTREAM_ERRORS[reason] ?? UPSTREAM_FALLBACK
    // Reason code only: never the upstream body, the link or the key.
    console.warn('[tron-ton-alpha] option refused', upstream.status, reason || 'unknown')
    const message = native && reason === 'price_unavailable' ? TON_PRICE_UNAVAILABLE_MESSAGE : mapped.message
    return fail(mapped.status, mapped.code, message)
  }

  const shown = native ? nativeShown(data) : listedShown(option, data)
  if (!shown) {
    console.warn('[tron-ton-alpha] option response failed validation')
    return fail(UPSTREAM_FALLBACK.status, UPSTREAM_FALLBACK.code, UPSTREAM_FALLBACK.message)
  }
  const { expected, expectedAtomic, tokenIdentity, tokenIdentityDisplay, address, addressDisplay, ref, expiresAt } = shown

  // The order deadline is shared by every option and never renewed. A link
  // that dies before it would let us take money we can no longer deliver, so
  // the instructions are never shown for it, on a first pick, a retry or a
  // switch back alike (codex P1: `reused` does not mean the page saw them).
  // Unknown link expiry = no limit known.
  const linkExpiresAt = await linkExpiresAtPromise
  if (linkExpiresAt && Date.parse(linkExpiresAt) < Date.parse(expiresAt)) {
    return fail(422, 'LINK_EXPIRES_TOO_SOON', 'This payment link expires before a TRON / TON payment could finish. Pay with another coin.')
  }

  // The intents business order the matched payment settles into must exist
  // before any instructions are shown (tron-ton-alpha-order.ts). Ensured only
  // once the allocation succeeded; a failure hides the instructions and the
  // next read retries it (later reads hit the KV marker, no extra calls).
  // Channel attribution (optional top-level `attribution`, same body shape as
  // create-invoice) is built the way create-invoice builds it, so a TRON / TON
  // order carries metadata.attribution like any other checkout order. It is
  // telemetry only: it never changes pricing, the allocation or an error code.
  const order = await ensureAlphaBusinessOrder(
    env,
    {
      invoiceKey,
      merchant,
      pricing,
      test: testId !== null,
      deviceId: readDeviceId(parsed),
      orderAttribution: attributionMetadata(buildOrderAttribution(parsed.attribution, request)),
      attributionField: forwardedAttributionField(parsed.attribution),
    },
    forwardedClientHintHeader(request, null),
  ).catch(() => ({ ok: false as const, reason: 'create_failed' as const }))
  if (!order.ok) {
    console.warn('[tron-ton-alpha] business order not ensured', order.reason)
    return fail(UPSTREAM_FALLBACK.status, UPSTREAM_FALLBACK.code, UPSTREAM_FALLBACK.message)
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
    ...shown.extra,
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
