// Existing Rozo order for a payment link: the ONE lookup create-invoice uses
// to find the order a link already has, shared with quote-invoice so the quote
// can show it read-only.
//
// orderId rules (same for both callers):
// - Coinbase payment-links / payment-sessions and internal rozotest_ invoices:
//   appId merchant_openrouter, orderId = the link id, plus the contract-variant
//   slots, plus the __retryN slots once the base order has expired.
// - Stripe Crypto: appId wallet_rozopay, orderId = stripe_crypto_<cpis_*>.

import type { Env } from '../index'
import { contractVariantIds, retryOrderIds } from '../mpp/contract-variant'
import { stripeOrderId } from './stripe-fulfillment'

export const ROZO_INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'
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

/** GET /payments/order/<appId>/<orderId> on the Rozo payment-api. */
export async function lookupIntentsOrder(
  env: Env,
  appId: string,
  orderId: string,
  signal?: AbortSignal,
): Promise<OrderLookup> {
  let lookup: Response
  try {
    lookup = await fetch(
      `${ROZO_INTENTS_BASE}/payments/order/${encodeURIComponent(appId)}/${encodeURIComponent(orderId)}`,
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

/** Read-only view of a link's current order, safe to show any quote caller. */
export interface ExistingOrderSummary {
  rozoPaymentId: string | null
  status: string | null
  source: { chainId: string | null; tokenSymbol: string | null }
  expiresAt: string | null
  /** True for any status past unpaid (funded, settling, settled, refunded). */
  paid: boolean
}

export type ExistingOrderTarget =
  | { provider: 'coinbase'; linkId: string } // also rozotest_ ids
  | { provider: 'stripe_crypto'; invoiceKey: string }

export const EXISTING_ORDER_TIMEOUT_MS = 2000

/** Same rule create-invoice uses for "no longer awaiting payment". */
function isPastUnpaid(status: string | null): boolean {
  return status !== null && status !== REUSABLE_PAYMENT_STATUS && status !== 'payment_expired'
}

function isLive(row: any): boolean {
  const exp = Date.parse(row?.expiresAt ?? '')
  return Number.isFinite(exp) && exp > Date.now()
}

/** Only these fields leave the Worker. No addresses, amounts, BOLT11, tokens. */
export function summarizeOrder(row: any): ExistingOrderSummary {
  const status = readPaymentStatus(row)
  const id = row?.id
  const expiresAt = row?.expiresAt
  return {
    rozoPaymentId: typeof id === 'string' ? id : null,
    status: typeof status === 'string' ? status : null,
    source: readRowSource(row),
    expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    paid: isPastUnpaid(typeof status === 'string' ? status : null),
  }
}

async function scanOrderRows(
  env: Env,
  target: ExistingOrderTarget,
  signal: AbortSignal,
): Promise<any[] | null> {
  if (target.provider === 'stripe_crypto') {
    const r = await lookupIntentsOrder(env, ROZO_APP_ID, stripeOrderId(target.invoiceKey), signal)
    if (r.state === 'error') return null
    return r.state === 'found' ? [r.row] : []
  }
  // Same slot scan as create-invoice: base + contract variants, then the
  // __retryN slots only once the base order exists and is no longer live.
  const firstIds = [target.linkId, ...contractVariantIds(target.linkId)]
  let scanned = await Promise.all(
    firstIds.map((id) => lookupIntentsOrder(env, OPENROUTER_APP_ID, id, signal)),
  )
  const base = scanned[0]
  if (base.state === 'found' && !isLive(base.row)) {
    const more = await Promise.all(
      retryOrderIds(target.linkId).map((id) => lookupIntentsOrder(env, OPENROUTER_APP_ID, id, signal)),
    )
    scanned = [...scanned, ...more]
  }
  // A partial view could show "unpaid" while a sibling is already settling:
  // any failed slot means no answer at all.
  if (scanned.some((r) => r.state === 'error')) return null
  return scanned.filter((r): r is { state: 'found'; row: any } => r.state === 'found').map((r) => r.row)
}

/**
 * The link's current order, or null when it has none, the lookup failed, or
 * it took longer than `timeoutMs`. Never throws: a quote must not fail or slow
 * down because of it.
 *
 * Current order, in priority: one past unpaid (money moving or moved), then a
 * live unpaid one, then the most recently allocated slot.
 */
export async function findExistingOrderSummary(
  env: Env,
  target: ExistingOrderTarget,
  timeoutMs = EXISTING_ORDER_TIMEOUT_MS,
): Promise<ExistingOrderSummary | null> {
  if (!env.ROZO_INTENTS_API_KEY) return null
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })
  try {
    const rows = await Promise.race([scanOrderRows(env, target, controller.signal), timeout])
    if (!rows || rows.length === 0) return null
    const current =
      rows.find((r) => isPastUnpaid(readPaymentStatus(r))) ??
      rows.find((r) => readPaymentStatus(r) === REUSABLE_PAYMENT_STATUS && isLive(r)) ??
      rows[rows.length - 1]
    return summarizeOrder(current)
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
