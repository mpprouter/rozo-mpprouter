// funder-tiers: which Base USDC funder wallet pays a given payment.
//
// MIRRORED FILE. The same file lives in two repositories and must stay
// byte-identical (each repo has a test that checks its copy against the shared
// vectors in funder-tier-vectors.json, which is also mirrored):
//   - shawnmuggle/shawn-local-skills  supabase/functions/_shared/funder-tiers.ts
//     (the signer: pay-invoice / sign-x402 pick the key with it)
//   - mpprouter/rozo-mpprouter        src/funder-tiers.ts
//     (the router: settlement receiver, balance check, expected signer)
// Change both in the same review, with the vectors, or neither.
//
// Design: ainative docs/design/20261124-funder-tiered-wallets-rozo-sg-migration.zh.md
// (section 0 is authoritative; numbers approved by the founder 2026-11-24).
//
// Tiers (Base USDC):
//   T1   x402 only. Per payment <= $5. Hot key, balance <= 50 USDC.
//   T2   OpenRouter Coinbase invoices below $200. Hot key, balance <= 200 USDC.
//   T3A  OpenRouter Coinbase invoices from $200 up to the order cap ($1,200).
//        CDP Server Wallet, policy allowlists only the Coinbase collectors.
//   T3B  Stripe crypto links, Bitrefill and any other merchant, up to the
//        order cap ($1,200). CDP Server Wallet, no contract allowlist.
//
// Rules, in order (amount = the USDC the funder will sign for, in 6-decimal
// atomic units, i.e. the invoice amount, NOT the caller's fee-inclusive price):
//   1. amount must be a positive integer, else refuse "invalid_amount".
//   2. kind "x402":      amount <= T1_MAX_ATOMIC            -> T1, else refuse.
//   3. kind "coinbase":  amount <  T2_MAX_EXCLUSIVE_ATOMIC  -> T2
//                        amount <= ORDER_CAP_ATOMIC         -> T3A, else refuse.
//   4. kind "stripe" | "bitrefill" | "other":
//                        amount <= ORDER_CAP_ATOMIC         -> T3B, else refuse.
//   5. any other kind: refuse "unknown_kind".
// The boundary $200.00 exactly goes to T3A. There is no fallback between
// tiers: a refusal means "do not pay / do not create the order".
//
// No imports, no env, no I/O: pure and identical in Deno and Node.

export type FunderTier = "T1" | "T2" | "T3A" | "T3B";
export type FunderPaymentKind =
  | "x402"
  | "coinbase"
  | "stripe"
  | "bitrefill"
  | "other";

export type FunderTierRefusal =
  | "invalid_amount"
  | "unknown_kind"
  | "over_tier_cap"
  | "over_order_cap";

export type FunderTierDecision =
  | { ok: true; tier: FunderTier }
  | { ok: false; reason: FunderTierRefusal };

/** $5: T1 per-payment cap (sign-x402 default X402_SIGN_MAX_ATOMIC). */
export const T1_MAX_ATOMIC = 5_000_000n;
/** $200: Coinbase invoices strictly below this go to T2. */
export const T2_MAX_EXCLUSIVE_ATOMIC = 200_000_000n;
/** $1,200: order cap (rozo-mpprouter ORDER_CAP_USD). Inclusive. */
export const ORDER_CAP_ATOMIC = 1_200_000_000n;

export const FUNDER_TIERS: readonly FunderTier[] = ["T1", "T2", "T3A", "T3B"];

export function selectFunderTier(
  kind: string,
  amountAtomic: bigint,
): FunderTierDecision {
  if (typeof amountAtomic !== "bigint" || amountAtomic <= 0n) {
    return { ok: false, reason: "invalid_amount" };
  }
  switch (kind) {
    case "x402":
      return amountAtomic <= T1_MAX_ATOMIC
        ? { ok: true, tier: "T1" }
        : { ok: false, reason: "over_tier_cap" };
    case "coinbase":
      if (amountAtomic < T2_MAX_EXCLUSIVE_ATOMIC) return { ok: true, tier: "T2" };
      return amountAtomic <= ORDER_CAP_ATOMIC
        ? { ok: true, tier: "T3A" }
        : { ok: false, reason: "over_order_cap" };
    case "stripe":
    case "bitrefill":
    case "other":
      return amountAtomic <= ORDER_CAP_ATOMIC
        ? { ok: true, tier: "T3B" }
        : { ok: false, reason: "over_order_cap" };
    default:
      return { ok: false, reason: "unknown_kind" };
  }
}

/**
 * Parse a decimal USDC string ("199.99", "200", "0.000001") into atomic units.
 * Returns null for anything that is not a plain non-negative decimal with at
 * most 6 fractional digits (no exponent, no sign, no rounding).
 */
export function parseUsdcAtomic(decimal: string): bigint | null {
  if (typeof decimal !== "string") return null;
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(decimal.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(6, "0");
  return BigInt(m[1]) * 1_000_000n + BigInt(frac);
}
