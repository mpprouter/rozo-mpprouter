// Native coin sources (ETH / BNB / SOL) for the Coinbase checkout line, and
// the internal test payment id used to exercise it with small amounts.
//
// Founder 2026-09-27: native checkout is for merchant_openrouter (the appId
// every Coinbase order is created under). rozo-intents-api is the final gate
// (NATIVE_PAYIN_MERCHANTS); this Worker only rejects early and decides which
// coins the checkout offers. Chains open one at a time through the
// NATIVE_SOURCES var, e.g. "ETH@8453,ETH@1,BNB@56,SOL@900". Unset = none.

export type NativeSymbol = 'ETH' | 'BNB' | 'SOL'

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


export const NATIVE_SOURCE_DEFS: Record<string, { symbol: NativeSymbol; tokenAddress: string }> = {
  '8453': { symbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' },
  '1': { symbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' },
  // Arbitrum ETH (founder 2026-10-06). Live gate: rozotest order ae7a060d.
  '42161': { symbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' },
  '56': { symbol: 'BNB', tokenAddress: '0x0000000000000000000000000000000000000000' },
  '900': { symbol: 'SOL', tokenAddress: 'native' },
}

export const ALL_NATIVE_SOURCES: ReadonlySet<string> = new Set(
  Object.entries(NATIVE_SOURCE_DEFS).map(([chainId, d]) => `${d.symbol}@${chainId}`),
)

/** Parse the NATIVE_SOURCES var into "SYMBOL@chainId" keys we actually support. */
export function parseNativeSources(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const key = part.trim().toUpperCase()
    if (ALL_NATIVE_SOURCES.has(key)) out.add(key)
  }
  return out
}

export function nativeSourceFor(
  chainId: string,
  tokenSymbol: string,
  allowed: ReadonlySet<string>,
): { symbol: NativeSymbol; tokenAddress: string } | null {
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
