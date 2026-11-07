/**
 * Settle a stellar.x402 payment after the merchant was paid, and leave a ledger
 * row whatever happens next.
 *
 * The router pays upstream first and settles the buyer second. On 2026-11-06,
 * 23 of 162 calls vanished from the ledger: the row was only written after
 * settlement returned, and the Worker died first. So the row now exists before
 * settlement starts.
 *
 * settlement_status:
 *   pending  row written, settlement running. Only stays here if the Worker
 *            died; the resolver below moves it on.
 *   settled  the tx is on chain. The only state counted in /v1/stats.
 *   failed   definitely not on chain.
 *   unknown  a signed tx may still land. The resolver reads the chain and moves
 *            it to settled or failed once the tx time bound has passed. It stays
 *            unknown only if the Worker died before signing, or the chain stayed
 *            unreadable for RESOLVER_GIVE_UP_MS.
 */

import { stellarRpcUrl } from '../utils/stellar-rpc'
import { rpc } from '@stellar/stellar-sdk'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import type { Env } from '../index'
import { checkAndBumpWindowLimit } from '../mpp/rate-limit-do'
import { settleStellarX402, SETTLE_WAIT_MS, type StellarX402SettleResult } from '../mpp/stellar-x402-server'
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'
import { newOrderId, recordOrder, type OrderLedgerEntry } from './order-ledger'

const OPEN_PREFIX = 'x402_settle_open:'
const OPEN_TTL_SECONDS = 48 * 60 * 60
const RESOLVER_BATCH = 20
/** Settlement tx time bound is maxTimeoutSeconds = 300 s; add the wait and clock margin. */
export const TX_EXPIRED_AFTER_MS = 300_000 + SETTLE_WAIT_MS + 60_000
/** A younger row may still belong to a running request. */
const RESOLVER_MIN_AGE_MS = 60_000
export const RESOLVER_GIVE_UP_MS = 24 * 60 * 60 * 1000
const ALERT_WINDOW_MS = 60 * 60 * 1000
/** KV allows one write per key per second. */
const KV_SAME_KEY_GAP_MS = 1_100
const MAX_STORED_ERROR_CHARS = 800

function openKey(orderId: string): string {
  return `${OPEN_PREFIX}${orderId}`
}

interface OpenSettlement {
  entry: OrderLedgerEntry
  created_at: number
}

function causeText(result: StellarX402SettleResult): string | undefined {
  const text = [result.errorMessage, ...result.causes].filter(Boolean).join(' | ')
  return text ? String(redactForAlert(text)).slice(0, MAX_STORED_ERROR_CHARS) : undefined
}

function applyResult(entry: OrderLedgerEntry, result: StellarX402SettleResult): OrderLedgerEntry {
  return {
    ...entry,
    settlement_ref: result.outcome === 'settled' ? (result.transaction ?? null) : null,
    settlement_status: result.outcome,
    settlement_attempt_txs: result.attemptedTxs,
    settlement_error_reason: result.errorReason,
    settlement_error: causeText(result),
    settlement_rpc_status: result.rpcStatus,
  }
}

/** Hourly, one slot. Fails open: a repeat beats a silent settlement failure. */
export async function claimSettlementAlertSlot(env: Env, now: number = Date.now()): Promise<boolean> {
  try {
    const slot = await checkAndBumpWindowLimit(env, 'alert:x402-settlement-failed', 1, ALERT_WINDOW_MS, now)
    return slot.ok
  } catch (err) {
    console.warn(`[x402-settlement] alert dedupe failed: ${String(err)}`)
    return true
  }
}

async function alertUnsettled(env: Env, entry: OrderLedgerEntry): Promise<void> {
  if (!alertSinkConfigured(env)) return
  if (!(await claimSettlementAlertSlot(env))) return
  await sendAlert(env, redactForAlert(
    `[MPP Router] ⚠️ stellar.x402 settlement ${entry.settlement_status}: merchant paid, buyer not charged\n` +
    `Route: ${entry.route_id}\n` +
    `Order: ${entry.order_id}\n` +
    `Amount: ${entry.amount_usd} USD\n` +
    `Reason: ${entry.settlement_error_reason ?? 'none'}\n` +
    `Detail: ${entry.settlement_error ?? 'none'}\n` +
    `At most one alert per hour; count rows in GET /v1/ledger by settlement_status.`,
  ))
}

export interface SettleAndRecordParams {
  env: Env
  ctx: ExecutionContext
  payload: PaymentPayload
  requirements: PaymentRequirements
  routeId: string
  payer: string | null
  amountUsd: string
  requestPath: string
  upstreamStatus: number
  latencyMs: number
  /** Injectable for tests. */
  settle?: typeof settleStellarX402
}

