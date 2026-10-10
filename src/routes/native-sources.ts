// Native coin sources (ETH / BNB / POL / SOL, ZEC in beta) for the Coinbase checkout line, and
// the internal test payment id used to exercise it with small amounts.
//
// Founder 2026-09-27: native checkout is for merchant_openrouter (the appId
// every Coinbase order is created under). rozo-intents-api is the final gate
// (NATIVE_PAYIN_MERCHANTS); this Worker only rejects early and decides which
// coins the checkout offers. Chains open one at a time through the
// NATIVE_SOURCES var, e.g. "ETH@8453,ETH@1,BNB@56,SOL@900". Unset = none.
//
// Beta coins (ZEC on Zcash, 2026-10-10) are never opened by NATIVE_SOURCES
// alone: they are listed in NATIVE_SOURCES_BETA and only join the allowed set
// for a request that carries `?beta=<symbol>` (quote-invoice and
// create-invoice both read it). Without the param they are invisible and
// rejected as UNSUPPORTED_SOURCE.

export type NativeSymbol = 'ETH' | 'BNB' | 'POL' | 'SOL' | 'ZEC'

/** Stablecoin sources every checkout accepts (moved from create-invoice so the
 * quote route can report the same table without an import cycle). */
export const STABLE_SOURCES: Record<string, readonly ('USDC' | 'USDT')[]> = {
  '1':    ['USDC', 'USDT'],   // Ethereum
  '56':   ['USDC', 'USDT'],   // BNB Smart Chain (BSC) — downstream sol/evm monitors live
  '137':  ['USDC', 'USDT'],   // Polygon
  '8453': ['USDC'],           // Base
  '42161': ['USDC', 'USDT'],  // Arbitrum One
  '900':  ['USDC', 'USDT'],   // Solana — USDT payin supported (sol-pool-monitor)
  '1500': ['USDC'],           // Stellar
}


export interface NativeSourceDef {
  symbol: NativeSymbol
  tokenAddress: string
  /** Upstream route rozo-intents-api uses. Informational here (intents forces it). */
  provider?: 'near'
  /** Per-coin cap on callerPays in USD; the lower of this and NATIVE_MAX_USD applies. */
  maxUsd?: number
  /** Typical seconds from deposit to settlement, for the checkout copy. */
  etaSeconds?: number
  /** The payer must give a refund address at create time (body `refund_address`). */
  refundAddressRequired?: boolean
  /** Opened only through NATIVE_SOURCES_BETA + `?beta=<symbol>`. */
  beta?: boolean
}

export const NATIVE_SOURCE_DEFS: Record<string, NativeSourceDef> = {
  '8453': { symbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' },
  '1': { symbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' },
  // Arbitrum ETH (founder 2026-10-06). Live gate: rozotest order ae7a060d.
  '42161': { symbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' },
  '56': { symbol: 'BNB', tokenAddress: '0x0000000000000000000000000000000000000000' },
  // Polygon POL (18 decimals). rozo-intents-api accepts it for opted-in
  // merchants (merchant_openrouter, rozoAgent) since 2026-10-10.
  '137': { symbol: 'POL', tokenAddress: '0x0000000000000000000000000000000000000000' },
  '900': { symbol: 'SOL', tokenAddress: 'native' },
  // ZEC on Zcash (internal chain id 9133 = Zcash SLIP-44 coin type 133), routed
  // by rozo-intents-api through NEAR 1Click EXACT_OUTPUT to Base USDC. Beta
  // only; transparent (t1/t3) refund address required; no token address.
  '9133': {
    symbol: 'ZEC',
    tokenAddress: '',
    provider: 'near',
    maxUsd: 2000,
    etaSeconds: 480,
    refundAddressRequired: true,
    beta: true,
  },
}

const nativeKey = (chainId: string, d: NativeSourceDef) => `${d.symbol}@${chainId}`

/**
 * Every generally available native coin (beta coins excluded). Internal
 * rozotest_ invoices open this whole set; a beta coin still needs `?beta=`.
 */
export const ALL_NATIVE_SOURCES: ReadonlySet<string> = new Set(
  Object.entries(NATIVE_SOURCE_DEFS)
    .filter(([, d]) => !d.beta)
    .map(([chainId, d]) => nativeKey(chainId, d)),
)

/** Beta native coins: only reachable through NATIVE_SOURCES_BETA + `?beta=`. */
export const BETA_NATIVE_SOURCES: ReadonlySet<string> = new Set(
  Object.entries(NATIVE_SOURCE_DEFS)
    .filter(([, d]) => d.beta)
    .map(([chainId, d]) => nativeKey(chainId, d)),
)

/**
 * Parse the NATIVE_SOURCES var into "SYMBOL@chainId" keys we actually support.
 * Beta coins are dropped here: they open only per request (withBetaSources).
 */
export function parseNativeSources(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const key = part.trim().toUpperCase()
    if (ALL_NATIVE_SOURCES.has(key)) out.add(key)
  }
  return out
}

/** Parse NATIVE_SOURCES_BETA ("ZEC@9133") into known beta keys. */
export function parseBetaNativeSources(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const key = part.trim().toUpperCase()
    if (BETA_NATIVE_SOURCES.has(key)) out.add(key)
  }
  return out
}

/** Lowercased symbols named by a `?beta=` query param ("zec", "zec,foo"). */
export function betaParamSymbols(url: string | URL | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!url) return out
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return out
  }
  for (const value of parsed.searchParams.getAll('beta')) {
    for (const part of value.split(',')) {
      const sym = part.trim().toLowerCase()
      if (sym) out.add(sym)
    }
  }
  return out
}

