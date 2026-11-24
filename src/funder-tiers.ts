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
//   T2   OpenRouter Coinbase invoices below $200 (plain, and TRON / TON alpha
//        in phase 2a, see routeFunder). Hot key, balance <= 200 USDC.
//   T3A  OpenRouter Coinbase invoices of $200 and above.
//        CDP Server Wallet, policy allowlists only the Coinbase collectors.
//   T3B  Stripe crypto links, Bitrefill and any other merchant, any amount.
//        CDP Server Wallet, no contract allowlist.
//
// Tier bands have NO upper bound (founder 2026-11-24: "below $200" and "$200
// and above"). The order cap is a SEPARATE refuse-check with its own setting,
// passed in by the caller (`orderCapAtomic`): rozo-mpprouter ORDER_CAP_USD
// (src/routes/native-sources.ts), the signer env ORDER_CAP_USD. Raising the
// cap needs no change to this file or the vectors. A cap that is not a
// positive amount falls back to DEFAULT_ORDER_CAP_ATOMIC (fail closed, never
// "no cap").
//
// Band rules (selectFunderTier; amount = the USDC the funder will sign for, in
// 6-decimal atomic units, i.e. the invoice amount, NOT the caller's
// fee-inclusive price):
//   1. amount must be a positive integer, else refuse "invalid_amount".
//   2. kind "x402":      amount <= T1_MAX_ATOMIC            -> T1, else refuse
//                        "over_tier_cap" (T1's own per-payment cap).
//   3. kind "coinbase":  amount <  T2_MAX_EXCLUSIVE_ATOMIC  -> T2, else T3A.
//   4. kind "stripe" | "bitrefill" | "other":               -> T3B.
//   5. any other kind: refuse "unknown_kind".
// Then (routeFunder / payFromReceivingWallet) every non-x402 payment above the
// order cap is refused "over_order_cap". The boundary $200.00 exactly goes to
// T3A. There is no fallback between tiers: a refusal means "do not pay / do
// not create the order".
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
/**
 * Fail-closed fallback for the order cap ONLY: used when the configured cap
 * is unset, unparsable or not positive. The live cap is the caller's setting
 * (orderCapAtomicFromUsd); this is not the tier boundary of anything.
 */
export const DEFAULT_ORDER_CAP_ATOMIC = 1_200_000_000n;

export const FUNDER_TIERS: readonly FunderTier[] = ["T1", "T2", "T3A", "T3B"];

/**
 * The order cap from a configured USD value (number, or decimal string such
 * as "1200" / "1200.50"). Anything else (unset, empty, garbage, exponent,
 * zero, negative, more than 6 decimals) -> DEFAULT_ORDER_CAP_ATOMIC.
 */
export function orderCapAtomicFromUsd(raw: unknown): bigint {
  let s: string | null = null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) s = String(raw);
  else if (typeof raw === "string") s = raw;
  const a = s === null ? null : parseUsdcAtomic(s);
  return a !== null && a > 0n ? a : DEFAULT_ORDER_CAP_ATOMIC;
}

/** A usable cap: a positive bigint, else the fail-closed default. */
function effectiveOrderCap(orderCapAtomic: bigint): bigint {
  return typeof orderCapAtomic === "bigint" && orderCapAtomic > 0n
    ? orderCapAtomic
    : DEFAULT_ORDER_CAP_ATOMIC;
}

/** Tier band only (no order cap): which tier a payment of this kind/amount belongs to. */
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
      return amountAtomic < T2_MAX_EXCLUSIVE_ATOMIC
        ? { ok: true, tier: "T2" }
        : { ok: true, tier: "T3A" };
    case "stripe":
    case "bitrefill":
    case "other":
      return { ok: true, tier: "T3B" };
    default:
      return { ok: false, reason: "unknown_kind" };
  }
}

/**
 * Phased rollout (phase 2a): the T3 backend may be "legacy", meaning T3A and
 * T3B are NOT separate wallets yet and their payments are served exactly as
 * with the flag off, by the legacy single funder (receiving and paying).
 * Both repos read the same variable, FUNDER_T3_BACKEND. Only the exact
 * string "legacy" selects this; T1 and T2 are never served by legacy, and
 * selectFunderTier refusals are unaffected (a refused payment stays refused).
 */
export const T3_LEGACY_BACKEND = "legacy";

export function servedByLegacyFunder(
  tier: FunderTier,
  t3Backend: string | undefined,
): boolean {
  return (tier === "T3A" || tier === "T3B") && t3Backend === T3_LEGACY_BACKEND;
}

/**
 * TRON / TON alpha orders: Coinbase invoices paid with TRON / TON. Their
 * intents business order is created by rozo-mpprouter's alpha route, and its
 * payout destination is the wallet chosen here for a NEW order. It is routed
 * exactly like an ordinary Coinbase invoice of the same amount (founder
 * 2026-11-24: alpha below $200 -> T2; phase 2b: alpha from $200 -> T3A):
 *   above the order cap: refuse "over_order_cap" (any backend)
 *   amount <  T2_MAX_EXCLUSIVE_ATOMIC  -> T2
 *   amount >= T2_MAX_EXCLUSIVE_ATOMIC  -> T3A (LEGACY while t3Backend "legacy")
 * This only routes NEW orders. An order whose money already landed is paid by
 * the wallet it actually paid out to (payFromReceivingWallet), so an alpha
 * order created with the legacy destination is still paid by LEGACY after the
 * switch to phase 2b.
 */
