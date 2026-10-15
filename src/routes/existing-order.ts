// Existing Rozo order for a payment link: the ONE lookup create-invoice uses
// to find the order a link already has, shared with the read-only
// GET /v1/services/rozo-agent-api/existing-order endpoint. quote-invoice does
// NOT call it: the intents lookup takes seconds in production (2026-10-12
// rollback of 8e3e1633), and the quote must stay fast.
//
// orderId rules (same for both callers):
// - Coinbase payment-links / payment-sessions and internal rozotest_ invoices:
//   appId merchant_openrouter, orderId = the link id, plus the contract-variant
//   slots, plus the __retryN slots once the base order has expired (the
//   endpoint scans exactly what create-invoice scans).
// - Stripe Crypto: appId wallet_rozopay, orderId = stripe_crypto_<cpis_*>.

import type { Env } from '../index'
import { contractVariantIds, retryOrderIds } from '../mpp/contract-variant'
import { stripeOrderId } from './stripe-fulfillment'
import { rowFundingEvidence } from './relink-guard'

import { ROZO_INTENTS_BASE, intentsReadBase } from './intents-base'

// Re-exported for existing importers; writes use it, reads use intentsReadBase.
export { ROZO_INTENTS_BASE }
// appId Stripe Crypto orders are filed under.
export const ROZO_APP_ID = 'wallet_rozopay'
// appId every Coinbase (and rozotest_) order is filed under.
export const OPENROUTER_APP_ID = 'merchant_openrouter'

/** Upstream status of an order still awaiting payment. */
export const REUSABLE_PAYMENT_STATUS = 'payment_unpaid'

/** Status of an intents_payments row, whichever casing the API returned. */
export function readPaymentStatus(row: any): string | null {
  return row?.status ?? row?.payment_status ?? null
}

/** Source (chain/token) an intents_payments row currently pays from. */
export function readRowSource(row: any): { chainId: string | null; tokenSymbol: string | null } {
  const chainId = row?.source?.chainId ?? row?.source_chain_id ?? null
  const tokenSymbol = row?.source?.tokenSymbol ?? row?.source_token_symbol ?? null
  return {
    chainId: chainId === null || chainId === undefined ? null : String(chainId),
    tokenSymbol:
      tokenSymbol === null || tokenSymbol === undefined ? null : String(tokenSymbol).toUpperCase(),
  }
}

// Tri-state: only an explicit 404 means the orderId slot is free. Any other
// failure (network, 5xx, malformed body) is 'error'.
export type OrderLookup =
  | { state: 'found'; row: any }
  | { state: 'missing' }
  | { state: 'error'; status: number | null }

/**
 * GET /payments/order/<appId>/<orderId> on the Rozo Intents read base
 * (payment-read when ROZO_INTENTS_READ_BASE is set, else payment-api).
 */
export async function lookupIntentsOrder(
  env: Env,
  appId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<OrderLookup> {
  let lookup: Response
  try {
    lookup = await fetch(
      `${intentsReadBase(env)}/payments/order/${encodeURIComponent(appId)}/${encodeURIComponent(orderId)}`,
      {
        method: 'GET',
        headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY },
        ...(signal ? { signal } : {}),
      },
    )
  } catch {
    return { state: 'error', status: null }
  }
  if (lookup.status === 404) return { state: 'missing' }
  if (!lookup.ok) return { state: 'error', status: lookup.status }
  const row = await lookup.json().catch(() => undefined)
  if (row === undefined) return { state: 'error', status: lookup.status }
  return { state: 'found', row }
}

/**
 * Where a link's current order stands, for the checkout:
 * - payable: awaiting payment, unexpired, no funding evidence.
 * - funded:  any funding evidence on the row (rowFundingEvidence, the relink
 *            guard's rules), or a status past unpaid that is not an unpaid end.
 * - ended:   expired with no funding evidence, refunded, bounced or failed.
 */
export type ExistingOrderState = 'payable' | 'funded' | 'ended'

/** Read-only view of a link's current order, safe to show any quote caller. */
export interface ExistingOrderSummary {
  rozoPaymentId: string | null
  status: string | null
  source: { chainId: string | null; tokenSymbol: string | null }
  expiresAt: string | null
  state: ExistingOrderState
  /** Compatibility alias: state === 'funded'. */
  paid: boolean
}