/**
 * The native set for one request: `base` plus each NATIVE_SOURCES_BETA coin
 * whose symbol the request named in `?beta=`. No param (or an unset
 * NATIVE_SOURCES_BETA) returns `base` unchanged.
 */
export function withBetaSources(
  base: ReadonlySet<string>,
  betaRaw: string | undefined,
  requestUrl: string | URL | null | undefined,
): ReadonlySet<string> {
  const asked = betaParamSymbols(requestUrl)
  if (asked.size === 0) return base
  const out = new Set(base)
  for (const key of parseBetaNativeSources(betaRaw)) {
    if (asked.has(key.split('@')[0].toLowerCase())) out.add(key)
  }
  return out
}

/** Checkout metadata for an open native coin (see sourceMeta). */
export interface NativeSourceMeta {
  eta_seconds: number
  refund_address_required: boolean
  beta: boolean
  /** The deposit address is valid for one payment only; never pay it twice. */
  address_single_use: boolean
}

/**
 * Per-coin checkout metadata for the native coins open on this request, keyed
 * "SYMBOL@chainId". Only coins that carry metadata (today: near-routed ZEC)
 * appear; supportedSources keeps its { chainId: string[] } shape.
 */
export function sourceMeta(nativeAllowed: ReadonlySet<string> = new Set()): Record<string, NativeSourceMeta> {
  const out: Record<string, NativeSourceMeta> = {}
  for (const [chainId, d] of Object.entries(NATIVE_SOURCE_DEFS)) {
    const key = nativeKey(chainId, d)
    if (!nativeAllowed.has(key)) continue
    if (d.etaSeconds === undefined && !d.refundAddressRequired && !d.beta) continue
    out[key] = {
      eta_seconds: d.etaSeconds ?? 0,
      refund_address_required: !!d.refundAddressRequired,
      beta: !!d.beta,
      // near 1Click deposit addresses are single-quote, single-use.
      address_single_use: d.provider === 'near',
    }
  }
  return out
}

export function nativeSourceFor(
  chainId: string,
  tokenSymbol: string,
  allowed: ReadonlySet<string>,
): NativeSourceDef | null {
  const def = NATIVE_SOURCE_DEFS[chainId]
  if (!def || def.symbol !== tokenSymbol.toUpperCase()) return null
  return allowed.has(`${def.symbol}@${chainId}`) ? def : null
}

/**
 * Supported (chainId -> tokenSymbols) for a request: the stablecoin table plus
 * whichever native coins are open (NATIVE_SOURCES, or all of them for an
 * internal test invoice). The checkout renders its coin list from this.
 */
export function supportedSources(
  stable: Record<string, readonly string[]>,
  nativeAllowed: ReadonlySet<string> = new Set(),
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [chainId, tokens] of Object.entries(stable)) out[chainId] = [...tokens]
  for (const [chainId, def] of Object.entries(NATIVE_SOURCE_DEFS)) {
    if (!nativeAllowed.has(`${def.symbol}@${chainId}`)) continue
    out[chainId] = [...(out[chainId] ?? []), def.symbol]
  }
  return out
}

