/**
 * The Base USDC funder wallet: the one source of truth for its address.
 *
 * It receives caller USDC (every Coinbase / Bitrefill / TRON / TON order's
 * settlement destination) and pays Coinbase invoices through agentapi's
 * remote signer. This module imports only leaf modules (funder-tiers.ts,
 * evm-blocked-addresses.ts, routes/native-sources.ts whose only import is
 * bech32.ts) and viem, so webhook.ts, stripe-fulfillment.ts,
 * create-invoice.ts, bitrefill-binding.ts and tron-ton-alpha.ts can all read
 * it without an import cycle.
 *
 * Rotated 2026-11-24: the previous funder 0x2352Fa...1739 was compromised and
 * swept. The new key lives only in the remote signer (Supabase rozo-sg
 * PRIVATE_KEY); this Worker never holds it.
 */
import { getAddress } from 'viem'
import { EVM_BLOCKED_ADDRESSES } from './evm-blocked-addresses'
import { ORDER_CAP_USD } from './routes/native-sources'
import {
  ALPHA_KIND,
  FUNDER_TIERS,
  orderCapAtomicFromUsd,
  payFromReceivingWallet,
  routeFunder,
  routeNoOrderFunder,
  servedByLegacyFunder,
  type FunderTier,
  type FunderTierRefusal,
  type FunderWallet,
} from './funder-tiers'

export const BASE_FUNDER_ADDRESS = '0x282bE0C42E5c944b0285CEc363117AB077cC084A'

/**
 * The order cap the tier selector enforces, in USDC atomic units. Single
 * source: ORDER_CAP_USD (src/routes/native-sources.ts), the same per-order
 * cap the checkout uses. Raising it needs no change to funder-tiers.ts or the
 * vectors; tier bands ("below $200" / "$200 and above") do not depend on it.
 */
export const FUNDER_ORDER_CAP_ATOMIC: bigint = orderCapAtomicFromUsd(ORDER_CAP_USD)

/**
 * The compromised funder (2026-11-24). NEVER a payout target, a balance to
 * check or a receiver for a new order: anything sent there is swept.
 *
 * Kept only so the Bitrefill receiver blocklist refuses it and a test can pin
 * that no funder constant equals it.
 */
export const RETIRED_FUNDER_ADDRESS_20261124 = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'

// ── Tiered funder wallets (FUNDER_TIERS_ENABLED) ────────────────────────────
//
// Four Base USDC wallets instead of one (rules in src/funder-tiers.ts, which
// the remote signer shares byte for byte):
//   T1  x402 only (sign-x402)             FUNDER_T1_ADDRESS
//   T2  Coinbase invoices below $200      FUNDER_T2_ADDRESS
//   T3A Coinbase invoices $200 to $1,200  FUNDER_T3A_ADDRESS
//   T3B Stripe / Bitrefill / other        FUNDER_T3B_ADDRESS
//
// Only the exact string "true" in FUNDER_TIERS_ENABLED turns this on. Off
// (unset, "false", "TRUE", " true", anything else): resolveFunder returns the
// legacy BASE_FUNDER_ADDRESS for every input and every caller behaves exactly
// as before (same receiver, balance address, expected signer and bodies).
//
// On: the selected tier's address must be configured and pass every check
// below, otherwise the resolver refuses and the caller creates no order and
// pays nothing. There is no fallback to another tier or to the legacy wallet.

export interface FunderTierEnv {
  FUNDER_TIERS_ENABLED?: string
  FUNDER_T1_ADDRESS?: string
  FUNDER_T2_ADDRESS?: string
  FUNDER_T3A_ADDRESS?: string
  FUNDER_T3B_ADDRESS?: string
  /**
   * Phase 2a: exactly "legacy" = T3A / T3B are served by the legacy funder
   * (same variable the signer reads). Anything else: T3 tier wallets.
   */
  FUNDER_T3_BACKEND?: string
}

export type FunderConfigRefusal =
  | 'tier_address_missing'
  | 'tier_address_invalid'
  | 'tier_address_zero'
  | 'tier_address_retired'
  | 'tier_address_legacy'
  | 'tier_address_blocked'
  | 'tier_address_duplicate'

