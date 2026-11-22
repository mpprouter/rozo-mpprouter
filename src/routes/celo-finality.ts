// Celo (source chain 42220) settlement gate.
//
// Why: Celo is an OP Stack L2. Its unsafe blocks (~1 s) can be reorged away,
// and finalized lags by ~25 minutes. rozo-intents used to credit a Celo payin
// after 1 block, and this router pays the Coinbase invoice from the funder as
// soon as `payment_payin_completed` arrives (optimistic path), so a reorged
// payin could still be paid for. Design: ainative
// docs/design/20261122-celo-stablecoins-payin-implementation.zh.md §2.3, §4 P2,
// §9 (pause switch and S1 rollback protocol).
//
// Rule: before ANY funder payment for an order whose source chain is 42220
// (webhook, checkout backlog replay, manual /admin/pay-invoice, Bitrefill and
// Stripe settlement), this router checks the payin itself and does not trust
// rozo-intents for it:
//   1. CELO_FULFILLMENT_PAUSED must be exactly "off" (missing / anything else
//      pauses: fail closed);
//   2. the payin tx receipt, read from two independent RPCs (forno.celo.org
//      and CELO_RPC_URL), succeeded, is in the same block on both, and carries
//      a Transfer of the order's source token to the order's receive address
//      for at least the order's source amount (no tolerance);
//   3. both RPCs report a finalized block at or above the payin block, and the
//      canonical block at that height has the receipt's block hash on both.
// Any read failure, missing finalized tag or mismatch = not paid; the caller
// keeps the event and defers. A block-hash disagreement also alerts.
//
// Orders from every other source chain are untouched: the gate answers
// `applies: false` without any network read.

export const CELO_CHAIN_ID = '42220'
export const CELO_FORNO_RPC = 'https://forno.celo.org'

/** Celo ERC-20 sources this gate accepts (both 6 decimals). Lowercase. */
export const CELO_TOKENS: Readonly<Record<'USDT' | 'USDC', string>> = {
  USDT: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
  USDC: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
}
const CELO_TOKEN_DECIMALS = 6
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const CELO_RPC_TIMEOUT_MS = 5_000

export interface CeloGateEnv {
  CELO_FULFILLMENT_PAUSED?: string
  CELO_RPC_URL?: string
}

/** Fail closed: only the exact value "off" means not paused. */
export function celoFulfillmentPaused(env: CeloGateEnv): boolean {
  return env.CELO_FULFILLMENT_PAUSED !== 'off'
}

/** True for any spelling of Celo mainnet a payload may carry. */
export function isCeloChain(v: unknown): boolean {
  if (v === undefined || v === null) return false
  const s = String(v).trim().toLowerCase()
  return s === CELO_CHAIN_ID || s === `eip155:${CELO_CHAIN_ID}` || s === '0xa4ec' || s === 'celo'
}

/** Source chain of a Rozo order row, in either spelling the API returns. */
export function orderSourceChain(order: any): unknown {
  return order?.source?.chainId ?? order?.source_chain_id ?? null
}

export type CeloGateResult =
  | { applies: false }
  | { applies: true; ok: true; txHash: string; blockNumber: string; blockHash: string }
  // `alert`: a block-hash or chain disagreement worth a human look (a reorg,
  // a lying RPC, or an order/event mismatch). Plain "not finalized yet" or a
  // read failure does not alert.
  | { applies: true; ok: false; reason: string; alert: boolean }

export interface CeloGateInput {
  /** Every source-chain id known for this order (event payload, record, order). */
  chainHints: unknown[]
  /** The Rozo order if the caller already read it. */
  order?: any | null
  /** Reads the Rozo order when `order` is not given (only called for Celo). */
  loadOrder?: () => Promise<any | null>
  /** source.txHash from the webhook / record, cross-checked with the order's. */
  eventTxHash?: string | null
}

export interface CeloGateDeps {
  fetch?: typeof fetch
}

/**
 * Decides whether a funder payment may go out for this order. `applies:false`
 * means the order is not Celo-sourced and the caller proceeds unchanged.
 */
export async function celoSettlementGate(
  env: CeloGateEnv,
  input: CeloGateInput,
  deps: CeloGateDeps = {},
): Promise<CeloGateResult> {
  let order = input.order ?? null
  const hints = [...input.chainHints, orderSourceChain(order)]
  // No source chain known at all (a caller that carries none, e.g. the Stripe
  // ambiguous retry): the Rozo order is the authority. Read it before deciding
  // whether the gate applies; unreadable = refuse (the chain is unknown).
  const known = hints.some((h) => h !== undefined && h !== null && String(h).trim() !== '')
  if (!known && !order && input.loadOrder) {
    try {
      order = await input.loadOrder()
    } catch {
      order = null
    }
    if (!order || typeof order !== 'object') {
      return { applies: true, ok: false, reason: 'source chain unknown: Rozo order unreadable', alert: false }
    }
    hints.push(orderSourceChain(order))
  }
  if (!hints.some(isCeloChain)) return { applies: false }

  if (celoFulfillmentPaused(env)) {
    return { applies: true, ok: false, reason: 'celo_fulfillment_paused', alert: false }
  }

  if (!order && input.loadOrder) {
    try {
      order = await input.loadOrder()
    } catch {
      order = null
    }
  }
  if (!order || typeof order !== 'object') {
    return { applies: true, ok: false, reason: 'Rozo order unreadable', alert: false }
  }
  if (!isCeloChain(orderSourceChain(order))) {
    return { applies: true, ok: false, reason: 'Rozo order source chain is not Celo but the event says Celo', alert: true }
  }

  const terms = celoPayinTerms(order, input.eventTxHash ?? null)
  if (!terms.ok) return { applies: true, ok: false, reason: terms.reason, alert: terms.alert }

  const v = await verifyCeloPayinFinalized(env, terms, deps)
  if (!v.ok) return { applies: true, ok: false, reason: v.reason, alert: v.alert }
  return { applies: true, ok: true, txHash: terms.txHash, blockNumber: v.blockNumber, blockHash: v.blockHash }
}