export type ExistingOrderTarget =
  | { provider: 'coinbase'; linkId: string } // pl_*, paymentSession_*, signed rozotest_
  | { provider: 'stripe_crypto'; invoiceKey: string } // cpis_*

/**
 * Lookup outcome. 'unknown' = could not tell in time (failed, timed out,
 * rate limited): the caller must not assume there is no order.
 */
export type ExistingOrderResult =
  | { kind: 'found'; summary: ExistingOrderSummary }
  | { kind: 'none' }
  | { kind: 'unknown' }

/**
 * Total deadline for one existing-order call. Off the quote's critical path,
 * so it can be generous: each intents order GET takes ~2.5s in production
 * (2026-10-12), and an expired base order needs a second (retry) round.
 */
export const EXISTING_ORDER_TIMEOUT_MS = 9000

// Statuses that end an order with the money not kept (or never arrived).
const ENDED_STATUSES = new Set(['payment_expired', 'payment_refunded', 'payment_bounced', 'payment_failed'])
// Of those, the ones that end it after money moved and went back.
const RETURNED_STATUSES = new Set(['payment_refunded', 'payment_bounced', 'payment_failed'])

const COINBASE_ID_RE = /^(?:pl_|paymentSession_)[A-Za-z0-9_-]{1,128}$/
const TEST_ID_RE = /^rozotest_\d{1,5}_[a-z0-9]{6,32}_[0-9a-f]{16}$/
const STRIPE_KEY_RE = /^cpis_[A-Za-z0-9]{1,128}$/

/** Only well-formed ids reach the intents API (no spray of arbitrary keys). */
export function isLookupTargetValid(target: ExistingOrderTarget): boolean {
  if (target.provider === 'stripe_crypto') return STRIPE_KEY_RE.test(target.invoiceKey)
  return COINBASE_ID_RE.test(target.linkId) || TEST_ID_RE.test(target.linkId)
}

function isLive(row: any): boolean {
  const exp = Date.parse(row?.expiresAt ?? '')
  return Number.isFinite(exp) && exp > Date.now()
}

export function classifyOrderState(row: any): ExistingOrderState {
  const status = readPaymentStatus(row)
  if (status !== null && RETURNED_STATUSES.has(status)) return 'ended'
  if (rowFundingEvidence(row)) return 'funded'
  if (status === REUSABLE_PAYMENT_STATUS) return isLive(row) ? 'payable' : 'ended'
  if (status !== null && ENDED_STATUSES.has(status)) return 'ended'
  // Past unpaid (payin / payout completed, in flight) or an unknown status:
  // treat as money moving, never as payable.
  return 'funded'
}

/** Only these fields leave the Worker. No addresses, amounts, BOLT11, tokens. */
export function summarizeOrder(row: any): ExistingOrderSummary {
  const status = readPaymentStatus(row)
  const id = row?.id
  const expiresAt = row?.expiresAt
  const state = classifyOrderState(row)
  return {
    rozoPaymentId: typeof id === 'string' ? id : null,
    status: typeof status === 'string' ? status : null,
    source: readRowSource(row),
    expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    state,
    paid: state === 'funded',
  }
}

/** One scanned orderId slot, in create-invoice's allocation order. */
export interface OrderSlotEntry {
  id: string
  slot: 'base' | 'contract' | 'retry'
  row: any | null
  /** expiresAt in the future (create-invoice's "live"). */
  live: boolean
}

/** A Stellar contract pay-in order (create-invoice's isContractRow). */
export function isContractRow(row: any): boolean {
  return Boolean(row?.source?.receiverAddressContract)
}