export async function settleAndRecordX402(p: SettleAndRecordParams): Promise<StellarX402SettleResult> {
  const { env, ctx } = p
  const startedAt = Date.now()
  const entry: OrderLedgerEntry = {
    order_id: newOrderId(),
    ts: new Date(startedAt).toISOString(),
    route_id: p.routeId,
    payer: p.payer,
    amount_usd: p.amountUsd,
    settlement_ref: null,
    settlement_status: 'pending',
    settlement_attempt_txs: [],
    request_path: p.requestPath,
    upstream_status: p.upstreamStatus,
    latency_ms: p.latencyMs,
    refund_status: 'none',
  }
  const key = openKey(entry.order_id)
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  // KV allows one write per key per second, and a retry signs a second hash
  // soon after the first. Space the writes rather than lose a hash.
  let lastOpenWrite = 0
  const writeOpen = async (e: OrderLedgerEntry): Promise<void> => {
    const put = async () => {
      const wait = KV_SAME_KEY_GAP_MS - (Date.now() - lastOpenWrite)
      if (wait > 0) await sleep(wait)
      lastOpenWrite = Date.now()
      await env.MPP_STORE.put(key, JSON.stringify({ entry: e, created_at: startedAt } satisfies OpenSettlement), {
        expirationTtl: OPEN_TTL_SECONDS,
      })
    }
    try {
      await put()
    } catch {
      await put().catch((err) => {
        console.warn(`[x402-settlement] open marker write failed for ${entry.order_id}: ${String(err)}`)
      })
    }
  }

  // Before settlement, so a Worker killed mid-settlement still leaves both.
  await recordOrder(env, entry)
  const rowWrittenAt = Date.now()
  await writeOpen(entry)

  const settlement = (async () => {
    const result = await (p.settle ?? settleStellarX402)(env, p.payload, p.requirements, {
      // Before submission, so a killed Worker still leaves a hash to look up.
      onSigned: (hashes) => writeOpen({ ...entry, settlement_attempt_txs: [...hashes] }),
    })
    if (!result.success) {
      console.error(
        `[proxy] stellar.x402 settlement ${result.outcome} for ${p.routeId} order=${entry.order_id}: ` +
          `${result.errorReason ?? ''} ${result.errorMessage ?? ''}`,
      )
    }
    const wait = KV_SAME_KEY_GAP_MS - (Date.now() - rowWrittenAt)
    if (wait > 0) await sleep(wait)

    const final = applyResult(entry, result)
    const written = await recordOrder(env, final)
    // Keep the marker for an unknown outcome, or if the final row did not land.
    if (written && result.outcome !== 'unknown') {
      await env.MPP_STORE.delete(key).catch(() => undefined)
    } else if (result.outcome === 'unknown') {
      await writeOpen(final)
    }
    if (result.outcome === 'failed') await alertUnsettled(env, final)
    return result
  })()

  // Keeps running if the client disconnects; the response still awaits it.
  ctx.waitUntil(settlement.then(() => undefined, () => undefined))
  return settlement
}

type ChainStatus = 'SUCCESS' | 'FAILED' | 'NOT_FOUND'

export interface ResolverDeps {
  getStatus?: (hash: string) => Promise<ChainStatus>
  now?: number
}

/**
 * Close rows whose outcome was unknown when the request ended. Runs on the
 * 2-minute cron and only makes RPC calls for open rows. Read-only on chain.
 * Keeps a row open on any read error: NOT_FOUND is the only proof of absence,
 * and only once the tx time bound has passed.
 */
export async function resolveOpenX402Settlements(env: Env, deps: ResolverDeps = {}): Promise<void> {
  try {
    const listed = await env.MPP_STORE.list({ prefix: OPEN_PREFIX, limit: RESOLVER_BATCH })
    if (listed.keys.length === 0) return
    const server = new rpc.Server(stellarRpcUrl(env))
    const getStatus = deps.getStatus ?? (async (hash: string) => (await server.getTransaction(hash)).status as ChainStatus)
    const now = deps.now ?? Date.now()
    for (const { name } of listed.keys) {
      const raw = await env.MPP_STORE.get(name)
      if (!raw) continue
      const open = JSON.parse(raw) as OpenSettlement
      const age = now - open.created_at
      if (age < RESOLVER_MIN_AGE_MS) continue
      const final = await resolveOne(open.entry, age, getStatus)
      if (!final) continue
      if (!(await recordOrder(env, final))) continue
      await env.MPP_STORE.delete(name)
      if (final.settlement_status !== 'settled') await alertUnsettled(env, final)
    }
  } catch (err) {
    console.warn(`[x402-settlement] resolver skipped: ${(err as Error).message}`)
  }
}

async function resolveOne(
  entry: OrderLedgerEntry,
  age: number,
  getStatus: (hash: string) => Promise<ChainStatus>,
): Promise<OrderLedgerEntry | null> {
  const hashes = entry.settlement_attempt_txs ?? []
  const givenUp = age >= RESOLVER_GIVE_UP_MS
  let readAll = true
  for (const hash of hashes) {
    try {
      if ((await getStatus(hash)) === 'SUCCESS') {
        return { ...entry, settlement_status: 'settled', settlement_ref: hash, settlement_error_reason: undefined, settlement_error: undefined }
      }
    } catch (err) {
      readAll = false
      console.warn(`[x402-settlement] chain read failed for ${entry.order_id}: ${String(err)}`)
    }
  }
  if (age < TX_EXPIRED_AFTER_MS) return null
  if (hashes.length === 0) {
    return {
      ...entry,
      settlement_status: 'unknown',
      settlement_error_reason: entry.settlement_error_reason ?? 'worker_stopped_before_signing',
    }
  }
  if (readAll) {
    return {
      ...entry,
      settlement_status: 'failed',
      settlement_error_reason: entry.settlement_error_reason ?? 'tx_expired_not_on_chain',
    }
  }
  return givenUp
    ? { ...entry, settlement_status: 'unknown', settlement_error_reason: entry.settlement_error_reason ?? 'chain_unreadable' }
    : null
}
