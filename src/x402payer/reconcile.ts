/**
 * x402 payer background jobs (Base leg), run from the Worker cron:
 *
 * 1. Authorization checks (every 10 min). For each Base credential the ledger
 *    lists as past valid_before, read USDC.authorizationState(funder, nonce)
 *    and report it. used -> the ledger marks it settled; unused -> the ledger
 *    stamps the check, and pg_cron 'x402-refund-expired' (Intents DB) returns
 *    the debit. Nothing here refunds. A failed RPC read reports nothing, so an
 *    unknown state can never turn into a refund.
 * 2. Reversed top-ups (every 10 min). Each reversal_needed binding is alerted
 *    once through utils/alert.ts and then acknowledged in the ledger. Only a
 *    confirmed delivery is acknowledged; otherwise the next tick retries.
 * 3. Liability reconciliation (hourly). Base funder USDC on chain vs the
 *    ledger's base_liability_usd (all balances + signed, unsettled Base
 *    credentials). The funder is shared with checkout, so only a SHORTFALL
 *    (liability above the funder balance) by more than
 *    app_config X402_RECON_TOLERANCE_USD is alerted, on the transition into
 *    shortfall and again at most once a day while it persists.
 *
 * Every job swallows its own errors: it must not take the shared cron down.
 */

import { encodeFunctionData, decodeFunctionResult, type Hex } from 'viem'
import { alertSinkConfigured, sendAlert, type AlertEnv } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'
import { FALLBACK_BASE_RPCS, getBaseUsdcBalance, redactRpcUrl } from '../utils/base-usdc-balance'
import type { OpsReport, X402Ledger } from './ledger'
import { BASE_USDC } from './requirements'

const OPS_LAST_RUN_KEY = 'x402payer:ops:last-slot'
const RECON_LAST_RUN_KEY = 'x402payer:reconcile:last-hour'
const RECON_STATE_KEY = 'x402payer:reconcile:state'
const OPS_SLOT_MS = 10 * 60_000
const RECON_REALERT_MS = 24 * 3_600_000

