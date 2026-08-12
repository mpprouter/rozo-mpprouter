/**
 * Tempo L2 wallet USDC balance check.
 *
 * Queries the Router's Tempo pool address for its USDC.e balance
 * using the same approach as scripts/admin/inspect-channels.ts:
 * first tries `tempo_getBalance`, then falls back to ERC-20
 * `balanceOf` via `eth_call`.
 *
 * Returns the balance in base units (6 decimals) as a bigint,
 * or null if the query fails (network error, unsupported method).
 */

/**
 * Tempo USDC asset handle — the ERC-20-compatible token contract
 * for USDC on Tempo L2. Same constant used in inspect-channels.ts.
 */
const TEMPO_USDC_HANDLE = '0x20c000000000000000000000b9537d11c60e8b50'

/**
 * How long a pool balance reading is reused.
 *
 * This is a pre-flight guard, not an accounting read — it exists to stop us
 * accepting a payment we can't forward, and to alert when the pool runs low.
 * Running it uncached meant one extra RPC round trip on *every* proxied
 * request, on top of the 3 the merchant payment itself makes, which is a
 * large share of the connection volume that got us rate-limited.
 *
 * The tradeoff of caching: for up to `BALANCE_CACHE_MS` we may accept a
 * request against a balance that has since dropped. That is bounded and
 * small — per-request merchant quotes are fractions of a cent against a
 * 5 USDC alert threshold, so a couple of seconds of drift cannot take the
 * pool from "healthy" to "overdrawn". A failed forward is refunded by the
 * caller either way.
 */
const BALANCE_CACHE_MS = 3_000

type BalanceEntry = { value: bigint | null; expiresAt: number }

const balanceCache = new Map<string, BalanceEntry>()
const balanceInFlight = new Map<string, Promise<bigint | null>>()

/**
 * Fetch the USDC.e balance (6 decimals) for `address` on Tempo.
 * Returns base-unit bigint, or null on failure.
 *
 * Cached for `BALANCE_CACHE_MS`, and concurrent callers share a single
 * upstream request. Failures (`null`) are cached too — otherwise an RPC
 * outage turns into a retry storm against the endpoint that is already
 * refusing us.
 */
export async function getTempoUsdcBalance(
  rpcUrl: string,
  address: string,
): Promise<bigint | null> {
  const key = `${rpcUrl}|${address}`

  const cached = balanceCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const existing = balanceInFlight.get(key)
  if (existing) return existing

  const pending = fetchTempoUsdcBalance(rpcUrl, address)
    .then((value) => {
      balanceCache.set(key, { value, expiresAt: Date.now() + BALANCE_CACHE_MS })
      return value
    })
    .finally(() => {
      balanceInFlight.delete(key)
    })

  balanceInFlight.set(key, pending)
  return pending
}

/** Test seam: drop cached balances. Not used in production code. */
export function resetTempoBalanceCache(): void {
  balanceCache.clear()
  balanceInFlight.clear()
}

/**
 * Uncached read. Kept as a separate function so the caching wrapper above
 * stays trivially auditable.
 */
async function fetchTempoUsdcBalance(
  rpcUrl: string,
  address: string,
): Promise<bigint | null> {
  // Try tempo_getBalance first (native Tempo RPC)
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tempo_getBalance',
        params: [address, TEMPO_USDC_HANDLE],
      }),
    })
    if (res.ok) {
      const json = (await res.json()) as { result?: string; error?: any }
      if (json.result) return BigInt(json.result)
    }
  } catch {
    // fall through to eth_call
  }

  // Fallback: ERC-20 balanceOf via eth_call
  try {
    const data =
      '0x70a08231' +
      address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_call',
        params: [{ to: TEMPO_USDC_HANDLE, data }, 'latest'],
      }),
    })
    if (res.ok) {
      const json = (await res.json()) as { result?: string }
      if (json.result && json.result !== '0x') {
        return BigInt(json.result)
      }
    }
  } catch {
    // both methods failed
  }

  return null
}

/** 5 USDC in base units (6 decimals) */
export const LOW_BALANCE_THRESHOLD = 5_000_000n
