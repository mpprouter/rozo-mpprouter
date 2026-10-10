/**
 * x402 payer: which (scheme, network, asset) pairs we sign for, how a caller's
 * 402 `accepts` entry is validated, and the immutable hash that binds an
 * idempotency key to one payment requirement.
 *
 * Design: ainative todos/20261010-x402-payer-skill-design.zh.md 5.2 / 5.3.
 * v1 signs exactly two pairs, both USDC with 6 decimals:
 *   (exact, eip155:8453)                               EIP-3009 TransferWithAuthorization
 *   (exact, solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)   @x402/svm partially signed tx
 *
 * Network ids are CAIP-2 only. `solana:mainnet`, `solana`, `base`,
 * `base-mainnet` and friends are refused with a hint, never normalized: the
 * x402 spec keys everything on the CAIP-2 id, and @x402/svm would silently map
 * the v1 name `solana` to mainnet.
 */

export const BASE_MAINNET_CAIP2 = 'eip155:8453'
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

/** Canonical Base USDC (lowercased for comparison). */
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
/** Canonical Solana USDC mint. */
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** USDC decimals on both supported networks. */
export const USDC_DECIMALS = 6

/** EIP-712 domain of Base USDC (FiatTokenV2_2). */
export const BASE_USDC_EIP712_NAME = 'USD Coin'
export const BASE_USDC_EIP712_VERSION = '2'

export type SupportedNetwork = typeof BASE_MAINNET_CAIP2 | typeof SOLANA_MAINNET_CAIP2

export const SUPPORTED_PAIRS: ReadonlyArray<{ scheme: 'exact'; network: SupportedNetwork; asset: string }> = [
  { scheme: 'exact', network: BASE_MAINNET_CAIP2, asset: BASE_USDC },
  { scheme: 'exact', network: SOLANA_MAINNET_CAIP2, asset: SOLANA_USDC },
]

/** Shorthands we see in the wild; refused with a pointer to the CAIP-2 id. */
const SHORTHAND_HINTS: Record<string, string> = {
  'solana': SOLANA_MAINNET_CAIP2,
  'solana:mainnet': SOLANA_MAINNET_CAIP2,
  'solana-mainnet': SOLANA_MAINNET_CAIP2,
  'solana:mainnet-beta': SOLANA_MAINNET_CAIP2,
  'base': BASE_MAINNET_CAIP2,
  'base-mainnet': BASE_MAINNET_CAIP2,
  'base:mainnet': BASE_MAINNET_CAIP2,
  'eip155:base': BASE_MAINNET_CAIP2,
}

/** Bounds on maxTimeoutSeconds. x402 challenges use 60 to 300 s in practice. */
export const MIN_TIMEOUT_SECONDS = 10
export const MAX_TIMEOUT_SECONDS = 3600

/** Ceiling on a single requirement regardless of per-key limits (USDC atomic). */
export const MAX_AMOUNT_ATOMIC = 1_000_000_000n // $1,000

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const SVM_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const AMOUNT_RE = /^[1-9][0-9]{0,29}$/
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/

export interface ValidatedRequirement {
  scheme: 'exact'
  network: SupportedNetwork
  /** Canonical asset (lowercase for EVM). */
  asset: string
  /** Atomic amount, decimal string. */
  amount: string
  amountAtomic: bigint
  /** payTo as given for Solana; checksum-agnostic lowercase for EVM in the hash. */
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
  /** The entry exactly as the caller sent it (stored as the snapshot). */
  raw: Record<string, unknown>
}

export interface RequirementError {
  code: 'X402_UNSUPPORTED_NETWORK' | 'X402_UNSUPPORTED_SCHEME' | 'X402_UNSUPPORTED_ASSET' | 'X402_INVALID_REQUIREMENT'
  message: string
}