async function scanOrderSlots(
  env: Env,
  target: ExistingOrderTarget,
  signal: AbortSignal,
): Promise<OrderSlotEntry[] | null> {
  if (target.provider === 'stripe_crypto') {
    const id = stripeOrderId(target.invoiceKey)
    const r = await lookupIntentsOrder(env, ROZO_APP_ID, id, signal)
    if (r.state === 'error') return null
    const row = r.state === 'found' ? r.row : null
    return [{ id, slot: 'base', row, live: row ? isLive(row) : false }]
  }
  // Exactly create-invoice's slot set: base + contract variants in parallel,
  // and the __retryN slots once the base order exists and is no longer live
  // (create-invoice re-orders into them after the base order expired).
  //
  // The retry round starts as soon as the BASE slot answers, without waiting
  // for the contract slots (each GET is ~2.5s in production). Safe for
  // pickCurrentOrder: the condition depends on the base row alone, and the
  // set of slots read (and their order in `entries`) is the same as a
  // sequential scan; only the timing overlaps.
  const firstIds = [target.linkId, ...contractVariantIds(target.linkId)]
  const retryIds = retryOrderIds(target.linkId)
  const lookup = (id: string) => lookupIntentsOrder(env, OPENROUTER_APP_ID, id, signal)
  const baseP = lookup(firstIds[0])
  const contractP = Promise.all(firstIds.slice(1).map(lookup))
  const retryP = baseP.then((base) =>
    base.state === 'found' && !isLive(base.row) ? Promise.all(retryIds.map(lookup)) : null,
  )
  const [base, contracts, retries] = await Promise.all([baseP, contractP, retryP])
  const ids = retries ? [...firstIds, ...retryIds] : firstIds
  const scanned = [base, ...contracts, ...(retries ?? [])]
  // A partial view could show "payable" while a sibling is already settling:
  // any failed slot means no answer.
  if (scanned.some((r) => r.state === 'error')) return null
  return ids.map((id, i) => {
    const r = scanned[i]
    const row = r.state === 'found' ? r.row : null
    const slot: OrderSlotEntry['slot'] = i === 0 ? 'base' : i < firstIds.length ? 'contract' : 'retry'
    return { id, slot, row, live: row ? isLive(row) : false }
  })
}

/**
 * The order create-invoice (no pay-in intent) would block on or reuse, with
 * the same precedence:
 * 1. an order no longer awaiting payment (status past unpaid, not expired):
 *    create-invoice answers ORDER_ALREADY_ACTIVE with it;
 * 2. the newest live classic order, else the newest live contract order:
 *    create-invoice reuses it;
 * 3. no live order: an earlier order with funding evidence (the relink guard
 *    blocks on it), else the newest order (ended; a new order would follow).
 * Later slots of one family are always newer, so "newest" is the last match.
 */
export function pickCurrentOrder(entries: OrderSlotEntry[]): any | null {
  const found = entries.filter((e) => e.row)
  if (found.length === 0) return null
  const inFlight = found.find((e) => {
    const st = readPaymentStatus(e.row)
    return st !== null && st !== REUSABLE_PAYMENT_STATUS && st !== 'payment_expired'
  })
  if (inFlight) return inFlight.row
  const newest = (pred: (e: OrderSlotEntry) => boolean) =>
    [...found].reverse().find(pred) ?? null
  const live =
    newest((e) => e.live && !isContractRow(e.row) && e.slot !== 'contract') ??
    newest((e) => e.live && isContractRow(e.row))
  if (live) return live.row
  const funded = found.find((e) => rowFundingEvidence(e.row))
  if (funded) return funded.row
  return found[found.length - 1].row
}

export interface ExistingOrderOptions {
  timeoutMs?: number
}

/**
 * The link's current order. Advisory only: create-invoice remains the gate.
 * Never throws and never takes longer than `timeoutMs`.
 *
 * Which order: see pickCurrentOrder (same precedence as create-invoice).
 */
export async function findExistingOrder(
  env: Env,
  target: ExistingOrderTarget,
  opts: ExistingOrderOptions = {},
): Promise<ExistingOrderResult> {
  if (!isLookupTargetValid(target)) return { kind: 'none' }
  if (!env.ROZO_INTENTS_API_KEY) return { kind: 'unknown' }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ExistingOrderResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'unknown' })
    }, opts.timeoutMs ?? EXISTING_ORDER_TIMEOUT_MS)
  })
  const work = (async (): Promise<ExistingOrderResult> => {
    const entries = await scanOrderSlots(env, target, controller.signal)
    if (entries === null) return { kind: 'unknown' }
    const current = pickCurrentOrder(entries)
    return current ? { kind: 'found', summary: summarizeOrder(current) } : { kind: 'none' }
  })()
  try {
    return await Promise.race([work, timeout])
  } catch {
    return { kind: 'unknown' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
