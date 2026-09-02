/**
 * Pricing policy for the browser-only checkout fee canary.
 *
 * The policy is cut by product line and defaults off:
 *   - every invoice created through the mpprouter checkout endpoints pays the
 *     fee (checkout.rozo.ai, agent.rozo.ai, and any API caller), whatever the
 *     merchant on the pasted Coinbase/Stripe link. Rozo Intents integrators
 *     never reach this code — they use rozo-intents-api under their own appId;
 *   - the free-text `client` label is telemetry only. It is caller-supplied
 *     and unverified, so it must never decide whether someone pays;
 *   - an absent, malformed, non-integer, or out-of-range env value is 0 bps.
 *
 * Keep the arithmetic in atomic USDC. Fees round UP to the next whole cent
 * (founder decision 2026-09-02: "$1.05 -> $1.06, not $1.0605") so the total a
 * user sees is a plain two-decimal price and a non-zero configured fee can
 * never disappear because of integer truncation on a small invoice.
 */

export const CHECKOUT_WEB_CLIENT = 'rozo-checkout-web'
// Bump this whenever the meaning of a signed quote-receipt field changes —
// even "this field is no longer written". A receipt lives 60 s, so a deploy
// that changes payload semantics without a version bump opens a 60 s window
// in which receipts signed under the old rule are accepted under the new one.
// v2 (2026-09-02): pricing no longer depends on the client label; receipts
// signed by the v1 build (client-bound) are rejected and the client re-quotes.
export const CHECKOUT_PRICING_VERSION = 'checkout-web-fee-v2'
// This surface is approved only for the 1% canary. Keep a code-level ceiling
// so a configuration typo cannot turn the narrow experiment into a 10%/100%
// surcharge. A future increase requires a reviewed code change, not just a var.
export const MAX_CHECKOUT_WEB_FEE_BPS = 100

const CLIENT_MAX_LEN = 64
// Mirrors ATTRIBUTION_VALUE_RE in payment-api/utm-attribution.ts, plus `/` so
// versioned CLI labels remain valid provenance even though they are not fee
// eligible.
const CLIENT_UNSAFE = /[^A-Za-z0-9_.\- /]/g
// Merchants that pay no service fee. Deliberately empty: the product is "pay
// any Coinbase/Stripe link", so the merchant set is open and the fee applies
// to all of them. Add an exact merchant label here only for a founder-approved
// exemption — this is an exemption list, never an allowlist.
const FEE_EXEMPT_MERCHANTS: ReadonlySet<string> = new Set<string>([])

/**
 * Whether an invoice for `merchant` pays the checkout service fee. The only
 * input is the merchant label on the resolved invoice: the caller's `client`
 * string is not consulted because it is self-declared. Single source of truth
 * for the create path and the signed-receipt replay check alike.
 */
export function isFeeEligibleMerchant(merchant: string): boolean {
  return !FEE_EXEMPT_MERCHANTS.has(merchant.trim())
}

export interface CheckoutPricing {
  originalAtomic: bigint
  serviceFeeAtomic: bigint
  callerPaysAtomic: bigint
  feeBps: number
  pricingVersion: typeof CHECKOUT_PRICING_VERSION
}

/** Parse a non-negative decimal USDC amount to 6-decimal atomic units. */
export function parseUsdcAtomic(amountDecimal: string): bigint {
  const match = amountDecimal.match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) throw new Error(`invalid decimal amount: ${amountDecimal}`)
  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6)
  return BigInt(match[1]) * 1_000_000n + BigInt(fraction)
}

export function formatUsdcAtomic(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const fraction = atomic % 1_000_000n
  if (fraction === 0n) return whole.toString()
  return `${whole}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`
}

export function normalizeCheckoutClient(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .slice(0, CLIENT_MAX_LEN * 4)
    .trim()
    .replace(CLIENT_UNSAFE, '')
    .slice(0, CLIENT_MAX_LEN)
  return cleaned.length ? cleaned : null
}

/** Invalid configuration fails safe to the disabled value (0 bps). */
export function parseCheckoutWebFeeBps(raw: unknown): number {
  if (typeof raw !== 'string') return 0
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return 0
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_CHECKOUT_WEB_FEE_BPS) {
    return 0
  }
  return parsed
}

const ATOMIC_PER_CENT = 10_000n
// bps -> cents: divide by 10_000 (bps) and again by 10_000 (atomic per cent).
const CENT_DIVISOR = 10_000n * ATOMIC_PER_CENT

/**
 * ceil(originalAtomic * feeBps / 10_000) rounded UP to a whole cent, entirely in
 * integer arithmetic. The result is always a multiple of 10_000 atomic units.
 */
export function computeServiceFeeAtomic(originalAtomic: bigint, feeBps: number): bigint {
  if (originalAtomic < 0n) throw new Error('originalAtomic must be non-negative')
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > MAX_CHECKOUT_WEB_FEE_BPS) {
    throw new Error(`feeBps must be an integer between 0 and ${MAX_CHECKOUT_WEB_FEE_BPS}`)
  }
  if (feeBps === 0 || originalAtomic === 0n) return 0n
  const cents = (originalAtomic * BigInt(feeBps) + CENT_DIVISOR - 1n) / CENT_DIVISOR
  return cents * ATOMIC_PER_CENT
}

export function resolveCheckoutPricing(
  originalAtomic: bigint,
  merchant: string,
  configuredFeeBps: unknown,
): CheckoutPricing {
  const feeBps = isFeeEligibleMerchant(merchant) ? parseCheckoutWebFeeBps(configuredFeeBps) : 0
  const serviceFeeAtomic = computeServiceFeeAtomic(originalAtomic, feeBps)
  return {
    originalAtomic,
    serviceFeeAtomic,
    callerPaysAtomic: originalAtomic + serviceFeeAtomic,
    feeBps,
    pricingVersion: CHECKOUT_PRICING_VERSION,
  }
}

// ── Display titles ───────────────────────────────────────────────────────────
// Title rendering lives here rather than in create-invoice so the read-only
// quote path (pay-invoice-admin.handleQuoteInvoice) can render the same title
// the create path will use, without importing create-invoice and forming a
// cycle (create-invoice already imports pay-invoice-admin).

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
  const [whole, fraction = ''] = formatUsdcAtomic(atomic).split('.')
  return `$${whole}.${fraction.padEnd(2, '0')}`
}

// "via Rozo" names who the service fee goes to: the title is what a payer
// sees in their wallet, and without it the fee reads as the merchant's. It is
// on the zero-fee branch as well so the checkout line carries one consistent
// attribution whether or not a fee applies (exempt merchants, gate at 0).
export const CHECKOUT_TITLE_VIA = 'via Rozo'

export function buildCheckoutTitle(merchant: string, pricing: CheckoutPricing): string {
  if (pricing.serviceFeeAtomic === 0n) {
    return `${buildFullAmountTitle(merchant, pricing.originalAtomic)} ${CHECKOUT_TITLE_VIA}`
  }
  return (
    `Pay ${merchant} ${formatExactCheckoutTitleAmount(pricing.callerPaysAtomic)} ${CHECKOUT_TITLE_VIA}` +
    ` (includes ${formatExactCheckoutTitleAmount(pricing.serviceFeeAtomic)} service fee)`
  )
}
