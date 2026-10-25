// On-chain proof that the funder wallet paid a Coinbase invoice: a Base USDC
// Transfer from `from` of exactly `amountAtomic` in [startMs, startMs + windowMs].
// Read-only (eth_blockNumber / eth_getBlockByNumber / eth_getLogs).
// Returns true only for exactly one such transfer; false otherwise, or null when no RPC answered (unknown, never "no").

import { FALLBACK_BASE_RPCS, redactRpcUrl } from './base-usdc-balance'

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// Base produces a block every 2 seconds.
const BLOCK_MS = 2000
// Slack around the estimated start block for timestamp drift.
const BLOCK_SLACK = 60

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: unknown }
  if (json.error || json.result === undefined) throw new Error('rpc error')
  return json.result
}

const hex = (n: number) => '0x' + n.toString(16)

export async function funderTransferExists(
  from: string,
  amountAtomic: bigint,
  startMs: number,
  windowMs: number,
  primaryRpcUrl?: string,
): Promise<boolean | null> {
  const candidates = primaryRpcUrl ? [primaryRpcUrl, ...FALLBACK_BASE_RPCS] : FALLBACK_BASE_RPCS
  const fromTopic = '0x' + from.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  for (const url of candidates) {
    try {
      const head = await rpc(url, 'eth_getBlockByNumber', ['latest', false])
      const headNum = Number(head.number)
      const headMs = Number(head.timestamp) * 1000
      const startBlock = Math.max(0, headNum - Math.ceil((headMs - startMs) / BLOCK_MS) - BLOCK_SLACK)
      // Block numbers are estimates; check each match's real block time below.
      const endBlock = Math.min(headNum, startBlock + Math.ceil(windowMs / BLOCK_MS) + 2 * BLOCK_SLACK)
      if (endBlock < startBlock) return false
      const logs = (await rpc(url, 'eth_getLogs', [
        { address: BASE_USDC, fromBlock: hex(startBlock), toBlock: hex(endBlock), topics: [TRANSFER_TOPIC, fromTopic] },
      ])) as Array<{ data: string; blockNumber: string }>
      // Exactly one match: two same-amount transfers in the window cannot be
      // told apart (shared funder, same-priced invoices), so treat as no proof.
      let matches = 0
      for (const l of logs) {
        if (BigInt(l.data) !== amountAtomic) continue
        const blk = await rpc(url, 'eth_getBlockByNumber', [l.blockNumber, false])
        const t = Number(blk.timestamp) * 1000
        if (t >= startMs && t <= startMs + windowMs) matches++
      }
      return matches === 1
    } catch (e) {
      console.warn(`[funder-transfer] ${redactRpcUrl(url)} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return null
}
