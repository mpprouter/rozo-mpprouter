/**
 * Base mainnet USDC balance check via eth_call → USDC.balanceOf(address).
 * Returns the balance in base units (6 decimals) as bigint, or null on
 * RPC failure. No private key needed — read-only.
 */

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Public fallback Base RPCs. Cloudflare Workers can't always reach
// `mainnet.base.org` reliably from their egress IPs (rate-limited or
// blocked by Coinbase's own RPC), so we try several. Order matters —
// fastest/most reliable first.
const FALLBACK_BASE_RPCS = [
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://base.drpc.org',
  'https://mainnet.base.org',
]

export interface BaseUsdcBalanceResult {
  balance: bigint | null
  rpcsTried: Array<{ url: string; ok: boolean; reason?: string }>
}

// `primaryRpcUrl` is the operator-provided (paid) Base RPC, typically
// Alchemy. Tried first; on any failure we fall through to the public
// list. `redactRpcUrl` keeps API keys out of logs.
function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.pathname.length > 1) {
      return `${u.protocol}//${u.host}/<redacted>`
    }
    return `${u.protocol}//${u.host}`
  } catch {
    return '<invalid-url>'
  }
}

export async function getBaseUsdcBalance(
  address: string,
  primaryRpcUrl?: string,
): Promise<BaseUsdcBalanceResult> {
  const data =
    '0x70a08231' +
    address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const rpcsTried: BaseUsdcBalanceResult['rpcsTried'] = []

  const candidates = primaryRpcUrl
    ? [primaryRpcUrl, ...FALLBACK_BASE_RPCS]
    : FALLBACK_BASE_RPCS

  for (const rpcUrl of candidates) {
    const safeUrl = redactRpcUrl(rpcUrl)
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: BASE_USDC, data }, 'latest'],
        }),
      })
      if (!res.ok) {
        rpcsTried.push({ url: safeUrl, ok: false, reason: `HTTP ${res.status}` })
        continue
      }
      const json = (await res.json()) as { result?: string; error?: unknown }
      if (json.result && json.result !== '0x') {
        rpcsTried.push({ url: safeUrl, ok: true })
        return { balance: BigInt(json.result), rpcsTried }
      }
      rpcsTried.push({
        url: safeUrl,
        ok: false,
        reason: json.error ? `rpc error: ${JSON.stringify(json.error).slice(0, 100)}` : 'no result',
      })
    } catch (err: any) {
      rpcsTried.push({
        url: safeUrl,
        ok: false,
        reason: `fetch threw: ${err?.message ?? String(err)}`.slice(0, 200),
      })
    }
  }
  return { balance: null, rpcsTried }
}
