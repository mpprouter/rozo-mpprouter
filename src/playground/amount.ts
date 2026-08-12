/**
 * Money arithmetic for the playground ledger.
 *
 * Every amount in the playground subsystem is a **7-decimal USDC atomic
 * integer** carried as a `bigint` (in memory) or a decimal `string` (on the
 * wire and in Durable Object storage). There are no `number` amounts anywhere
 * in this subsystem, and there must never be: IEEE-754 doubles cannot
 * represent $0.001 exactly, and a ledger that loses a hundredth of a cent per
 * call is a ledger that eventually disagrees with the chain.
 *
 * 7 decimals is not an arbitrary choice — it is Stellar's fixed asset
 * precision (`stroops`), so an on-chain Horizon `amount` string like
 * "1.0000000" maps to atomic `10000000` with no rounding at any point in the
 * deposit-verification path.
 */

/** Stellar asset precision: 7 decimal places. */
export const USDC_DECIMALS = 7

/** 10^7 — one whole USDC in atomic units. */
export const ONE_USDC = 10_000_000n

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

/**
 * Parse a decimal USD string (or integer-valued number of whole dollars) into
 * atomic 7-decimal units.
 *
 * Rejects anything that is not a plain decimal literal — no exponents, no
 * whitespace, no `Infinity`. Rejects more than 7 fractional digits rather than
 * silently truncating: a caller asking to charge $0.00000001 has a bug, and
 * rounding it to zero would hide that bug behind free API calls.
 *
 * @throws {RangeError} on malformed input or excess precision.
 */
export function parseUsd(input: string): bigint {
  const s = input.trim()
  if (!DECIMAL_RE.test(s)) {
    throw new RangeError(`invalid USD amount: ${JSON.stringify(input)}`)
  }
  const negative = s.startsWith('-')
  const unsigned = negative ? s.slice(1) : s
  const [whole, frac = ''] = unsigned.split('.')
  if (frac.length > USDC_DECIMALS) {
    throw new RangeError(
      `USD amount ${JSON.stringify(input)} has more than ${USDC_DECIMALS} decimal places`,
    )
  }
  const padded = frac.padEnd(USDC_DECIMALS, '0')
  const atomic = BigInt(whole) * ONE_USDC + BigInt(padded || '0')
  return negative ? -atomic : atomic
}

/**
 * Render atomic units as a fixed 7-decimal string ("0.0200000").
 *
 * Fixed width — not trimmed — because this is the exact shape Horizon uses for
 * Stellar payment amounts, which makes deposit comparisons a plain string
 * equality check as well as a bigint one.
 */
export function formatUsdc7(atomic: bigint): string {
  const negative = atomic < 0n
  const abs = negative ? -atomic : atomic
  const whole = abs / ONE_USDC
  const frac = (abs % ONE_USDC).toString().padStart(USDC_DECIMALS, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/**
 * Render atomic units as a human/API-facing USD string with trailing zeros
 * trimmed but at least 2 decimals ("0.02", "1.00", "0.0010000" -> "0.001").
 *
 * Used only in API response bodies for display. Never feed this back into
 * arithmetic — round-trip through `parseUsd` if you must.
 */
export function formatUsd(atomic: bigint): string {
  const fixed = formatUsdc7(atomic)
  const [whole, frac] = fixed.split('.')
  const trimmed = frac.replace(/0+$/, '')
  const padded = trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed
  return `${whole}.${padded}`
}

/**
 * Parse an atomic-unit decimal string as stored in the DO.
 *
 * Storage always holds the canonical atomic integer string (e.g. "10000000"),
 * never a decimal — this is the reader for that format. A missing/empty value
 * reads as zero so a fresh account needs no initialisation write.
 */
export function parseAtomic(value: string | null | undefined): bigint {
  if (!value) return 0n
  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`invalid atomic amount: ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}