export type FunderRefusalReason = FunderTierRefusal | FunderConfigRefusal

export type FunderResolution =
  | {
      ok: true
      /** 'legacy' while the flag is off. */
      tier: FunderTier | 'legacy'
      /** EIP-55 checksummed. */
      address: string
      /**
       * The `expected_funder` value to send to pay-invoice. Undefined while the
       * flag is off: legacy bodies never carry the field.
       */
      expectedFunder: string | undefined
    }
  | { ok: false; reason: FunderRefusalReason; tier: FunderTier | null }

/** Error code every caller uses for a resolver refusal. */
export const FUNDER_TIER_REFUSED_CODE = 'FUNDER_TIER_REFUSED'
/** Error code when an order's destination is not the selected tier wallet. */
export const FUNDER_TIER_RECEIVER_MISMATCH_CODE = 'FUNDER_TIER_RECEIVER_MISMATCH'

const TIER_VAR: Record<FunderTier, keyof FunderTierEnv> = {
  T1: 'FUNDER_T1_ADDRESS',
  T2: 'FUNDER_T2_ADDRESS',
  T3A: 'FUNDER_T3A_ADDRESS',
  T3B: 'FUNDER_T3B_ADDRESS',
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const BASE_USDC_LOWER = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BLOCKED: ReadonlySet<string> = new Set([...EVM_BLOCKED_ADDRESSES, BASE_USDC_LOWER])

export function funderTiersEnabled(env: FunderTierEnv | null | undefined): boolean {
  return env?.FUNDER_TIERS_ENABLED === 'true'
}

/** Raw syntax + checksum check of one configured value. Exported for tests. */
export function checksumFunderAddress(raw: unknown): { ok: true; address: string } | { ok: false; reason: 'tier_address_missing' | 'tier_address_invalid' } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'tier_address_missing' }
  const v = raw.trim()
  if (!EVM_RE.test(v)) return { ok: false, reason: 'tier_address_invalid' }
  let checksummed: string
  try {
    checksummed = getAddress(v.toLowerCase())
  } catch {
    return { ok: false, reason: 'tier_address_invalid' }
  }
  // Mixed case carries a checksum: it must be the right one. All-lower or
  // all-upper hex carries none and is accepted.
  const hex = v.slice(2)
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase()
  if (mixed && v !== checksummed) return { ok: false, reason: 'tier_address_invalid' }
  return { ok: true, address: checksummed }
}

/**
 * The validated address of one tier, ignoring the flag. Checks: present,
 * valid (checksum), not zero, not the retired or the legacy funder, not on the
 * EVM blocklist (or the USDC contract), not equal to another tier's address.
 */
export function funderTierAddress(
  env: FunderTierEnv | null | undefined,
  tier: FunderTier,
): { ok: true; address: string } | { ok: false; reason: FunderConfigRefusal } {
  const own = checksumFunderAddress(env?.[TIER_VAR[tier]])
  if (!own.ok) return own
  const lower = own.address.toLowerCase()
  if (lower === ZERO) return { ok: false, reason: 'tier_address_zero' }
  if (lower === RETIRED_FUNDER_ADDRESS_20261124.toLowerCase()) return { ok: false, reason: 'tier_address_retired' }
  if (lower === BASE_FUNDER_ADDRESS.toLowerCase()) return { ok: false, reason: 'tier_address_legacy' }
  if (BLOCKED.has(lower)) return { ok: false, reason: 'tier_address_blocked' }
  for (const other of FUNDER_TIERS) {
    if (other === tier) continue
    // Phase 2a: a T3 served by the legacy funder has no wallet of its own; a
    // leftover FUNDER_T3A/T3B_ADDRESS value must not block T1 / T2.
    if (servedByLegacyFunder(other, env?.FUNDER_T3_BACKEND)) continue
    const raw = env?.[TIER_VAR[other]]
    if (typeof raw === 'string' && raw.trim().toLowerCase() === lower) {
      return { ok: false, reason: 'tier_address_duplicate' }
    }
  }
  return { ok: true, address: own.address }
}

/**
 * Which funder wallet receives and pays a payment of `kind` for
 * `amountAtomic` (the USDC the funder signs for, 6 decimals: the invoice
 * amount, not the caller's fee-inclusive price).
 *
 * Flag off: always `{ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS,
 * expectedFunder: undefined }`, whatever the kind or amount.
 */
