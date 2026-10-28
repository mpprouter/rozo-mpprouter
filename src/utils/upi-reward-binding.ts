// upi-reward-binding-v1: the shared invoice binding fingerprint for the UPI
// rewards (verified-funding v2) path.
//
// THIS FILE IS SHARED VERBATIM between:
//   - mpprouter/rozo-mpprouter          src/utils/upi-reward-binding.ts
//   - shawnmuggle/shawn-local-skills    supabase/functions/pay-invoice/upi-reward-binding.ts
// and is checked against the same golden fixtures
// (upi-reward-binding-v1.golden.json) in both repos and in MuggleLink.
// Keep it dependency-free (WebCrypto + TextEncoder only) so it runs unchanged
// on Cloudflare Workers, Node (vitest) and Deno. Change it in all places at
// once, together with the fixtures.
//
// Spec (docs/design/20261028-upi-rewards-implementation.zh.md §6):
//   fingerprint = hex(SHA-256(UTF-8(JSON.stringify([
//     version, provider family, invoice_key, usd cents, usdc atomic,
//     chain id, lowercase token address, target binding
//   ]))))
//   target binding = JSON.stringify of a 2-element string array:
//     coinbase_v1: [contractAddress lowercase, nonce lowercase hex]
//     coinbase_v3: [paymentTargetWallet.network, address lowercase]
// Numbers are canonical decimal strings. Missing fields, non-integers, any
// surrounding/embedded whitespace and malformed addresses are rejected; display
// names never enter the hash. Expiry and payable state are checked separately
// (rewardPayability), never hashed.

export const UPI_REWARD_BINDING_VERSION = 'upi-reward-binding-v1'

export type RewardProviderFamily = 'coinbase_v1' | 'coinbase_v3'

export type RewardBindingErrorCode =
  | 'invalid_provider'
  | 'invalid_invoice_key'
  | 'invalid_integer'
  | 'invalid_address'
  | 'invalid_nonce'
  | 'invalid_target'
  | 'invalid_amount'
  | 'unsupported_currency'
  | 'unsupported_network'
  | 'missing_field'

export class RewardBindingError extends Error {
  readonly code: RewardBindingErrorCode
  constructor(code: RewardBindingErrorCode, message: string) {
    super(message)
    this.name = 'RewardBindingError'
    this.code = code
  }
}

export interface RewardBindingInput {
  provider_family: RewardProviderFamily
  invoice_key: string
  usd_cents: string | number | bigint
  usdc_atomic: string | number | bigint
  chain_id: string | number | bigint
  token_address: string
  target_binding: [string, string]
}

export interface RewardBinding {
  version: typeof UPI_REWARD_BINDING_VERSION
  provider_family: RewardProviderFamily
  invoice_key: string
  usd_cents: string
  usdc_atomic: string
  chain_id: string
  token_address: string
  target_binding: string // the JSON string of the 2-element array
  canonical_json: string
  fingerprint: string
}

const BASE_CHAIN_ID = '8453'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/
const V1_KEY_RE = /^pl_[0-9A-Za-z]{1,128}$/
const V3_KEY_RE = /^paymentSession_[0-9A-Za-z-]{1,128}$/
const NETWORK_RE = /^[A-Za-z0-9_]{1,64}$/
const CANONICAL_INT_RE = /^(0|[1-9][0-9]*)$/
// Plain decimal, no sign, no exponent, no whitespace.
const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/
// v3 payment target networks that mean Base mainnet (exact match, lowercased).
const V3_BASE_NETWORKS = new Set(['payment_target_network_base', 'base'])

function fail(code: RewardBindingErrorCode, message: string): never {
  throw new RewardBindingError(code, message)
}

/** Canonical decimal integer string; positive unless allowZero. */
export function canonicalInteger(value: unknown, label: string, allowZero = false): string {
  let s: string
  if (typeof value === 'bigint') {
    s = value.toString()
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('invalid_integer', `${label} must be a safe integer`)
    s = String(value)
  } else if (typeof value === 'string') {
    s = value
  } else {
    fail(value === undefined || value === null ? 'missing_field' : 'invalid_integer', `${label} is required`)
  }
  if (!CANONICAL_INT_RE.test(s)) fail('invalid_integer', `${label} must be a canonical non-negative integer`)
  if (!allowZero && s === '0') fail('invalid_integer', `${label} must be positive`)
  return s
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('missing_field', `${label} is required`)
  return value
}

