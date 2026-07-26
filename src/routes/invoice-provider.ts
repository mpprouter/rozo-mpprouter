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
import { extractStripeSessionBlob } from './pay-invoice-admin'

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