export function resolveFunder(
  env: FunderTierEnv | null | undefined,
  kind: string,
  amountAtomic: bigint,
): FunderResolution {
  if (!funderTiersEnabled(env)) {
    return { ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: undefined }
  }
  // routeFunder (mirrored with the signer) is the single routing rule.
  // LEGACY = phase 2a (FUNDER_T3_BACKEND="legacy"): T3A / T3B payments and
  // TRON / TON alpha orders from $200 are served by the legacy funder exactly
  // as with the flag off (receiver, balance), and the signer serves them with
  // the same wallet, so expected_funder is that wallet too. Alpha orders
  // below $200 route to T2 like plain Coinbase ones. FUNDER_T3A_ADDRESS /
  // FUNDER_T3B_ADDRESS are not read then.
  const route = routeFunder(kind, amountAtomic, env?.FUNDER_T3_BACKEND, FUNDER_ORDER_CAP_ATOMIC)
  if (!route.ok) return { ok: false, reason: route.reason, tier: null }
  if (route.wallet === 'LEGACY') {
    return { ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS }
  }
  const addr = funderTierAddress(env, route.wallet)
  if (!addr.ok) return { ok: false, reason: addr.reason, tier: route.wallet }
  return { ok: true, tier: route.wallet, address: addr.address, expectedFunder: addr.address }
}

/**
 * Which wallet pays a payment that has NO intents order (coupon, UPI, admin
 * pay): routeNoOrderFunder, mirrored with the signer. Same as resolveFunder,
 * except that T3A / T3B become the legacy funder: the phase 2b KMS signer only
 * signs against a paid-out intents order received by its wallet, so it cannot
 * pay these. Phase 2a and flag off: identical to resolveFunder. Never use it
 * for a new order's destination (that is resolveFunder).
 */
export function resolveNoOrderFunder(
  env: FunderTierEnv | null | undefined,
  kind: string,
  amountAtomic: bigint,
): FunderResolution {
  if (!funderTiersEnabled(env)) return resolveFunder(env, kind, amountAtomic)
  const route = routeNoOrderFunder(kind, amountAtomic, env?.FUNDER_T3_BACKEND, FUNDER_ORDER_CAP_ATOMIC)
  if (!route.ok) return { ok: false, reason: route.reason, tier: null }
  if (route.wallet === 'LEGACY') {
    return { ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS }
  }
  const addr = funderTierAddress(env, route.wallet)
  if (!addr.ok) return { ok: false, reason: addr.reason, tier: route.wallet }
  return { ok: true, tier: route.wallet, address: addr.address, expectedFunder: addr.address }
}

export type PayingFunderResolution =
  | (Extract<FunderResolution, { ok: true }> & {
      /** Where routeFunder would have sent a new order of this kind/amount. */
      nominal: FunderWallet | null
      /** Non-null = amount outside the receiving wallet's nominal range (never blocks). */
      warning: string | null
    })
  | { ok: false; reason: FunderRefusalReason | 'wrong_wallet_for_kind' | 'receiver_not_tier_wallet'; tier: FunderTier | null }

/** Error code when an order's payout destination is not a configured paying wallet. */
export const FUNDER_RECEIVER_NOT_TIER_WALLET_CODE = 'FUNDER_RECEIVER_NOT_TIER_WALLET'

/**
 * Map an order's actual payout destination to a configured paying wallet
 * (flag on only): a validated tier address, or the legacy funder while it is
 * a paying wallet (phase 2a). Anything else (unknown, retired, blocklisted,
 * missing): null.
 */
