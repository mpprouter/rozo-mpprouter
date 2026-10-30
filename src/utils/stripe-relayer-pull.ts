// Stripe Crypto settlement on Base, seen from the chain.
//
// pay-invoice signs an EIP-2612 Permit for the exact invoice amount and
// Stripe's relayer EOA calls Stripe's payin contract, which moves that amount
// out of the funder a few blocks after the intents payout landed. Stripe only
// executes that pull for a session it is fulfilling, so a USDC Transfer of the
// exact invoice amount, from the funder, inside a transaction sent by that
// relayer to that contract, is Stripe's own confirmation of the payin, and it
// stays readable long after `resume_payin_session` starts answering 410.
//
// Binding to one invoice (there is no session id in the calldata we can read):
// the pull must come after the payout (block, then log index) and be the only
// exact-amount relayer pull in the window, and the funder must not have
// received another payout of about the same size within the window on either
// side (that would be a same-amount sibling invoice whose pull this could be).
// All of it is read from the chain; record timestamps are never used.
import { FALLBACK_BASE_RPCS } from './base-usdc-balance'

export const STRIPE_RELAYER = '0x75d22dd531d9bfd3da6293eb5ddac8f351f21240'
export const STRIPE_PAYIN_CONTRACT = '0x7cf479c72cec073b3759aed9aa00508dea2e480e'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// Stripe pulled within 6 blocks on every settlement checked on 2026-10-30; 300
// blocks (~10 min) also covers the router's ambiguous-retry grace. Public Base
// RPCs cap eth_getLogs at 50 blocks per call.
export const STRIPE_PULL_WINDOW_BLOCKS = 300
export const STRIPE_PULL_CHUNK_BLOCKS = 50
// Another inbound transfer to the funder within this tolerance of the payout
// amount, in the window around the payout, means a sibling order of about the
// same size was paid out next to this one: not attributable.
export const SIBLING_PAYOUT_TOLERANCE_BPS = 200n

export function parseAtomic(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d{1,30}$/.test(v)) return null
  const n = BigInt(v)
  return n > 0n ? n : null
}

export type JsonRpc = (method: string, params: unknown[]) => Promise<unknown>

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

/** JSON-RPC over the operator RPC first, then the public list; first endpoint that answers without an error wins. */
export function makeBaseRpc(primaryRpcUrl?: string, fetchImpl: typeof fetch = fetch): JsonRpc {
  const candidates = primaryRpcUrl ? [primaryRpcUrl, ...FALLBACK_BASE_RPCS] : FALLBACK_BASE_RPCS
  return async (method, params) => {
    let lastError: unknown = null
    for (const url of candidates) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) { lastError = new Error(`http ${res.status}`); continue }
        const body = (await res.json()) as { result?: unknown; error?: unknown }
        if (body.error) { lastError = body.error; continue }
        return body.result
      } catch (err) {
        lastError = err
      }
    }
    throw new Error(`base rpc failed: ${String(lastError).slice(0, 120)}`)
  }
}

type Log = { address?: string; topics?: string[]; data?: string; blockNumber?: string; logIndex?: string; transactionHash?: string }

const hexInt = (v: unknown): number => (typeof v === 'string' ? parseInt(v, 16) || 0 : 0)
const hexBig = (v: unknown): bigint => { try { return typeof v === 'string' ? BigInt(v) : 0n } catch { return 0n } }

/**
 * Tx hash of Stripe's relayer pulling exactly `amountAtomic` USDC from the
 * funder after the intents payout `payoutTxHash`, or null when there is no
 * such pull, more than one candidate, or anything could not be read. Never
 * throws: a null just leaves the record for the next sweep.
 */
export async function findStripeRelayerPull(
  rpc: JsonRpc,
  payoutTxHash: string,
  amountAtomic: bigint,
): Promise<string | null> {
  try {
    if (amountAtomic <= 0n || !TX_HASH_RE.test(payoutTxHash)) return null
    const receipt = (await rpc('eth_getTransactionReceipt', [payoutTxHash])) as { status?: string; blockNumber?: string; logs?: Log[] } | null
    if (!receipt || hexInt(receipt.status) !== 1) return null
    const payoutLogs = (receipt.logs ?? []).filter(
      (l) => (l.address ?? '').toLowerCase() === BASE_USDC && l.topics?.[0] === ERC20_TRANSFER_TOPIC,
    )
    // The funder is whoever the payout delivered USDC to; the record does not
    // need to know it, the receipt says.
    const receivers = new Set(payoutLogs.map((l) => '0x' + (l.topics?.[2] ?? '').slice(-40).toLowerCase()))
    if (receivers.size !== 1) return null
    const funder = [...receivers][0]
    if (!/^0x[0-9a-f]{40}$/.test(funder)) return null
    const start = hexInt(receipt.blockNumber)
    const payoutIndex = Math.max(...payoutLogs.map((l) => hexInt(l.logIndex)))
    const payoutAmount = payoutLogs.reduce((acc, l) => acc + hexBig(l.data), 0n)
    const funderTopic = '0x' + funder.slice(2).padStart(64, '0')
    const getLogs = async (from: number, to: number, topics: (string | null)[]) =>
      ((await rpc('eth_getLogs', [{ address: BASE_USDC, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics }])) ?? []) as Log[]
    // Sibling check: any other inbound transfer to the funder of about the
    // payout amount in [start - W, start + W] makes this pull unattributable.
    const tolerance = (payoutAmount * SIBLING_PAYOUT_TOLERANCE_BPS) / 10_000n
    for (let from = Math.max(0, start - STRIPE_PULL_WINDOW_BLOCKS); from <= start + STRIPE_PULL_WINDOW_BLOCKS; from += STRIPE_PULL_CHUNK_BLOCKS) {
      const to = Math.min(from + STRIPE_PULL_CHUNK_BLOCKS - 1, start + STRIPE_PULL_WINDOW_BLOCKS)
      for (const log of await getLogs(from, to, [ERC20_TRANSFER_TOPIC, null, funderTopic])) {
        if ((log.transactionHash ?? '').toLowerCase() === payoutTxHash.toLowerCase()) continue
        const diff = hexBig(log.data) - payoutAmount
        if ((diff < 0n ? -diff : diff) <= tolerance) return null
      }
    }
    const topics = [ERC20_TRANSFER_TOPIC, funderTopic]
    const pulls = new Set<string>()
    for (let from = start; from < start + STRIPE_PULL_WINDOW_BLOCKS; from += STRIPE_PULL_CHUNK_BLOCKS) {
      const to = Math.min(from + STRIPE_PULL_CHUNK_BLOCKS - 1, start + STRIPE_PULL_WINDOW_BLOCKS)
      const logs = await getLogs(from, to, topics)
      for (const log of logs) {
        const hash = log.transactionHash ?? ''
        if (hexBig(log.data) !== amountAtomic || pulls.has(hash) || !TX_HASH_RE.test(hash)) continue
        if (hexInt(log.blockNumber) === start && hexInt(log.logIndex) <= payoutIndex) continue // before the payout
        const tx = ((await rpc('eth_getTransactionByHash', [hash])) ?? {}) as { from?: string; to?: string }
        if ((tx.from ?? '').toLowerCase() === STRIPE_RELAYER && (tx.to ?? '').toLowerCase() === STRIPE_PAYIN_CONTRACT) pulls.add(hash)
      }
    }
    return pulls.size === 1 ? [...pulls][0] : null
  } catch {
    return null
  }
}
