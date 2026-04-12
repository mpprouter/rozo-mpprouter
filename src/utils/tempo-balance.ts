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
 * Fetch the USDC.e balance (6 decimals) for `address` on Tempo.
 * Returns base-unit bigint, or null on failure.
 */
export async function getTempoUsdcBalance(
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