export interface CeloPayinTerms {
  ok: true
  txHash: string
  token: string
  receivers: string[]
  amountAtomic: bigint
}

const HEX_TX_RE = /^0x[0-9a-fA-F]{64}$/
const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/** What the payin must look like on chain, from the Rozo order only. */
export function celoPayinTerms(
  order: any,
  eventTxHash: string | null,
): CeloPayinTerms | { ok: false; reason: string; alert: boolean } {
  const source = order?.source ?? {}
  const orderTx = typeof source.txHash === 'string' && source.txHash ? source.txHash : null
  const evTx = typeof eventTxHash === 'string' && eventTxHash ? eventTxHash : null
  if (orderTx && evTx && orderTx.toLowerCase() !== evTx.toLowerCase()) {
    return { ok: false, reason: 'payin tx hash differs between the event and the Rozo order', alert: true }
  }
  const txHash = orderTx ?? evTx
  if (!txHash || !HEX_TX_RE.test(txHash)) {
    return { ok: false, reason: 'payin tx hash missing or malformed', alert: false }
  }

  const symbol: string = typeof source.tokenSymbol === 'string' ? source.tokenSymbol.trim().toUpperCase() : ''
  const bySymbol = symbol === 'USDT' || symbol === 'USDC' ? CELO_TOKENS[symbol] : null
  const addr = typeof source.tokenAddress === 'string' ? source.tokenAddress.trim().toLowerCase() : ''
  const allowed = new Set(Object.values(CELO_TOKENS))
  if (addr && !allowed.has(addr)) {
    return { ok: false, reason: 'order source token is not Celo USDT or USDC', alert: true }
  }
  if (addr && bySymbol && addr !== bySymbol) {
    return { ok: false, reason: 'order source token address and symbol disagree', alert: true }
  }
  const token = addr || bySymbol
  if (!token) return { ok: false, reason: 'order source token unknown', alert: false }

  const receivers = [source.receiverAddress, source.receiverAddressContract]
    .filter((a): a is string => typeof a === 'string' && HEX_ADDR_RE.test(a.trim()))
    .map((a) => a.trim().toLowerCase())
  if (receivers.length === 0) return { ok: false, reason: 'order receive address missing', alert: false }

  const amountAtomic = parseTokenAtomic(source.amount, CELO_TOKEN_DECIMALS)
  if (amountAtomic === null || amountAtomic <= 0n) {
    return { ok: false, reason: 'order source amount unreadable', alert: false }
  }
  return { ok: true, txHash, token, receivers, amountAtomic }
}

/** Exact decimal → atomic units; null on malformed or excess precision. */
export function parseTokenAtomic(v: unknown, decimals: number): bigint | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > decimals) {
    // Trailing zeros beyond the token precision are harmless; anything else is not.
    if (!/^0*$/.test(frac.slice(decimals))) return null
  }
  const fracPadded = (frac.slice(0, decimals) + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')
}

type RpcOutcome = { ok: true; result: any } | { ok: false }

async function rpc(url: string, method: string, params: unknown[], f: typeof fetch): Promise<RpcOutcome> {
  try {
    const r = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(CELO_RPC_TIMEOUT_MS),
    })
    if (!r.ok) return { ok: false }
    const body: any = await r.json()
    if (!body || typeof body !== 'object' || body.error || !('result' in body)) return { ok: false }
    return { ok: true, result: body.result }
  } catch {
    return { ok: false }
  }
}

function hexToBig(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) return null
  try {
    return BigInt(v)
  } catch {
    return null
  }
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** True when the receipt carries a qualifying Transfer log. */
export function receiptHasTransfer(receipt: any, terms: Pick<CeloPayinTerms, 'token' | 'receivers' | 'amountAtomic'>): boolean {
  const logs: any[] = Array.isArray(receipt?.logs) ? receipt.logs : []
  for (const log of logs) {
    if (!log || log.removed === true) continue
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== terms.token) continue
    const topics: any[] = Array.isArray(log.topics) ? log.topics : []
    if (topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue
    const to = String(topics[2]).toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(to) || !/^0x0{24}/.test(to)) continue
    if (!terms.receivers.includes(`0x${to.slice(26)}`)) continue
    const value = hexToBig(log.data)
    if (value !== null && value >= terms.amountAtomic) return true
  }
  return false
}