export function isNativeSymbol(chainId: string, tokenSymbol: string): boolean {
  const def = NATIVE_SOURCE_DEFS[chainId]
  return !!def && def.symbol === tokenSymbol.toUpperCase()
}

/** Upper bound on callerPays for a native source (same as the backend cap). */
export function nativeMaxUsd(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 2000
}

/** Cap for one native coin: the lower of its own maxUsd and NATIVE_MAX_USD. */
export function nativeMaxUsdFor(chainId: string, raw: string | undefined): number {
  const global = nativeMaxUsd(raw)
  const own = NATIVE_SOURCE_DEFS[chainId]?.maxUsd
  return typeof own === 'number' && own > 0 ? Math.min(own, global) : global
}

/** True for a native coin that needs a payer refund address (ZEC). */
export function nativeRequiresRefundAddress(chainId: string, tokenSymbol: string): boolean {
  const def = NATIVE_SOURCE_DEFS[chainId]
  return !!def && def.symbol === tokenSymbol.toUpperCase() && !!def.refundAddressRequired
}

// ── Internal test payment id ────────────────────────────────────────────────
//
// rozotest_<cents>_<nonce>_<sig>: an invoice that exists only here, so native
// checkout can be exercised end to end with a few cents. The order is created
// exactly like a real Coinbase one (merchant_openrouter, exactOut to the
// settlement wallet); only the final Coinbase payment is skipped by the
// webhook. sig = first 16 hex of HMAC-SHA256(ROZO_TEST_LINK_SECRET,
// "<cents>.<nonce>"), so only holders of the secret can mint one. Unset
// secret = test ids are rejected.

export const TEST_PAYMENT_ID_PREFIX = 'rozotest_'
export const TEST_MAX_CENTS = 2000 // $20
const TEST_ID_RE = /^rozotest_(\d{1,5})_([a-z0-9]{6,32})_([0-9a-f]{16})$/

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function isTestPaymentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(TEST_PAYMENT_ID_PREFIX)
}

/**
 * Fund-safety tripwire. Broader than isTestPaymentId on purpose: any id that
 * carries the test prefix anywhere (any case, behind a contract-variant
 * suffix, URL-encoded) is treated as a test id by the money paths, which
 * refuse it outright. A test order must never reach the funder or Coinbase.
 */
export function containsTestPaymentId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false
  let decoded = id
  try {
    decoded = decodeURIComponent(id)
  } catch {
    // keep the raw form
  }
  return /rozotest_/i.test(id) || /rozotest_/i.test(decoded)
}

export class TestInvoiceFundGuardError extends Error {
  constructor(where: string) {
    super(`refused: test payment id reached ${where}; test orders are never paid on the merchant side`)
    this.name = 'TestInvoiceFundGuardError'
  }
}

export async function signTestPaymentId(secret: string, cents: number, nonce: string): Promise<string> {
  if (!Number.isInteger(cents) || cents < 1 || cents > TEST_MAX_CENTS) throw new Error('cents out of range')
  if (!/^[a-z0-9]{6,32}$/.test(nonce)) throw new Error('bad nonce')
  const sig = (await hmacHex(secret, `${cents}.${nonce}`)).slice(0, 16)
  return `${TEST_PAYMENT_ID_PREFIX}${cents}_${nonce}_${sig}`
}

/** Returns the invoice amount in cents for a validly signed test id, else null. */
export async function verifyTestPaymentId(secret: string | undefined, id: string): Promise<number | null> {
  if (!secret) return null
  const m = TEST_ID_RE.exec(id)
  if (!m) return null
  const cents = Number(m[1])
  if (!Number.isInteger(cents) || cents < 1 || cents > TEST_MAX_CENTS) return null
  const expected = (await hmacHex(secret, `${cents}.${m[2]}`)).slice(0, 16)
  // Constant-time compare over fixed-length hex.
  let diff = 0
  for (let i = 0; i < 16; i++) diff |= expected.charCodeAt(i) ^ m[3].charCodeAt(i)
  return diff === 0 ? cents : null
}

export const TEST_MERCHANT_NAME = 'Rozo Test Invoice'