function canonicalAddress(value: unknown, label: string): string {
  const s = requireString(value, label)
  if (!ADDRESS_RE.test(s)) fail('invalid_address', `${label} is not a 0x-prefixed 20-byte address`)
  return s.toLowerCase()
}

function canonicalNonce(value: unknown, label: string): string {
  const s = requireString(value, label)
  if (!NONCE_RE.test(s)) fail('invalid_nonce', `${label} is not a 0x-prefixed 32-byte hex value`)
  return s.toLowerCase()
}

/** Build the target binding JSON string for a provider family (strict). */
export function canonicalTargetBinding(family: RewardProviderFamily, target: unknown): string {
  if (!Array.isArray(target) || target.length !== 2) {
    fail('invalid_target', 'target_binding must be a 2-element array')
  }
  if (family === 'coinbase_v1') {
    return JSON.stringify([
      canonicalAddress(target[0], 'target contractAddress'),
      canonicalNonce(target[1], 'target nonce'),
    ])
  }
  const network = requireString(target[0], 'target network')
  if (!NETWORK_RE.test(network)) fail('invalid_target', 'target network is not a bare identifier')
  return JSON.stringify([network, canonicalAddress(target[1], 'target address')])
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Compute the upi-reward-binding-v1 fingerprint from canonical fields. */
export async function computeRewardBinding(input: RewardBindingInput): Promise<RewardBinding> {
  if (!input || typeof input !== 'object') fail('missing_field', 'input is required')
  const family = input.provider_family
  if (family !== 'coinbase_v1' && family !== 'coinbase_v3') {
    fail('invalid_provider', 'provider_family must be coinbase_v1 or coinbase_v3')
  }
  const invoiceKey = requireString(input.invoice_key, 'invoice_key')
  if (!(family === 'coinbase_v1' ? V1_KEY_RE : V3_KEY_RE).test(invoiceKey)) {
    fail('invalid_invoice_key', `invoice_key is not a ${family} id`)
  }
  const usdCents = canonicalInteger(input.usd_cents, 'usd_cents')
  const usdcAtomic = canonicalInteger(input.usdc_atomic, 'usdc_atomic')
  const chainId = canonicalInteger(input.chain_id, 'chain_id')
  const token = canonicalAddress(input.token_address, 'token_address')
  const target = canonicalTargetBinding(family, input.target_binding)
  const canonical = JSON.stringify([
    UPI_REWARD_BINDING_VERSION,
    family,
    invoiceKey,
    usdCents,
    usdcAtomic,
    chainId,
    token,
    target,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return {
    version: UPI_REWARD_BINDING_VERSION,
    provider_family: family,
    invoice_key: invoiceKey,
    usd_cents: usdCents,
    usdc_atomic: usdcAtomic,
    chain_id: chainId,
    token_address: token,
    target_binding: target,
    canonical_json: canonical,
    fingerprint: hex(digest),
  }
}

/** Exact decimal string → atomic integer (no float, no rounding, no whitespace). */
export function decimalToAtomicStrict(value: unknown, decimals: number, label: string): string {
  const s = requireString(value, label)
  if (!DECIMAL_RE.test(s)) fail('invalid_amount', `${label} is not a plain decimal`)
  const [whole, frac = ''] = s.split('.')
  if (frac.length > decimals) fail('invalid_amount', `${label} has more than ${decimals} decimals`)
  const atomic = BigInt(whole + frac.padEnd(decimals, '0'))
  return atomic.toString()
}

/**
 * Derive the binding input from a raw Coinbase next-api payload:
 *   v1 payment link  (`/next-api/payment-links/pl_*`)
 *   v3 payment session (`/next-api/payment-sessions/paymentSession_*`)
 * Strict: every field the fingerprint needs must be present and well formed.
 */
export function rewardBindingInputFromCoinbase(payload: unknown): RewardBindingInput {
  if (!payload || typeof payload !== 'object') fail('missing_field', 'payload is required')
  const p = payload as Record<string, any>
  if (typeof p.paymentSessionId === 'string') {
    const asset = requireString(p.asset, 'asset')
    if (asset.toLowerCase() !== 'usdc' && asset.toLowerCase() !== 'usd') {
      fail('unsupported_currency', 'payment session asset must be USDC')
    }
    const wallet = p.target?.paymentTargetWallet
    if (!wallet || typeof wallet !== 'object') fail('invalid_target', 'payment session has no paymentTargetWallet')
    const network = requireString(wallet.network, 'paymentTargetWallet.network')
    if (!V3_BASE_NETWORKS.has(network.toLowerCase())) {
      fail('unsupported_network', 'payment session does not target Base mainnet')
    }
    return {
      provider_family: 'coinbase_v3',
      invoice_key: p.paymentSessionId,
      usd_cents: decimalToAtomicStrict(p.amount, 2, 'amount'),
      usdc_atomic: decimalToAtomicStrict(p.amount, 6, 'amount'),
      chain_id: BASE_CHAIN_ID,
      token_address: BASE_USDC,
      target_binding: [network, wallet.address],
    }
  }
  if (typeof p.id === 'string') {
    const currency = requireString(p.fiat?.currency, 'fiat.currency')
    if (currency.toLowerCase() !== 'usd') fail('unsupported_currency', 'payment link fiat must be USD')
    if (typeof p.networkId !== 'number') fail('missing_field', 'networkId is required')
    return {
      provider_family: 'coinbase_v1',
      invoice_key: p.id,
      usd_cents: decimalToAtomicStrict(p.fiat?.amount, 2, 'fiat.amount'),
      usdc_atomic: decimalToAtomicStrict(p.maxAmount, 6, 'maxAmount'),
      chain_id: p.networkId,
      token_address: p.token,
      target_binding: [p.contractAddress, p.nonce],
    }
  }
  fail('missing_field', 'payload is neither a v1 payment link nor a v3 payment session')
}

/** Fingerprint straight from a raw Coinbase payload. */
export async function rewardBindingFromCoinbase(payload: unknown): Promise<RewardBinding> {
  return computeRewardBinding(rewardBindingInputFromCoinbase(payload))
}

export interface RewardPayability {
  payable: boolean
  reason: string | null
  expires_at: string | null
}

/**
 * Payable state and expiry, checked separately from the fingerprint. Fails
 * closed: unverifiable usage or expiry is not payable.
 *   v1: usageCount < maxUsage and preApprovalExpiry (unix seconds) in the future
 *   v3: status === PAYMENT_SESSION_STATUS_CREATED and expiresAt in the future
 */
export function rewardPayability(payload: unknown, nowMs: number): RewardPayability {
  const p = (payload ?? {}) as Record<string, any>
  let expMs: number
  if (typeof p.paymentSessionId === 'string') {
    expMs = typeof p.expiresAt === 'string' ? Date.parse(p.expiresAt) : NaN
    const expiresAt = Number.isFinite(expMs) ? new Date(expMs).toISOString() : null
    if (p.status !== 'PAYMENT_SESSION_STATUS_CREATED') {
      return { payable: false, reason: 'not_payable_state', expires_at: expiresAt }
    }
    if (!Number.isFinite(expMs)) return { payable: false, reason: 'expiry_unverifiable', expires_at: null }
    if (expMs <= nowMs) return { payable: false, reason: 'expired', expires_at: expiresAt }
    return { payable: true, reason: null, expires_at: expiresAt }
  }
  const raw = p.preApprovalExpiry
  expMs = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) * 1000 : NaN
  const expiresAt = Number.isFinite(expMs) ? new Date(expMs).toISOString() : null
  if (typeof p.usageCount !== 'number' || typeof p.maxUsage !== 'number') {
    return { payable: false, reason: 'usage_unverifiable', expires_at: expiresAt }
  }
  if (p.usageCount >= p.maxUsage) return { payable: false, reason: 'already_used', expires_at: expiresAt }
  if (!Number.isFinite(expMs)) return { payable: false, reason: 'expiry_unverifiable', expires_at: null }
  if (expMs <= nowMs) return { payable: false, reason: 'expired', expires_at: expiresAt }
  return { payable: true, reason: null, expires_at: expiresAt }
}