/**
 * Two-RPC finality proof for one Celo payin. Never throws.
 */
export async function verifyCeloPayinFinalized(
  env: CeloGateEnv,
  terms: CeloPayinTerms,
  deps: CeloGateDeps = {},
): Promise<{ ok: true; blockNumber: string; blockHash: string } | { ok: false; reason: string; alert: boolean }> {
  const f = deps.fetch ?? fetch
  const second = typeof env.CELO_RPC_URL === 'string' ? env.CELO_RPC_URL.trim() : ''
  if (!second) return { ok: false, reason: 'second Celo RPC (CELO_RPC_URL) not configured', alert: false }
  const h1 = hostOf(CELO_FORNO_RPC)
  const h2 = hostOf(second)
  if (!h2 || h2 === h1) return { ok: false, reason: 'CELO_RPC_URL is not an independent RPC', alert: false }
  const urls = [CELO_FORNO_RPC, second]

  // 1. Receipt on both RPCs: success, same block, qualifying Transfer.
  let blockNumber: bigint | null = null
  let blockHash: string | null = null
  for (const [i, url] of urls.entries()) {
    const r = await rpc(url, 'eth_getTransactionReceipt', [terms.txHash], f)
    if (!r.ok) return { ok: false, reason: `Celo receipt unreadable (rpc ${i + 1})`, alert: false }
    const receipt = r.result
    if (!receipt || typeof receipt !== 'object') {
      return { ok: false, reason: `Celo receipt not found (rpc ${i + 1})`, alert: false }
    }
    if (typeof receipt.transactionHash === 'string' && receipt.transactionHash.toLowerCase() !== terms.txHash.toLowerCase()) {
      return { ok: false, reason: `Celo receipt is for another tx (rpc ${i + 1})`, alert: true }
    }
    if (receipt.status !== '0x1') return { ok: false, reason: `Celo payin tx did not succeed (rpc ${i + 1})`, alert: false }
    const n = hexToBig(receipt.blockNumber)
    const h = typeof receipt.blockHash === 'string' ? receipt.blockHash.toLowerCase() : null
    if (n === null || !h || !/^0x[0-9a-f]{64}$/.test(h)) {
      return { ok: false, reason: `Celo receipt block unreadable (rpc ${i + 1})`, alert: false }
    }
    if (blockNumber === null) {
      blockNumber = n
      blockHash = h
    } else if (n !== blockNumber || h !== blockHash) {
      return { ok: false, reason: 'Celo receipt block differs between the two RPCs', alert: true }
    }
    if (!receiptHasTransfer(receipt, terms)) {
      return {
        ok: false,
        reason: `Celo payin has no Transfer of the order token to the order address for the order amount (rpc ${i + 1})`,
        alert: true,
      }
    }
  }
  if (blockNumber === null || blockHash === null) return { ok: false, reason: 'Celo receipt unreadable', alert: false }

  // 2. Finalized head at or above the payin block, on both RPCs.
  for (const [i, url] of urls.entries()) {
    const r = await rpc(url, 'eth_getBlockByNumber', ['finalized', false], f)
    if (!r.ok || !r.result) return { ok: false, reason: `Celo finalized block unreadable (rpc ${i + 1})`, alert: false }
    const fin = hexToBig(r.result.number)
    if (fin === null) return { ok: false, reason: `Celo finalized block unreadable (rpc ${i + 1})`, alert: false }
    if (fin < blockNumber) {
      return { ok: false, reason: `Celo payin block not finalized yet (rpc ${i + 1})`, alert: false }
    }
  }

  // 3. The canonical block at that height is the receipt's block, on both.
  const tag = `0x${blockNumber.toString(16)}`
  for (const [i, url] of urls.entries()) {
    const r = await rpc(url, 'eth_getBlockByNumber', [tag, false], f)
    if (!r.ok || !r.result) return { ok: false, reason: `Celo payin block unreadable (rpc ${i + 1})`, alert: false }
    const h = typeof r.result.hash === 'string' ? r.result.hash.toLowerCase() : null
    if (!h) return { ok: false, reason: `Celo payin block unreadable (rpc ${i + 1})`, alert: false }
    if (h !== blockHash) {
      return { ok: false, reason: `Celo canonical block hash differs from the payin receipt (rpc ${i + 1})`, alert: true }
    }
  }
  return { ok: true, blockNumber: blockNumber.toString(), blockHash }
}

/** One-line alert body for a Celo gate disagreement. Addresses are masked by the caller's redaction. */
export function celoGateAlertText(ref: string, reason: string): string {
  return [
    '[MPP Router] 🚨 Celo payin NOT paid: finality check disagreement',
    `Invoice: ${ref}`,
    `Reason: ${reason}`,
    `At: ${new Date().toISOString()}`,
    'Nothing was paid. Check the payin on Celo by hand (reorg or RPC disagreement). Do not pay this invoice by hand until the payin block is finalized with the same hash on two RPCs.',
  ].join('\n')
}