export const ALPHA_KIND = "tron_ton_alpha";

export type FunderWallet = FunderTier | "LEGACY";

export type FunderRoute =
  | { ok: true; wallet: FunderWallet }
  | { ok: false; reason: FunderTierRefusal };

/**
 * The one routing function both repos use with FUNDER_TIERS_ENABLED on:
 * which wallet receives and pays this payment. LEGACY = the legacy single
 * funder (phase 2a interim). Refusals are final; there is no fallback.
 * `orderCapAtomic` is the caller's configured order cap (inclusive), applied
 * to every non-x402 payment after the band; it never changes which wallet a
 * payment under the cap routes to.
 */
export function routeFunder(
  kind: string,
  amountAtomic: bigint,
  t3Backend: string | undefined,
  orderCapAtomic: bigint,
): FunderRoute {
  const cap = effectiveOrderCap(orderCapAtomic);
  // Alpha routes exactly like a Coinbase invoice of the same amount.
  const d = selectFunderTier(kind === ALPHA_KIND ? "coinbase" : kind, amountAtomic);
  if (!d.ok) return d;
  if (d.tier !== "T1" && amountAtomic > cap) return { ok: false, reason: "over_order_cap" };
  return servedByLegacyFunder(d.tier, t3Backend)
    ? { ok: true, wallet: "LEGACY" }
    : { ok: true, wallet: d.tier };
}

/**
 * Payments that have NO intents order (coupon, UPI, admin pay): company money
 * paid out against an invoice, not order money that landed in a wallet. The
 * T3 wallets of phase 2b are signed by a KMS signer that only signs against a
 * paid-out intents order received by that wallet, so they cannot pay these.
 * Same as routeFunder, except that a T3A / T3B result becomes LEGACY (the
 * legacy single funder keeps paying them, exactly as in phase 2a). Refusals
 * and T1 / T2 results are unchanged. Phase 2a: identical to routeFunder.
 * Never use this to pick a NEW order's destination (that is routeFunder).
 */
export function routeNoOrderFunder(
  kind: string,
  amountAtomic: bigint,
  t3Backend: string | undefined,
  orderCapAtomic: bigint,
): FunderRoute {
  const r = routeFunder(kind, amountAtomic, t3Backend, orderCapAtomic);
  return r.ok && (r.wallet === "T3A" || r.wallet === "T3B") ? { ok: true, wallet: "LEGACY" } : r;
}

/**
 * Paying an order whose money already landed in a wallet (founder 2026-11-24:
 * tier amounts are a ROUTING rule for new orders, not a restriction on paying
 * out money that already arrived). The paying wallet is the wallet that
 * received the order's funds (`receivingWallet`, resolved from the intents
 * order's payout destination by the caller), never one recomputed from the
 * amount. An amount outside that wallet's nominal range is a WARNING (log and
 * alert), not a refusal.
 *
 * Still refused (fail closed):
 *   - amount not a positive integer, or above `orderCapAtomic` (the caller's
 *     configured global order cap);
 *   - kind x402: only T1, only up to T1_MAX_ATOMIC (not order money);
 *   - non-x402 money in T1 (T1 is x402 only);
 *   - an unknown kind.
 * The caller separately refuses a destination that is not a configured tier
 * wallet, and keeps where-money-may-go rules (T3A collector allowlist).
 */
export type PayDecision =
  | { ok: true; wallet: FunderWallet; nominal: FunderWallet | null; warning: string | null }
  | { ok: false; reason: FunderTierRefusal | "wrong_wallet_for_kind" };

export function payFromReceivingWallet(
  kind: string,
  amountAtomic: bigint,
  receivingWallet: FunderWallet,
  t3Backend: string | undefined,
  orderCapAtomic: bigint,
): PayDecision {
  if (typeof amountAtomic !== "bigint" || amountAtomic <= 0n) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (kind === "x402") {
    if (receivingWallet !== "T1") return { ok: false, reason: "wrong_wallet_for_kind" };
    return amountAtomic <= T1_MAX_ATOMIC
      ? { ok: true, wallet: "T1", nominal: "T1", warning: null }
      : { ok: false, reason: "over_tier_cap" };
  }
  if (kind !== ALPHA_KIND && kind !== "coinbase" && kind !== "stripe" && kind !== "bitrefill" && kind !== "other") {
    return { ok: false, reason: "unknown_kind" };
  }
  if (amountAtomic > effectiveOrderCap(orderCapAtomic)) return { ok: false, reason: "over_order_cap" };
  if (receivingWallet === "T1") return { ok: false, reason: "wrong_wallet_for_kind" };
  const route = routeFunder(kind, amountAtomic, t3Backend, orderCapAtomic);
  const nominal = route.ok ? route.wallet : null;
  const warning = nominal === receivingWallet
    ? null
    : `amount_outside_nominal_range: ${kind} ${amountAtomic} would route to ${nominal ?? "none"}, received by ${receivingWallet}`;
  return { ok: true, wallet: receivingWallet, nominal, warning };
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