const AUTHORIZATION_STATE_ABI = [{
  type: 'function',
  name: 'authorizationState',
  stateMutability: 'view',
  inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const

export interface X402JobsDeps {
  kv: KVNamespace
  ledger: X402Ledger | null
  alertEnv: AlertEnv
  /** Paid Base RPC (BASE_RPC_URL), tried before the public fallbacks. */
  baseRpcUrl?: string
  /** Base funder address (FUNDER_WALLET). */
  funder: string
  nowMs?: number
  fetchImpl?: typeof fetch
  readFunderBalance?: typeof getBaseUsdcBalance
  send?: (env: AlertEnv, content: ReturnType<typeof redactForAlert>) => Promise<boolean>
}

export const RPC_TIMEOUT_MS = 5_000

export interface AuthorizationObservation {
  used: boolean
  blockNumber: number
  blockTimestamp: number
}

/** One JSON-RPC call with a hard deadline (request and body). */
async function rpcCall(fetchImpl: typeof fetch, url: string, method: string, params: unknown[], timeoutMs: number): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { result?: unknown; error?: unknown }
    if (json.result === undefined || json.result === null) throw new Error('no result')
    return json.result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * USDC.authorizationState(authorizer, nonce) read AT Base's FINALIZED block,
 * and only when that block is later than validBefore. Such a read is final:
 * no later block can execute the authorization and a finalized block cannot
 * be reorged. Returns null whenever that cannot be established (finalized
 * block not yet past expiry, RPC failure, bad input): null is never reported,
 * so an unknown state can never become a refund.
 */
export async function readAuthorizationState(
  authorizer: string,
  nonce: string,
  validBeforeUnix: number,
  primaryRpcUrl?: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<AuthorizationObservation | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(authorizer) || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null
  if (!Number.isFinite(validBeforeUnix) || validBeforeUnix <= 0) return null
  const data = encodeFunctionData({
    abi: AUTHORIZATION_STATE_ABI,
    functionName: 'authorizationState',
    args: [authorizer as Hex, nonce as Hex],
  })
  const candidates = primaryRpcUrl ? [primaryRpcUrl, ...FALLBACK_BASE_RPCS] : FALLBACK_BASE_RPCS
  for (const rpcUrl of candidates) {
    try {
      // Block and state from the same endpoint, state pinned to that block.
      const block = await rpcCall(fetchImpl, rpcUrl, 'eth_getBlockByNumber', ['finalized', false], timeoutMs)
      const blockNumber = Number(BigInt(block?.number))
      const blockTimestamp = Number(BigInt(block?.timestamp))
      if (!Number.isFinite(blockNumber) || !Number.isFinite(blockTimestamp)) continue
      if (blockTimestamp <= validBeforeUnix) return null // not final yet; ask again next run
      const result = await rpcCall(fetchImpl, rpcUrl, 'eth_call', [{ to: BASE_USDC, data }, `0x${blockNumber.toString(16)}`], timeoutMs)
      if (typeof result !== 'string' || result === '0x') continue
      const used = decodeFunctionResult({ abi: AUTHORIZATION_STATE_ABI, functionName: 'authorizationState', data: result as Hex })
      return { used, blockNumber, blockTimestamp }
    } catch (err) {
      console.warn(`[x402-ops] authorizationState via ${redactRpcUrl(rpcUrl)} failed: ${(err as Error).message}`)
    }
  }
  return null
}

/** Jobs 1 and 2. Gated to one run per 10-minute slot. */
export async function runX402Ops(deps: X402JobsDeps): Promise<{ ran: boolean; checked?: number; reversalsAlerted?: number }> {
  if (!deps.ledger) return { ran: false }
  const now = deps.nowMs ?? Date.now()
  const slot = String(Math.floor(now / OPS_SLOT_MS))
  if ((await deps.kv.get(OPS_LAST_RUN_KEY)) === slot) return { ran: false }
  await deps.kv.put(OPS_LAST_RUN_KEY, slot, { expirationTtl: 3600 })

  const pending = await deps.ledger.opsPending(50)
  const authorizations: NonNullable<OpsReport['authorizations']> = []
  for (const item of pending.authorization_checks ?? []) {
    const validBefore = Math.floor(Date.parse(item.valid_before) / 1000)
    const seen = await readAuthorizationState(item.funder, item.nonce, validBefore, deps.baseRpcUrl, deps.fetchImpl)
    if (seen) {
      authorizations.push({
        payment_id: item.payment_id,
        used: seen.used,
        block_number: seen.blockNumber,
        block_timestamp: seen.blockTimestamp,
      })
    }
  }

  const send = deps.send ?? sendAlert
  const reversalsAlerted: string[] = []
  if ((pending.reversals ?? []).length > 0) {
    if (!alertSinkConfigured(deps.alertEnv)) {
      console.warn('[x402-ops] reversed top-ups pending but no alert channel configured')
    } else {
      for (const r of pending.reversals) {
        const message =
          `[MPP Router] 🚨 x402 top-up reversed after credit: needs manual review\n` +
          `Top-up order: ${r.payment_id}\n` +
          `x402 account: ${r.account_id}\n` +
          `Credited: $${r.credited_usd ?? '?'} (balance NOT debited automatically)\n` +
          `Reason: ${r.review_reason ?? 'order bounced or refunded'}\n` +
          `Action: check whether the balance was spent, then resolve the x402_topups row.`
        if (await send(deps.alertEnv, redactForAlert(message))) reversalsAlerted.push(r.payment_id)
      }
    }
  }

  if (authorizations.length > 0 || reversalsAlerted.length > 0) {
    await deps.ledger.opsReport({ authorizations, reversals_alerted: reversalsAlerted })
  }
  return { ran: true, checked: authorizations.length, reversalsAlerted: reversalsAlerted.length }
}

/** Job 3. Gated to one run per UTC hour. */
export async function reconcileX402Payer(
  deps: X402JobsDeps,
): Promise<{ ran: boolean; snapshot?: Record<string, unknown>; shortfallUsd?: number; alerted?: boolean }> {
  if (!deps.ledger) return { ran: false }
  const now = deps.nowMs ?? Date.now()
  const hour = String(Math.floor(now / 3_600_000))
  if ((await deps.kv.get(RECON_LAST_RUN_KEY)) === hour) return { ran: false }
  await deps.kv.put(RECON_LAST_RUN_KEY, hour, { expirationTtl: 7200 })

  const snapshot = await deps.ledger.liabilitySnapshot()
  if (snapshot.mode === 'off') return { ran: true, snapshot }

  const liability = Number(snapshot.base_liability_usd ?? NaN)
  const tolerance = Number(snapshot.recon_tolerance_usd ?? 20)
  const read = await (deps.readFunderBalance ?? getBaseUsdcBalance)(deps.funder, deps.baseRpcUrl)
  if (read.balance === null || !Number.isFinite(liability)) {
    // The funder watch (watchFunderBalance) already alerts on unreadable
    // balances; one more page here would be noise.
    console.warn('[x402-reconcile] skipped: funder balance or liability unreadable')
    return { ran: true, snapshot }
  }
  const funderUsd = Number(read.balance) / 1e6
  const shortfall = liability - funderUsd
  const short = shortfall > (Number.isFinite(tolerance) ? tolerance : 20)
  console.log(`[x402-reconcile] liability=${liability.toFixed(2)} funder=${funderUsd.toFixed(2)} shortfall=${shortfall.toFixed(2)} tolerance=${tolerance}`)

  const prevRaw = await deps.kv.get(RECON_STATE_KEY)
  const prev = prevRaw ? (JSON.parse(prevRaw) as { short: boolean; alertedAt?: number }) : { short: false }
  if (!short) {
    if (prev.short) await deps.kv.put(RECON_STATE_KEY, JSON.stringify({ short: false }))
    return { ran: true, snapshot, shortfallUsd: shortfall, alerted: false }
  }
  if (prev.short && prev.alertedAt && now - prev.alertedAt < RECON_REALERT_MS) {
    return { ran: true, snapshot, shortfallUsd: shortfall, alerted: false }
  }
  if (!alertSinkConfigured(deps.alertEnv)) {
    console.warn('[x402-reconcile] shortfall detected but no alert channel configured')
    return { ran: true, snapshot, shortfallUsd: shortfall, alerted: false }
  }
  const message =
    `[MPP Router] 🚨 x402 payer liability mismatch: funder short by $${shortfall.toFixed(2)}\n` +
    `Ledger Base liability (balances + unsettled signed credentials): $${liability.toFixed(2)}\n` +
    `Funder ${deps.funder} Base USDC on chain: $${funderUsd.toFixed(2)}\n` +
    `Tolerance (app_config X402_RECON_TOLERANCE_USD): $${tolerance}\n` +
    `Impact: signed x402 credentials may fail to settle. Top up the funder or switch X402_PAYER to off.`
  const send = deps.send ?? sendAlert
  const delivered = await send(deps.alertEnv, redactForAlert(message))
  if (delivered) await deps.kv.put(RECON_STATE_KEY, JSON.stringify({ short: true, alertedAt: now }))
  return { ran: true, snapshot, shortfallUsd: shortfall, alerted: delivered }
}