/** Validate one PaymentRequirements object (x402 v2 shape). */
export function validateRequirement(entry: unknown): { ok: ValidatedRequirement } | { error: RequirementError } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts entry must be an object.' } }
  }
  const raw = entry as Record<string, unknown>
  const scheme = raw.scheme
  const network = raw.network

  if (typeof network !== 'string' || !network) {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.network is required.' } }
  }
  const hint = SHORTHAND_HINTS[network.toLowerCase()]
  if (hint) {
    return {
      error: {
        code: 'X402_UNSUPPORTED_NETWORK',
        message: `Network "${network}" is not a CAIP-2 id. Use "${hint}".`,
      },
    }
  }
  if (network !== BASE_MAINNET_CAIP2 && network !== SOLANA_MAINNET_CAIP2) {
    return {
      error: {
        code: 'X402_UNSUPPORTED_NETWORK',
        message: `Network "${network}" is not supported. Supported: ${BASE_MAINNET_CAIP2}, ${SOLANA_MAINNET_CAIP2}.`,
      },
    }
  }
  if (scheme !== 'exact') {
    return { error: { code: 'X402_UNSUPPORTED_SCHEME', message: `Scheme "${String(scheme)}" is not supported; only "exact".` } }
  }

  const assetRaw = raw.asset
  if (typeof assetRaw !== 'string') {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.asset is required.' } }
  }
  const asset = network === BASE_MAINNET_CAIP2 ? assetRaw.toLowerCase() : assetRaw
  const canonical = network === BASE_MAINNET_CAIP2 ? BASE_USDC : SOLANA_USDC
  if (asset !== canonical) {
    return { error: { code: 'X402_UNSUPPORTED_ASSET', message: `Only USDC is supported on ${network} (asset ${canonical}).` } }
  }

  const amount = raw.amount
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.amount must be a positive integer string in atomic units.' } }
  }
  const amountAtomic = BigInt(amount)
  if (amountAtomic > MAX_AMOUNT_ATOMIC) {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.amount exceeds the single-payment ceiling.' } }
  }

  const payTo = raw.payTo
  if (typeof payTo !== 'string') {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.payTo is required.' } }
  }
  if (network === BASE_MAINNET_CAIP2 ? !EVM_ADDRESS_RE.test(payTo) : !SVM_ADDRESS_RE.test(payTo)) {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: `accepts.payTo is not a valid ${network} address.` } }
  }

  const t = raw.maxTimeoutSeconds
  if (typeof t !== 'number' || !Number.isInteger(t) || t < MIN_TIMEOUT_SECONDS || t > MAX_TIMEOUT_SECONDS) {
    return {
      error: {
        code: 'X402_INVALID_REQUIREMENT',
        message: `accepts.maxTimeoutSeconds must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}.`,
      },
    }
  }

  const extraRaw = raw.extra
  if (extraRaw !== undefined && (extraRaw === null || typeof extraRaw !== 'object' || Array.isArray(extraRaw))) {
    return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.extra must be an object.' } }
  }
  const extra = (extraRaw ?? {}) as Record<string, unknown>

  if (network === BASE_MAINNET_CAIP2) {
    // The EIP-712 domain comes from extra (x402 exact EVM spec). A wrong
    // name/version would produce a signature the token contract rejects, so
    // refuse it here instead of handing out a dud.
    if (extra.name !== BASE_USDC_EIP712_NAME || extra.version !== BASE_USDC_EIP712_VERSION) {
      return {
        error: {
          code: 'X402_INVALID_REQUIREMENT',
          message: `accepts.extra must carry the Base USDC EIP-712 domain {name: "${BASE_USDC_EIP712_NAME}", version: "${BASE_USDC_EIP712_VERSION}"}.`,
        },
      }
    }
  } else {
    if (typeof extra.feePayer !== 'string' || !SVM_ADDRESS_RE.test(extra.feePayer)) {
      return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts.extra.feePayer (the facilitator) is required on Solana.' } }
    }
  }

  return {
    ok: {
      scheme: 'exact',
      network,
      asset,
      amount,
      amountAtomic,
      payTo,
      maxTimeoutSeconds: t,
      extra,
      raw,
    },
  }
}

/**
 * Pick the requirement to sign from `accepts`: a single object, or the raw
 * 402 array (first entry we support wins, in the server's order). When nothing
 * is supported, the error of the first entry is returned.
 */
export function selectRequirement(accepts: unknown): { ok: ValidatedRequirement } | { error: RequirementError } {
  if (Array.isArray(accepts)) {
    if (accepts.length === 0 || accepts.length > 20) {
      return { error: { code: 'X402_INVALID_REQUIREMENT', message: 'accepts must hold 1 to 20 entries.' } }
    }
    let first: { error: RequirementError } | null = null
    for (const entry of accepts) {
      const r = validateRequirement(entry)
      if ('ok' in r) return r
      first ??= r
    }
    return first!
  }
  return validateRequirement(accepts)
}

/** JSON with object keys sorted recursively (stable across callers). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/**
 * The immutable fields an idempotency key is bound to. validBefore is not in
 * a v2 challenge; it is derived from maxTimeoutSeconds at signing time and
 * then frozen with the stored credential, so maxTimeoutSeconds is what binds.
 */
export function requirementHashInput(req: ValidatedRequirement): Record<string, unknown> {
  return {
    scheme: req.scheme,
    network: req.network,
    asset: req.asset,
    amount: req.amount,
    payTo: req.network === BASE_MAINNET_CAIP2 ? req.payTo.toLowerCase() : req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra,
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function requirementHash(req: ValidatedRequirement): Promise<string> {
  return sha256Hex(canonicalJson(requirementHashInput(req)))
}

/** Atomic USDC → decimal USD string with 6 places (exact, no float). */
export function atomicToUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n
  const frac = (atomic % 1_000_000n).toString().padStart(USDC_DECIMALS, '0')
  return `${whole}.${frac}`
}
