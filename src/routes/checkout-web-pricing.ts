/**
 * Pricing policy for the browser-only checkout fee canary.
 *
 * The policy is deliberately narrow and defaults off:
 *   - only the exact browser client label `rozo-checkout-web` is eligible;
 *   - only exact, known OpenRouter merchant labels are eligible;
 *   - an absent, malformed, non-integer, or out-of-range env value is 0 bps.
 *
 * Keep the arithmetic in atomic USDC. Fees round UP so a non-zero configured
 * fee can never disappear because of integer truncation on a small invoice.
 */

export const CHECKOUT_WEB_CLIENT = 'rozo-checkout-web'
export const CHECKOUT_PRICING_VERSION = 'checkout-web-fee-v1'
// This surface is approved only for the 1% canary. Keep a code-level ceiling
// so a configuration typo cannot turn the narrow experiment into a 10%/100%
// surcharge. A future increase requires a reviewed code change, not just a var.
export const MAX_CHECKOUT_WEB_FEE_BPS = 100

const CLIENT_MAX_LEN = 64
// Mirrors ATTRIBUTION_VALUE_RE in payment-api/utm-attribution.ts, plus `/` so
// versioned CLI labels remain valid provenance even though they are not fee
// eligible.
const CLIENT_UNSAFE = /[^A-Za-z0-9_.\- /]/g
const OPENROUTER_MERCHANTS = new Set(['OpenRouter', 'OpenRouter, Inc.'])

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

/** Fee eligibility uses the raw label, never the lossy telemetry sanitizer. */
export function isExactCheckoutWebClient(raw: unknown): boolean {
  return raw === CHECKOUT_WEB_CLIENT
}

export function isStrictOpenRouterMerchant(merchant: string): boolean {
  return OPENROUTER_MERCHANTS.has(merchant.trim())
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

/** ceil(originalAtomic * feeBps / 10_000), entirely in integer arithmetic. */
export function computeServiceFeeAtomic(originalAtomic: bigint, feeBps: number): bigint {
  if (originalAtomic < 0n) throw new Error('originalAtomic must be non-negative')
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > MAX_CHECKOUT_WEB_FEE_BPS) {
    throw new Error(`feeBps must be an integer between 0 and ${MAX_CHECKOUT_WEB_FEE_BPS}`)
  }
  if (feeBps === 0 || originalAtomic === 0n) return 0n
  return (originalAtomic * BigInt(feeBps) + 9_999n) / 10_000n
}

export function resolveCheckoutPricing(
  originalAtomic: bigint,
  merchant: string,
  client: string | null,
  configuredFeeBps: unknown,
): CheckoutPricing {
  const feeBps =
    client === CHECKOUT_WEB_CLIENT && isStrictOpenRouterMerchant(merchant)
      ? parseCheckoutWebFeeBps(configuredFeeBps)
      : 0
  const serviceFeeAtomic = computeServiceFeeAtomic(originalAtomic, feeBps)
  return {
    originalAtomic,
    serviceFeeAtomic,
    callerPaysAtomic: originalAtomic + serviceFeeAtomic,
    feeBps,
    pricingVersion: CHECKOUT_PRICING_VERSION,
  }
}