export function receivingFunderWallet(
  env: FunderTierEnv | null | undefined,
  receiver: unknown,
): { wallet: FunderWallet; address: string } | null {
  if (typeof receiver !== 'string' || !EVM_RE.test(receiver.trim())) return null
  const r = receiver.trim().toLowerCase()
  if (BLOCKED.has(r) || r === ZERO || r === RETIRED_FUNDER_ADDRESS_20261124.toLowerCase()) return null
  // The legacy funder stays a PAYING wallet on every backend: in phase 2a it
  // is T3A / T3B; in phase 2b it is never a new order's destination
  // (routeFunder never returns LEGACY then), but orders created before the
  // switch with the legacy destination must still be paid by it until they
  // drain (founder 2026-11-24: the wallet that received the money pays it).
  // The signer pays them only while its PRIVATE_KEY is configured.
  if (r === BASE_FUNDER_ADDRESS.toLowerCase()) return { wallet: 'LEGACY', address: BASE_FUNDER_ADDRESS }
  for (const tier of FUNDER_TIERS) {
    if (servedByLegacyFunder(tier, env?.FUNDER_T3_BACKEND)) continue
    const a = funderTierAddress(env, tier)
    if (a.ok && a.address.toLowerCase() === r) return { wallet: tier, address: a.address }
  }
  return null
}

/**
 * Which wallet pays out an order whose money already landed (founder
 * 2026-11-24: tier amounts route NEW orders; they never block paying out money
 * that arrived). The paying wallet is the order's actual payout destination
 * (`receiver`), never one recomputed from the amount. An amount outside that
 * wallet's nominal range returns `warning` (log + alert, never a refusal).
 *
 * Refused (fail closed): destination not a configured paying wallet, amount
 * not positive or above the order cap, unknown kind, x402 rules (T1 only, <=
 * $5), non-x402 money in T1 (payFromReceivingWallet).
 *
 * Flag off: exactly resolveFunder's legacy answer (receiver not consulted).
 */
export function resolvePayingFunder(
  env: FunderTierEnv | null | undefined,
  kind: string,
  amountAtomic: bigint,
  receiver: unknown,
): PayingFunderResolution {
  if (!funderTiersEnabled(env)) {
    return { ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: undefined, nominal: null, warning: null }
  }
  const recv = receivingFunderWallet(env, receiver)
  if (!recv) return { ok: false, reason: 'receiver_not_tier_wallet', tier: null }
  const d = payFromReceivingWallet(kind, amountAtomic, recv.wallet, env?.FUNDER_T3_BACKEND, FUNDER_ORDER_CAP_ATOMIC)
  if (!d.ok) return { ok: false, reason: d.reason, tier: null }
  return {
    ok: true,
    tier: recv.wallet === 'LEGACY' ? 'legacy' : recv.wallet,
    address: recv.address,
    expectedFunder: recv.address,
    nominal: d.nominal,
    warning: d.warning,
  }
}

/**
 * Wallets to monitor. Flag off: the legacy funder only. Flag on: every tier,
 * with its validated address or the refusal (a monitor reports the gap).
 */
export function configuredFunderWallets(
  env: FunderTierEnv | null | undefined,
): Array<{ tier: FunderTier | 'legacy'; address: string | null; reason?: FunderConfigRefusal }> {
  if (!funderTiersEnabled(env)) return [{ tier: 'legacy', address: BASE_FUNDER_ADDRESS }]
  const out: Array<{ tier: FunderTier | 'legacy'; address: string | null; reason?: FunderConfigRefusal }> = []
  let legacyListed = false
  for (const tier of FUNDER_TIERS) {
    if (servedByLegacyFunder(tier, env?.FUNDER_T3_BACKEND)) {
      // Phase 2a: T3A / T3B are the legacy funder; watch it once.
      if (!legacyListed) out.push({ tier: 'legacy', address: BASE_FUNDER_ADDRESS })
      legacyListed = true
      continue
    }
    const r = funderTierAddress(env, tier)
    out.push(r.ok ? { tier, address: r.address } : { tier, address: null, reason: r.reason })
  }
  // Phase 2b: the legacy funder still pays legacy-destination orders (drain)
  // and T3-sized payments with no intents order (resolveNoOrderFunder), so it
  // is still watched.
  if (!legacyListed) out.push({ tier: 'legacy', address: BASE_FUNDER_ADDRESS })
  return out
}

/** True when `address` equals the configured, valid address of any tier (flag on only). */
export function isAnyConfiguredFunderTier(env: FunderTierEnv | null | undefined, address: string): boolean {
  if (!funderTiersEnabled(env)) return false
  const a = address.toLowerCase()
  return configuredFunderWallets(env).some((w) => w.address !== null && w.address.toLowerCase() === a)
}

