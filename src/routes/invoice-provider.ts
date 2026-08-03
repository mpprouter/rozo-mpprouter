// Provider-neutral invoice model + Stripe crypto read-only resolution.
//
// Phase A (this file) is strictly READ-ONLY: it resolves a customer-facing
// Stripe crypto checkout URL to a normalized, non-secret invoice detail
// object. No private key, no signing, no fund movement happens here.
//
// The signing / payment path (Phase B) lives in the Supabase `pay-invoice`
// edge function, NOT in this worker. This file only surfaces the same
// merchant / amount / status data a customer already sees on the checkout
// page, so it can be exposed publicly (behind rate limits).
//
// Secret hygiene (enforced by the invoice-details handler + tests):
//   NEVER return or log client_secret, publishable key, the raw session
//   URL/hash, unmasked wallet addresses, private keys, or signatures.

import type { InvoiceProvider } from './pay-invoice-admin'
import {
  extractCoinbaseCheckoutId,
  extractStripeSessionBlob,
  isCoinbasePaymentSessionId,
} from './pay-invoice-admin'

// Base mainnet canonical USDC. Phase 1 settles only on Base USDC (6 decimals).
const BASE_CHAIN_ID = '8453'
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const STRIPE_CHECKOUT = 'https://crypto.stripe.com'
const STRIPE_API = 'https://api.stripe.com'
const STRIPE_VERSION = '2025-06-30.basil'

// Known Stripe Payin Session states. `session.state` is provider-controlled;
// we never interpolate the raw value into a caller-visible string. Anything
// outside this set is surfaced as "unknown" to prevent reflected content.
const KNOWN_STRIPE_STATES = new Set([
  'initialized',
  'checkout',
  'requires_setup',
  'purchase_complete',
  'fulfillment_initiated',
  'fulfillment_complete',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'error',
])

/** Return the state if it is a known enum value, else the literal "unknown". */
function safeStripeState(state: unknown): string {
  return typeof state === 'string' && KNOWN_STRIPE_STATES.has(state) ? state : 'unknown'
}

// ── Provider-neutral invoice model (design doc §4) ──────────────────────────

export interface NormalizedInvoice {
  provider: InvoiceProvider
  invoiceKey: string // coinbase: pl_* or paymentSession_*; stripe: cpis_*
  merchantTitle: string
  merchantAccount: string | null // Stripe acct_*; null for providers without it
  fiatAmountMinor: string // integer string, e.g. "1819"
  fiatCurrency: string // lowercase ISO code, Phase 1 = "usd"
  stablecoinAmountAtomic: string // Base USDC atomic amount, e.g. "18190000"
  stablecoinAmount: string // display amount, e.g. "18.19"
  state: string // provider-native state
  payable: boolean
  payableReason: string | null // why not payable (Phase-1 constraint), else null
  validBefore: string | null // ISO timestamp
  settlement: {
    chainId: '8453'
    network: 'base'
    tokenSymbol: 'USDC'
    tokenAddress: string
    paymentOption: 'direct_deposit' | 'wallet_connect'
  }
  supportedPaymentOptions: Array<{
    id: string
    network: string
    chainId: number
    tokenSymbol: string
    tokenAddress: string
    paymentOptions: string[]
  }>
  transaction: {
    state: string | null
    blockchainTxId: string | null
    walletAddressMasked: string | null
    destinationAddressMasked: string | null
    destinationAmount: string | null
    destinationCurrency: string | null
    destinationNetwork: string | null
  } | null
  lockFingerprint: string
}

// ── Amount conversion ───────────────────────────────────────────────────────

/**
 * Convert fiat minor units (e.g. USD cents) to Base USDC atomic units.
 *
 * Valid ONLY for USD against 6-decimal USDC: 1 cent = 10_000 atomic USDC.
 * Any other currency throws — we never assume parity for non-USD fiat.
 */
export function fiatMinorToUsdcAtomic(fiatAmountMinor: bigint, fiatCurrency: string): bigint {
  const cur = fiatCurrency.toLowerCase()
  if (cur !== 'usd') {
    throw new Error(`unsupported fiat currency "${fiatCurrency}": Phase 1 only supports USD`)
  }
  // USD has 2 minor decimals; USDC has 6. 10^(6-2) = 10_000.
  return fiatAmountMinor * 10_000n
}

