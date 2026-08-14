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

import { parseRpcUrls } from '../mpp/tempo-rpc'

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
  primaryRpcUrl?: string,
): Promise<bigint | null> {
  const key = `${primaryRpcUrl ?? ''}|${rpcUrl}|${address}`

  const cached = balanceCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const existing = balanceInFlight.get(key)
  if (existing) return existing

  const pending = fetchTempoUsdcBalance(rpcUrl, address, primaryRpcUrl)
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
  primaryRpcUrl?: string,
): Promise<bigint | null> {
  // `rpcUrl` is a comma-separated POOL, not a single endpoint (see
  // tempo-rpc.ts). This function used to hand it to `fetch()` verbatim,
  // which made the whole pre-flight dead from the moment the pool landed
  // (958c56d, 2026-08-12): "https://a,https://b" is not a URL, both
  // branches threw, and every call returned null. Null is indistinguishable
  // from "RPC down" to the caller, so it silently skipped BOTH the
  // low-balance DingTalk alert and the insufficient-funds rejection —
  // turning a clean 503 into a 502 at the merchant-payment step.
  // Primary first. Note it is split by hand rather than via `parseRpcUrls`,
  // which substitutes the public default for empty input — correct for the
  // fallback pool, wrong here, where "unset" must mean "no primary tier".
  const primary = (primaryRpcUrl ?? '').split(',').map((u) => u.trim()).filter(Boolean)
  const urls = [...primary, ...parseRpcUrls(rpcUrl).filter((u) => !primary.includes(u))]

  const data =
    '0x70a08231' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')

  // Two methods, tried per endpoint. `tempo_getBalance` is the native call
  // but is NOT enabled on every provider (verified 2026-08-14: both
  // rpc.tempo.xyz and the dRPC endpoint answer -32601 method-not-available),
  // so the eth_call path is what actually returns a number today. Keeping
  // both means a provider that re-enables the native method still works.
  const bodies = [
    { jsonrpc: '2.0', id: 1, method: 'tempo_getBalance', params: [address, TEMPO_USDC_HANDLE] },
    { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: TEMPO_USDC_HANDLE, data }, 'latest'] },
  ]

  for (const url of urls) {
    for (const body of bodies) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) continue
        const json = (await res.json()) as { result?: string; error?: unknown }
        if (json.result && json.result !== '0x') return BigInt(json.result)
      } catch {
        // try the next method, then the next endpoint
      }
    }
  }

  return null
}

/** 5 USDC in base units (6 decimals) */
export const LOW_BALANCE_THRESHOLD = 5_000_000n
