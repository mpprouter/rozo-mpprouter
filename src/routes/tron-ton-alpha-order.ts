/**
 * TRON / TON alpha: make sure the invoice's business order exists.
 *
 * rozo-intents-api settles a matched TRON / TON payment into the
 * merchant_openrouter intents order whose orderId is the invoice id
 * (shared/tron-ton-alpha/settle.ts). The checkout's create-invoice is what
 * normally creates that order, but a payer who goes straight to /tron or /ton
 * never calls it, so the matched payment had nowhere to land
 * (`intents_order_missing`) and the invoice was never paid.
 *
 * The /option route therefore ensures the order exists before it shows any
 * payment instructions. The order is created exactly like create-invoice's
 * default Base USDC order (same appId, orderId, exactIn source amount,
 * settlement destination and priced metadata), so:
 *   - the main checkout reuses it if the payer switches back (one order per
 *     invoice, pendingPricingMatches accepts it), and
 *   - every payment rail lands on the same order: a second paying rail is a
 *     duplicate the intents CAS and the router's per-invoice settling order /
 *     exec gate refuse to credit twice.
 *
 * An order that already exists (any status) is left alone: create-invoice
 * owns its lifecycle, and the alpha settle accepts unpaid, started and
 * expired orders. Lookup failures fail closed (no instructions shown).
 */

import type { Env } from '../index'
import { lookupIntentsOrder, OPENROUTER_APP_ID } from './existing-order'
import {
  BASE_USDC_ADDRESS,
  pricingFields,
  ROZO_INTENTS_URL,
  SETTLEMENT_RECEIVER,
} from './create-invoice'
import { buildCheckoutTitle, type CheckoutPricing } from './checkout-web-pricing'
import { withForwardedClientHint } from './client-hint-forward'
import { coinbaseLinkFromId, saveOriginalPaymentLink } from './payment-link-store'

const ORDER_TIMEOUT_MS = 8_000
// Set once the order is known to exist; later polls of the same invoice skip
// the lookup. A cache only: a missing marker just costs one more lookup.
// v2 (2026-10-31): the marker also means the original payment link is in
// checkout_payment_links. Bumped so invoices marked before the link was
// stored get one more lookup, which writes their row.
const ORDER_MARKER_TTL_S = 2 * 24 * 60 * 60

export function alphaOrderMarkerKey(invoiceKey: string): string {
  return `tta:order:v2:${invoiceKey}`
}

function rozoPaymentIdOf(row: unknown): string | null {
  const r = row as Record<string, any> | null | undefined
  const id = r?.id ?? r?.paymentId ?? r?.data?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Keep the invoice's original Coinbase link next to its Rozo order (founder
 * 2026-10-31: every checkout order, alpha rails included), through the same
 * helper create-invoice uses. Never throws. Returns false only when a row was
 * due and could not be written, so the caller leaves the marker unset and the
 * next poll retries; rozotest_ ids (no Coinbase link) and a missing binding
 * have nothing to write and return true.
 */
async function storeOriginalLink(env: Env, invoiceKey: string, row: unknown): Promise<boolean> {
  const url = coinbaseLinkFromId(invoiceKey)
  if (!url || !env.COUPON_SECURITY_DB) return true
  const rozoPaymentId = rozoPaymentIdOf(row)
  if (!rozoPaymentId) return false
  return saveOriginalPaymentLink(env, { rozoPaymentId, provider: 'coinbase', orderRef: invoiceKey, url }).catch(() => false)
}

export interface AlphaOrderArgs {
  invoiceKey: string
  merchant: string
  pricing: CheckoutPricing
  test: boolean
}

/** The payment-api create body. Pure; mirrors create-invoice's default (Base USDC, exactIn) order. */
export function buildAlphaBusinessOrderBody(a: AlphaOrderArgs): Record<string, unknown> {
  const priced = pricingFields(a.pricing)
  return {
    appId: OPENROUTER_APP_ID,
    orderId: a.invoiceKey,
    type: 'exactIn',
    display: {
      title: buildCheckoutTitle(a.merchant, a.pricing),
      currency: 'USD',
      merchantName: a.merchant,
      merchantDescription: `${a.merchant} via ROZO Checkout`,
    },
    source: {
      chainId: '8453',
      tokenSymbol: 'USDC',
      amount: priced.callerPays,
      tokenAddress: BASE_USDC_ADDRESS,
    },
    destination: {
      chainId: '8453',
      receiverAddress: SETTLEMENT_RECEIVER,
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
    },
    metadata: {
      source: 'mpprouter-tron-ton-alpha',
      coinbasePaymentLinkId: a.invoiceKey,
      ...priced,
      ...(a.test ? { testMode: true } : {}),
    },
  }
}

export type EnsureAlphaOrderResult =
  | { ok: true; state: 'cached' | 'existing' | 'created' | 'raced' }
  | { ok: false; reason: 'lookup_failed' | 'create_failed' }

export async function ensureAlphaBusinessOrder(
  env: Env,
  a: AlphaOrderArgs,
  forwardedHint: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<EnsureAlphaOrderResult> {
  const marker = alphaOrderMarkerKey(a.invoiceKey)
  const cached = await env.MPP_STORE.get(marker).catch(() => null)
  if (cached) return { ok: true, state: 'cached' }
  // The order exists: store its link, and cache that only once the link is in.
  // A failed link write never fails the option (the order is what delivery
  // needs); it only costs the next poll one more lookup.
  const mark = async (row: unknown) => {
    if (!(await storeOriginalLink(env, a.invoiceKey, row))) return
    await env.MPP_STORE.put(marker, '1', { expirationTtl: ORDER_MARKER_TTL_S }).catch(() => undefined)
  }

  const found = await lookupIntentsOrder(env, OPENROUTER_APP_ID, a.invoiceKey, AbortSignal.timeout(ORDER_TIMEOUT_MS))
  if (found.state === 'error') return { ok: false, reason: 'lookup_failed' }
  if (found.state === 'found') {
    await mark(found.row)
    return { ok: true, state: 'existing' }
  }

  let res: Response
  try {
    res = await fetchImpl(ROZO_INTENTS_URL, {
      method: 'POST',
      headers: withForwardedClientHint(
        { 'content-type': 'application/json', 'X-API-Key': env.ROZO_INTENTS_API_KEY },
        forwardedHint,
      ),
      body: JSON.stringify(buildAlphaBusinessOrderBody(a)),
      signal: AbortSignal.timeout(ORDER_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'create_failed' }
  }
  if (res.ok) {
    await mark(await res.json().catch(() => null))
    return { ok: true, state: 'created' }
  }
  // A concurrent create (another tab, or the main checkout) took the orderId:
  // the order exists, which is all this needs.
  // Re-read it rather than trusting the 409: payment-api also answers
  // orderIdConflict for a create still in flight that may yet roll back.
  const text = await res.text().catch(() => '')
  if (res.status === 409 && /orderIdConflict/i.test(text)) {
    const again = await lookupIntentsOrder(env, OPENROUTER_APP_ID, a.invoiceKey, AbortSignal.timeout(ORDER_TIMEOUT_MS))
    if (again.state !== 'found') return { ok: false, reason: 'create_failed' }
    await mark(again.row)
    return { ok: true, state: 'raced' }
  }
  console.warn('[tron-ton-alpha] business order create refused', res.status)
  return { ok: false, reason: 'create_failed' }
}