/** Format Base USDC atomic units as a plain decimal string, e.g. 18190000n -> "18.19". */
export function formatUsdcAtomic(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = atomic % 1_000_000n
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '')
  return `${whole}.${fracStr}`
}

// ── Lock fingerprint (design doc §4) ────────────────────────────────────────

// SHA-256 over a canonical serialization of the IMMUTABLE invoice identity.
// Deliberately excludes mutable state and expiry — those are revalidated
// separately immediately before payment. Two resolutions of the same invoice
// must produce the same fingerprint even if the live state changed.
export async function computeLockFingerprint(fields: {
  provider: string
  invoiceKey: string
  merchantAccount: string | null
  fiatAmountMinor: string
  fiatCurrency: string
  stablecoinAmountAtomic: string
  settlementChainId: string
  settlementTokenAddress: string
}): Promise<string> {
  const canonical = [
    fields.provider,
    fields.invoiceKey,
    fields.merchantAccount ?? '',
    fields.fiatAmountMinor,
    fields.fiatCurrency.toLowerCase(),
    fields.stablecoinAmountAtomic,
    fields.settlementChainId,
    fields.settlementTokenAddress.toLowerCase(),
  ].join('|')
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256:${hex}`
}

// ── Stripe Payin Session (read-only subset of stripe-lib.ts) ────────────────

interface ResumedSession {
  publishableKey: string
  clientSecret: string
  sessionId: string
  mode: string
}

export interface StripeSupportedCurrency {
  id: string // e.g. "usdc.base"
  asset_code?: string
  chain_id?: number
  contract_address?: string
  currency_minor_units?: number
  currency_network?: string
  mainnet?: boolean
  payment_options?: string[]
}

export interface StripePayinSession {
  id: string
  object?: string
  state: string
  business_name?: string
  merchant?: string // acct_...
  livemode?: boolean
  payment_details: {
    amount: number // minor units of `currency`
    currency: string
  }
  spender_contract_addresses?: Record<string, string>
  active_wallet?: { address?: string; network?: string } | null
  supported_currencies?: StripeSupportedCurrency[]
  transaction_details?: Record<string, unknown>
  valid_before?: string
  [k: string]: unknown
}

/**
 * Resume a Stripe Payin Session from the customer-facing `/pay/<blob>` URL.
 * Returns the session id, client secret, and publishable key. These values
 * are SECRETS — the caller must never return or log them; they are consumed
 * only to query the session.
 */
async function resumeStripeSession(payUrl: string): Promise<ResumedSession> {
  const blob = extractStripeSessionBlob(payUrl)
  if (!blob) {
    throw new StripeResolveError('invalid_url', 'URL is not a crypto.stripe.com/pay/<blob> link')
  }
  const body = new URLSearchParams({
    session_hash: blob,
    referrer: 'crypto.stripe.com',
    mode: 'pay',
  })
  const res = await fetch(`${STRIPE_CHECKOUT}/resume_payin_session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      origin: STRIPE_CHECKOUT,
      referer: STRIPE_CHECKOUT + '/',
    },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    // Do NOT include the response body verbatim in the thrown message beyond a
    // short, address-free status — it can carry session identifiers.
    throw new StripeResolveError(
      res.status === 404 || res.status === 410 ? 'expired' : 'upstream',
      `resume_payin_session failed (${res.status})`,
    )
  }
  let parsed: ResumedSession
  try {
    parsed = JSON.parse(text) as ResumedSession
  } catch {
    throw new StripeResolveError('upstream', 'resume_payin_session returned non-JSON')
  }
  if (!parsed.sessionId || !parsed.clientSecret || !parsed.publishableKey) {
    throw new StripeResolveError('upstream', 'resume_payin_session returned incomplete data')
  }
  return parsed
}