/** Payment kind of a TRON / TON alpha business order (mirrored selector). */
export const FUNDER_ALPHA_KIND = ALPHA_KIND

// ── Pay only after the order paid out (FUNDER_TIERS_ENABLED) ────────────────
//
// With tiers on, every order-backed pay request carries `rozo_payment_id`, and
// the signer (pay-invoice order-destination.ts / alpha-verify.ts) refuses to
// sign until that order is paid out: status in its PAID_OUT_STATUSES and a
// Base payout tx hash. The payin_completed webhook arrives seconds before the
// payout lands, so paying on it is always refused (2026-11-24: three orders
// stranded as failed_pay_invoice). Callers therefore wait for the payout, and
// treat the signer's "not paid out yet" answer as not ready, never terminal.

/** Order statuses the signer accepts as paid out (mirrors its PAID_OUT_STATUSES). */
export const SIGNER_PAID_OUT_STATUSES: ReadonlySet<string> = new Set([
  'payment_payout_completed',
  'payment_completed',
])

/** True when the intents order row shows a status the signer accepts as paid out. */
export function orderPaidOutForSigner(order: any): boolean {
  const status = order?.status ?? order?.payment_status
  return typeof status === 'string' && SIGNER_PAID_OUT_STATUSES.has(status)
}

/** Signer refusal codes that mean "the order has not paid out yet" (nothing signed). */
export const SIGNER_NOT_PAID_OUT_CODES: ReadonlySet<string> = new Set([
  'ORDER_NOT_PAID_OUT',
  'ALPHA_ORDER_NOT_PAID_OUT',
])

/**
 * The signer refused only because the order has not paid out yet: HTTP 409,
 * an explicit `signed: false`, and a not-paid-out code. Nothing was signed, so
 * the attempt may be retried once the payout lands. Anything else (any other
 * code, `signed` missing or true, another status) is NOT this.
 */
export function isSignerNotPaidOutYet(status: number, body: any): boolean {
  return (
    status === 409 &&
    body !== null &&
    typeof body === 'object' &&
    body.signed === false &&
    typeof body.code === 'string' &&
    SIGNER_NOT_PAID_OUT_CODES.has(body.code)
  )
}

/** metadata.source the TRON / TON alpha route writes on the business order it creates. */
export const ALPHA_ORDER_SOURCE = 'mpprouter-tron-ton-alpha'

/**
 * True when an intents order row was created by the TRON / TON alpha route
 * (its destination is the funder routed for kind tron_ton_alpha when it was
 * created: the legacy funder before 2026-11-24's T2 rule, then T2 below $200).
 * An order created by the main checkout is a Coinbase order even if a TRON /
 * TON payment later lands on it.
 */
export function isTronTonAlphaOrder(row: any): boolean {
  let metadata = row?.metadata ?? row?.data?.metadata
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata)
    } catch {
      return false
    }
  }
  return !!metadata && typeof metadata === 'object' && (metadata as any).source === ALPHA_ORDER_SOURCE
}

/** Payment kind for a Coinbase-invoice order row: alpha business order or plain Coinbase. */
export function coinbaseOrderKind(row: any): string {
  return isTronTonAlphaOrder(row) ? ALPHA_KIND : 'coinbase'
}

/** Same address, case-insensitive. Non-strings never match. */
export function sameEvmAddress(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase()
}

/** Caller-facing HTTP status for a refusal: amount problems are 400, config gaps 503. */
export function funderRefusalStatus(reason: FunderRefusalReason): number {
  return reason === 'over_order_cap' || reason === 'over_tier_cap' || reason === 'invalid_amount' ? 400 : 503
}

/** Caller-facing message for a refusal. Never names an address. */
export function funderRefusalMessage(reason: FunderRefusalReason): string {
  switch (reason) {
    case 'over_order_cap':
      return 'This invoice is above the per-order limit. Nothing was created or paid.'
    case 'over_tier_cap':
      return 'This payment is above the per-payment limit. Nothing was created or paid.'
    case 'invalid_amount':
      return 'The invoice amount is not a positive USDC amount. Nothing was created or paid.'
    default:
      return 'Payments are temporarily unavailable (funder wallet not configured). Nothing was created or paid; try again later.'
  }
}