/** Query the full Payin Session state using the resumed credentials. */
async function queryStripeSession(resumed: ResumedSession): Promise<StripePayinSession> {
  // SECURITY: Stripe's payin_session GET requires `client_secret` in the query
  // string (there is no header/body transport for it). This URL therefore
  // carries a secret and MUST NEVER be logged, traced, echoed in an error, or
  // returned to a caller. Keep it local to this fetch; do not console.log(url).
  const url = new URL(`${STRIPE_API}/v1/crypto/internal/payin_session`)
  url.searchParams.set('crypto_payin_session', resumed.sessionId)
  url.searchParams.set('client_secret', resumed.clientSecret)
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${resumed.publishableKey}`,
      'stripe-version': STRIPE_VERSION,
      origin: STRIPE_CHECKOUT,
      referer: STRIPE_CHECKOUT + '/',
      'x-requested-with': 'XMLHttpRequest',
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new StripeResolveError(
      res.status === 404 || res.status === 410 ? 'expired' : 'upstream',
      `payin_session query failed (${res.status})`,
    )
  }
  try {
    return JSON.parse(text) as StripePayinSession
  } catch {
    throw new StripeResolveError('upstream', 'payin_session query returned non-JSON')
  }
}

export type StripeResolveErrorKind = 'invalid_url' | 'expired' | 'unsupported' | 'upstream'

export class StripeResolveError extends Error {
  constructor(
    public kind: StripeResolveErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'StripeResolveError'
  }
}

// ── Address masking (first-6 + last-4) ──────────────────────────────────────

/**
 * Mask a single address to first-6 + last-4, or null. NEVER returns a full
 * address: an input too short to mask without overlap (first-6 + last-4 would
 * reveal the whole string) is fully redacted to "…" rather than echoed.
 */
export function maskAddress(addr: string | null | undefined): string | null {
  if (!addr || typeof addr !== 'string') return null
  const a = addr.trim()
  if (a.length === 0) return null
  // Need >10 chars so first-6 + last-4 don't overlap/cover the whole value.
  if (a.length <= 10) return '…'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ── Stripe session → NormalizedInvoice ──────────────────────────────────────

/**
 * Normalize a live Stripe Payin Session into the provider-neutral invoice
 * model. Pure (no I/O) so it is trivially unit-testable with fixtures.
 *
 * Phase 1 payability requires: USD fiat, a `usdc.base` supported currency, and
 * that offer advertising `wallet_connect` in its payment_options. When those
 * are not met the invoice is returned with payable=false + payableReason so a
 * caller sees the merchant/amount but the router will not attempt to pay.
 *
 * Throws StripeResolveError('unsupported') only for a non-USD currency, where
 * we cannot even compute a safe stablecoin amount.
 */
export async function normalizeStripeSession(session: StripePayinSession): Promise<NormalizedInvoice> {
  const invoiceKey = session.id
  const merchantTitle = session.business_name ?? 'Unknown merchant'
  const merchantAccount = typeof session.merchant === 'string' ? session.merchant : null

  const amount = session.payment_details?.amount
  const currency = session.payment_details?.currency
  if (typeof amount !== 'number' || !currency) {
    throw new StripeResolveError('upstream', 'session missing payment_details.amount/currency')
  }
  // The amount is fiat minor units (integer cents). Require a non-negative
  // SAFE integer — never silently round a fractional/negative/overflowing
  // value into a bogus-but-payable amount + lock fingerprint.
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new StripeResolveError(
      'upstream',
      'payment_details.amount must be a non-negative integer (minor units)',
    )
  }
  const fiatCurrency = currency.toLowerCase()
  const fiatAmountMinor = BigInt(amount)

  // Reject non-USD before assuming parity — this is a hard stop, not a soft
  // "not payable", because we cannot produce a trustworthy amount at all.
  if (fiatCurrency !== 'usd') {
    throw new StripeResolveError(
      'unsupported',
      `unsupported fiat currency "${fiatCurrency}": Phase 1 only supports USD`,
    )
  }
  const stablecoinAtomic = fiatMinorToUsdcAtomic(fiatAmountMinor, fiatCurrency)

  // Discover the usdc.base offer and whether it supports wallet_connect.
  const supported = Array.isArray(session.supported_currencies)
    ? session.supported_currencies
    : []
  const supportedPaymentOptions = supported.map((c) => ({
    id: c.id,
    network: c.currency_network ?? '',
    chainId: typeof c.chain_id === 'number' ? c.chain_id : 0,
    tokenSymbol: (c.asset_code ?? '').toUpperCase(),
    tokenAddress: c.contract_address ?? '',
    paymentOptions: Array.isArray(c.payment_options) ? c.payment_options : [],
  }))

  // Find the usdc.base offer and STRICTLY validate it is canonical Base
  // mainnet USDC (6 decimals). We must not report canonical Base USDC
  // settlement + payable=true off a loose id/label match — verify chain id,
  // contract address, and (when present) the mainnet flag.
  const usdcBaseChainId = Number(BASE_CHAIN_ID) // 8453
  const usdcBase = supported.find((c) => {
    const idOrLabelMatch =
      c.id === 'usdc.base' ||
      ((c.asset_code ?? '').toLowerCase() === 'usdc' &&
        (c.currency_network ?? '').toLowerCase() === 'base')
    if (!idOrLabelMatch) return false
    // chain_id must be exactly Base mainnet.
    if (typeof c.chain_id === 'number' && c.chain_id !== usdcBaseChainId) return false
    // contract_address, when present, must be canonical Base USDC.
    if (
      typeof c.contract_address === 'string' &&
      c.contract_address.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()
    ) {
      return false
    }
    // mainnet flag, when present, must be true.
    if (typeof c.mainnet === 'boolean' && c.mainnet !== true) return false
    return true
  })
  const usdcBaseHasWalletConnect = !!usdcBase?.payment_options?.includes('wallet_connect')

  // State-based payability (design doc §8 mapping): only initialized/checkout
  // are entry-payable. Everything else is either in-flight or terminal.
  // `state` is sanitized to a known enum (or "unknown") — the raw
  // provider-controlled value is never reflected into a caller-visible string.
  const state = safeStripeState(session.state)
  const statePayable = state === 'initialized' || state === 'checkout'

  let payable = true
  let payableReason: string | null = null
  if (!statePayable) {
    payable = false
    payableReason = `session state "${state}" is not entry-payable`
  } else if (!usdcBase) {
    payable = false
    payableReason = 'merchant does not offer usdc.base settlement'
  } else if (!usdcBaseHasWalletConnect) {
    payable = false
    payableReason = 'usdc.base offer does not support wallet_connect (Phase 1 requirement)'
  }

  // Transaction details (masked). Only surface safe, address-masked fields.
  let transaction: NormalizedInvoice['transaction'] = null
  const activeWallet = session.active_wallet
  const td = session.transaction_details
  if (activeWallet || (td && Object.keys(td).length > 0)) {
    transaction = {
      state: typeof td?.state === 'string' ? (td.state as string) : null,
      blockchainTxId:
        typeof td?.blockchain_tx_id === 'string' ? (td.blockchain_tx_id as string) : null,
      walletAddressMasked: maskAddress(activeWallet?.address),
      destinationAddressMasked: maskAddress(
        typeof td?.destination_address === 'string' ? (td.destination_address as string) : null,
      ),
      destinationAmount:
        typeof td?.destination_amount === 'string' ? (td.destination_amount as string) : null,
      destinationCurrency:
        typeof td?.destination_currency === 'string' ? (td.destination_currency as string) : null,
      destinationNetwork:
        typeof td?.destination_network === 'string' ? (td.destination_network as string) : null,
    }
  }

  const lockFingerprint = await computeLockFingerprint({
    provider: 'stripe_crypto',
    invoiceKey,
    merchantAccount,
    fiatAmountMinor: fiatAmountMinor.toString(),
    fiatCurrency,
    stablecoinAmountAtomic: stablecoinAtomic.toString(),
    settlementChainId: BASE_CHAIN_ID,
    settlementTokenAddress: BASE_USDC_ADDRESS,
  })

  return {
    provider: 'stripe_crypto',
    invoiceKey,
    merchantTitle,
    merchantAccount,
    fiatAmountMinor: fiatAmountMinor.toString(),
    fiatCurrency,
    stablecoinAmountAtomic: stablecoinAtomic.toString(),
    stablecoinAmount: formatUsdcAtomic(stablecoinAtomic),
    state,
    payable,
    payableReason,
    validBefore: typeof session.valid_before === 'string' ? session.valid_before : null,
    settlement: {
      chainId: '8453',
      network: 'base',
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
      paymentOption: 'wallet_connect',
    },
    supportedPaymentOptions,
    transaction,
    lockFingerprint,
  }
}

/**
 * End-to-end read-only resolution of a Stripe crypto checkout URL into a
 * NormalizedInvoice. Performs live network I/O (resume + query). Throws
 * StripeResolveError on any failure. The resumed credentials never leave this
 * function.
 */
export async function resolveStripeInvoice(payUrl: string): Promise<NormalizedInvoice> {
  const resumed = await resumeStripeSession(payUrl)
  const session = await queryStripeSession(resumed)
  return normalizeStripeSession(session)
}

// ── Coinbase (read-only) ────────────────────────────────────────────────────
//
// Strictly READ-ONLY, exactly like the Stripe half above: resolve a Coinbase
// checkout URL to the same provider-neutral NormalizedInvoice so callers stop
// needing two code paths. Nothing here signs, locks, reserves, or moves funds.
//
// IMPORTANT (design doc §10-3): this does NOT replace `quote-invoice`. That
// endpoint issues the HMAC-signed quote receipt which is the amount trust chain
// for Coinbase settlement. This endpoint is display-only and issues no receipt.

const COINBASE_PAYMENTS_BASE = 'https://payments.coinbase.com'

export type CoinbaseResolveErrorKind = StripeResolveErrorKind

export class CoinbaseResolveError extends Error {
  constructor(
    public kind: CoinbaseResolveErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'CoinbaseResolveError'
  }
}

/**
 * Coinbase v1 Payment Link, as returned by `next-api/payment-links/pl_*`.
 * Field names mirror the production payment client
 * (`supabase/functions/quote-invoice/coinbase.ts`) — do not rename them here.
 */
export interface CoinbasePaymentLink {
  id: string
  status?: string
  maxAmount: string // USDC decimal string, e.g. "18.19"
  token?: string // ERC-20 address of the settlement token
  networkId?: number
  preApprovalExpiry?: string // unix SECONDS as a string
  maxUsage?: number
  usageCount?: number
  merchant?: { name?: string }
  fiat?: { amount?: string; currency?: string }
  [k: string]: unknown
}

/** Coinbase v3 Payment Session, from `next-api/payment-sessions/paymentSession_*`. */
export interface CoinbasePaymentSession {
  paymentSessionId: string
  status?: string
  amount: string // decimal string in `asset`
  asset?: string
  expiresAt?: string // ISO-8601
  customerDisplay?: { merchantName?: string }
  target?: {
    paymentTargetWallet?: { address?: string; network?: string }
    [k: string]: unknown
  }
  [k: string]: unknown
}

export type CoinbasePayment = CoinbasePaymentLink | CoinbasePaymentSession

/**
 * The only Coinbase v3 session state that is entry-payable.
 *
 * This is an ALLOWLIST on purpose. The Stripe skill previously used a denylist
 * (exclude succeeded/failed) and mis-reported in-flight sessions such as
 * `fulfillment_complete` as payable; the same mistake must not be repeated
 * here. Anything not on this list is reported payable=false with a reason.
 */
const COINBASE_V3_PAYABLE_STATES = new Set(['PAYMENT_SESSION_STATUS_CREATED'])

// NOTE on v1 `status`: Coinbase does not publish the Payment Link status enum,
// and the production signer (`supabase/functions/pay-invoice/coinbase.ts`) does
// not gate on it either — it gates on usageCount/maxUsage and preApprovalExpiry,
// which is what we mirror below. `status` is therefore surfaced as informational
// `state` only. An allowlist here would need the real enum; guessing at it would
// mark every live link unpayable. Tracked as an open question.

/**
 * Sanitize a provider-controlled status for caller-visible output.
 *
 * Unlike Stripe we do not have the full Coinbase status enum, so instead of a
 * fixed allowlist we constrain the SHAPE: a short bare identifier is echoed,
 * anything else becomes "unknown". This keeps arbitrary upstream content from
 * being reflected into our response while still surfacing real states.
 */
/**
 * True when a v3 session's payment target network is Base mainnet.
 *
 * VERIFIED against a live session (2026-08-03): Coinbase sends the enum name
 * `PAYMENT_TARGET_NETWORK_BASE`, NOT the bare string "base". The bare form is
 * accepted too because the repo's older fixture uses it and Coinbase has
 * changed this representation before. Anything else fails closed.
 *
 * Matching is exact against this set — deliberately not a substring/prefix
 * test, so a future `..._BASE_SEPOLIA` (testnet) can never satisfy it.
 */
const COINBASE_BASE_NETWORKS = new Set(['payment_target_network_base', 'base'])

function isCoinbaseBaseNetwork(network: string): boolean {
  return COINBASE_BASE_NETWORKS.has(network.toLowerCase())
}

function safeCoinbaseState(state: unknown): string {
  return typeof state === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(state) ? state : 'unknown'
}

/**
 * Parse an exact decimal string into atomic units, without floating point.
 *
 * Rejects anything that is not a plain non-negative decimal, and rejects more
 * fractional digits than the token has — we must never silently round a
 * customer-visible amount into a different amount + lock fingerprint.
 */
export function decimalToAtomic(value: string, decimals: number, label: string): bigint {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new CoinbaseResolveError('upstream', `${label} is not a plain decimal amount`)
  }
  const [whole, frac = ''] = value.trim().split('.')
  if (frac.length > decimals) {
    throw new CoinbaseResolveError(
      'upstream',
      `${label} has more than ${decimals} decimal places`,
    )
  }
  return BigInt(whole + frac.padEnd(decimals, '0'))
}

/** Normalize a unix-seconds string or an ISO timestamp to ISO-8601, else null. */
function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/** Milliseconds-since-epoch for an expiry value, or null when unparseable. */
function expiryMs(value: unknown): number | null {
  const iso = toIsoTimestamp(value)
  return iso === null ? null : Date.parse(iso)
}

function isPaymentSession(p: CoinbasePayment): p is CoinbasePaymentSession {
  return typeof (p as CoinbasePaymentSession).paymentSessionId === 'string'
}

/**
 * Normalize a Coinbase v1 Payment Link or v3 Payment Session into the
 * provider-neutral invoice model. Pure (no I/O), so it is unit-testable with
 * fixtures.
 *
 * Payability mirrors the checks the production payment client actually
 * enforces, plus a Base-USDC settlement check:
 *   v1 — not fully used (`usageCount < maxUsage`), not past `preApprovalExpiry`,
 *        and the link settles in canonical Base USDC.
 *   v3 — status is on the payable allowlist and the session is not past
 *        `expiresAt`.
 *
 * Throws CoinbaseResolveError('unsupported') for a non-USD fiat currency, where
 * we cannot compute a trustworthy amount at all — same hard stop as Stripe.
 *
 * `nowMs` is injectable so expiry behavior is deterministic under test.
 */
export async function normalizeCoinbasePayment(
  payment: CoinbasePayment,
  nowMs: number = Date.now(),
): Promise<NormalizedInvoice> {
  const v3 = isPaymentSession(payment)

  const invoiceKey = v3 ? payment.paymentSessionId : payment.id
  if (typeof invoiceKey !== 'string' || invoiceKey === '') {
    throw new CoinbaseResolveError('upstream', 'Coinbase payment is missing its id')
  }

  const merchantTitle =
    (v3 ? payment.customerDisplay?.merchantName : payment.merchant?.name) ?? 'Unknown merchant'

  // ── Amounts ──
  // v3: `amount` is denominated in `asset`. VERIFIED against a live session
  //     (2026-08-03): `asset` is the SETTLEMENT asset in lowercase — "usdc",
  //     not a fiat code. USD is accepted too because webhook.ts already maps
  //     this field into a `fiat.currency` slot and older payloads use it.
  //     USDC is treated as 1:1 with USD, which is what the whole Phase-1
  //     pipeline already assumes.
  // v1: `fiat.amount` is what the customer is billed; `maxAmount` is the
  //     authoritative on-chain USDC charge. Use each for its own field rather
  //     than deriving one from the other.
  const fiatRaw = v3 ? payment.amount : payment.fiat?.amount
  const currencyRaw = v3 ? payment.asset : payment.fiat?.currency
  if (typeof fiatRaw !== 'string' || typeof currencyRaw !== 'string') {
    throw new CoinbaseResolveError('upstream', 'Coinbase payment is missing its amount/currency')
  }
  const declaredAsset = currencyRaw.toLowerCase()
  const V3_ACCEPTED_ASSETS = new Set(['usdc', 'usd'])
  if (v3 ? !V3_ACCEPTED_ASSETS.has(declaredAsset) : declaredAsset !== 'usd') {
    throw new CoinbaseResolveError(
      'unsupported',
      `unsupported currency "${declaredAsset}": Phase 1 only supports USD/USDC`,
    )
  }
  // Normalized output always reports the fiat side as USD (USDC is 1:1).
  const fiatCurrency = 'usd'
  const fiatAmountMinor = decimalToAtomic(fiatRaw, 2, 'fiat amount')

  let stablecoinAtomic: bigint
  if (v3) {
    stablecoinAtomic = fiatMinorToUsdcAtomic(fiatAmountMinor, fiatCurrency)
  } else {
    if (typeof payment.maxAmount !== 'string') {
      throw new CoinbaseResolveError('upstream', 'payment link is missing maxAmount')
    }
    stablecoinAtomic = decimalToAtomic(payment.maxAmount, 6, 'maxAmount')
  }

  // ── Expiry ──
  // FAIL CLOSED: a missing or unparseable expiry means we cannot verify the
  // invoice is still live, so it is reported not-payable rather than assumed
  // fresh. "Cannot verify" must never read as "verified OK".
  const expiryRaw = v3 ? payment.expiresAt : payment.preApprovalExpiry
  const validBefore = toIsoTimestamp(expiryRaw)
  const expiresAtMs = expiryMs(expiryRaw)
  const expired = expiresAtMs === null || expiresAtMs <= nowMs
  const expiryReason =
    expiresAtMs === null ? 'invoice expiry could not be verified' : 'invoice has expired'

  const state = safeCoinbaseState(v3 ? payment.status : payment.status)

  // ── Settlement / supported options ──
  // v1 settles by ERC-3009 transfer authorization (a signature, no direct
  // transfer) -> closest neutral label is `wallet_connect`.
  // v3 settles by sending funds to `target.paymentTargetWallet` -> direct deposit.
  const settlementPaymentOption: NormalizedInvoice['settlement']['paymentOption'] = v3
    ? 'direct_deposit'
    : 'wallet_connect'

  // v1 links carry their own token/chain. Verify they are canonical Base USDC
  // before reporting Base USDC settlement + payable=true, exactly as the Stripe
  // half strictly validates its `usdc.base` offer.
  let settlementMismatch: string | null = null
  const supportedPaymentOptions: NormalizedInvoice['supportedPaymentOptions'] = []
  if (v3) {
    // FAIL CLOSED: only claim Base settlement when the session actually names
    // Base as its payment target network. An absent or different network must
    // not be silently reported as canonical Base USDC.
    const wallet = payment.target?.paymentTargetWallet
    const network = typeof wallet?.network === 'string' ? wallet.network : ''
    if (!isCoinbaseBaseNetwork(network)) {
      settlementMismatch =
        network === ''
          ? 'session does not declare a payment target network'
          : 'session does not settle on Base mainnet'
    }
    supportedPaymentOptions.push({
      id: 'usdc.base',
      network: network || 'unknown',
      chainId: Number(BASE_CHAIN_ID),
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
      paymentOptions: ['direct_deposit'],
    })
  } else {
    const token = typeof payment.token === 'string' ? payment.token : ''
    const chainId = typeof payment.networkId === 'number' ? payment.networkId : 0
    if (chainId !== Number(BASE_CHAIN_ID)) {
      settlementMismatch = 'payment link does not settle on Base mainnet'
    } else if (token.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) {
      settlementMismatch = 'payment link does not settle in canonical Base USDC'
    }
    supportedPaymentOptions.push({
      id: 'usdc.base',
      network: 'base',
      chainId,
      tokenSymbol: 'USDC',
      tokenAddress: token,
      paymentOptions: ['wallet_connect'],
    })
  }

  // ── Payability ──
  let payable = true
  let payableReason: string | null = null
  if (v3) {
    if (!COINBASE_V3_PAYABLE_STATES.has(state)) {
      payable = false
      payableReason = `session state "${state}" is not entry-payable`
    }
  } else {
    // FAIL CLOSED: usage is the only signal that a v1 link has already been
    // paid. If the upstream did not give us both counters we cannot rule that
    // out, so the link is reported not-payable rather than defaulting to 0.
    const { usageCount, maxUsage } = payment
    if (typeof usageCount !== 'number' || typeof maxUsage !== 'number') {
      payable = false
      payableReason = 'payment link usage could not be verified'
    } else if (usageCount >= maxUsage) {
      payable = false
      payableReason = `payment link already fully used (${usageCount}/${maxUsage})`
    }
  }
  if (payable && expired) {
    payable = false
    payableReason = expiryReason
  }
  if (payable && settlementMismatch) {
    payable = false
    payableReason = settlementMismatch
  }

  const lockFingerprint = await computeLockFingerprint({
    provider: 'coinbase',
    invoiceKey,
    merchantAccount: null,
    fiatAmountMinor: fiatAmountMinor.toString(),
    fiatCurrency,
    stablecoinAmountAtomic: stablecoinAtomic.toString(),
    settlementChainId: BASE_CHAIN_ID,
    settlementTokenAddress: BASE_USDC_ADDRESS,
  })

  return {
    provider: 'coinbase',
    invoiceKey,
    merchantTitle,
    // Coinbase has no Stripe-style connected-account id.
    merchantAccount: null,
    fiatAmountMinor: fiatAmountMinor.toString(),
    fiatCurrency,
    stablecoinAmountAtomic: stablecoinAtomic.toString(),
    stablecoinAmount: formatUsdcAtomic(stablecoinAtomic),
    state,
    payable,
    payableReason,
    validBefore,
    settlement: {
      chainId: '8453',
      network: 'base',
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
      paymentOption: settlementPaymentOption,
    },
    supportedPaymentOptions,
    // The read-only `next-api` payloads carry no settled-transaction detail.
    transaction: null,
    lockFingerprint,
  }
}

/**
 * Fetch a Coinbase checkout payload from the public `next-api` used by the
 * checkout page itself. No credentials are involved — the Origin/Referer pair
 * is what the browser sends. Mirrors `fetchCoinbasePayment` in webhook.ts.
 */
async function fetchCoinbasePayment(paymentId: string): Promise<CoinbasePayment> {
  const resource = isCoinbasePaymentSessionId(paymentId) ? 'payment-sessions' : 'payment-links'
  const path = `${resource}/${encodeURIComponent(paymentId)}`
  let res: Response
  try {
    res = await fetch(`${COINBASE_PAYMENTS_BASE}/next-api/${path}`, {
      headers: {
        Accept: 'application/json',
        Origin: COINBASE_PAYMENTS_BASE,
        Referer: `${COINBASE_PAYMENTS_BASE}/${path}`,
      },
    })
  } catch {
    throw new CoinbaseResolveError('upstream', 'Coinbase checkout API is unreachable')
  }
  if (!res.ok) {
    // Do NOT echo the upstream body — surface a short, content-free status.
    throw new CoinbaseResolveError(
      res.status === 404 || res.status === 410 ? 'expired' : 'upstream',
      `Coinbase checkout lookup failed (${res.status})`,
    )
  }
  try {
    return (await res.json()) as CoinbasePayment
  } catch {
    throw new CoinbaseResolveError('upstream', 'Coinbase checkout lookup returned non-JSON')
  }
}

/**
 * End-to-end read-only resolution of a Coinbase checkout URL (v1 payment link
 * or v3 payment session) into a NormalizedInvoice. Performs live network I/O.
 * Throws CoinbaseResolveError on any failure.
 */
export async function resolveCoinbaseInvoice(url: string): Promise<NormalizedInvoice> {
  const id = extractCoinbaseCheckoutId(url)
  if (!id) {
    throw new CoinbaseResolveError(
      'invalid_url',
      'URL is not a payments.coinbase.com /payment-links/pl_* or /payment-sessions/paymentSession_* link',
    )
  }
  return normalizeCoinbasePayment(await fetchCoinbasePayment(id))
}
