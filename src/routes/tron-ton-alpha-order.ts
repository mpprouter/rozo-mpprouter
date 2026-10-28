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

const ORDER_TIMEOUT_MS = 8_000
// Set once the order is known to exist; later polls of the same invoice skip
// the lookup. Also read by the webhook to close alpha test invoices on
// payment_payin_completed (alpha orders never reach a payout).
const ORDER_MARKER_TTL_S = 2 * 24 * 60 * 60

export function alphaOrderMarkerKey(invoiceKey: string): string {
  return `tta:order:${invoiceKey}`
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
  const mark = () => env.MPP_STORE.put(marker, '1', { expirationTtl: ORDER_MARKER_TTL_S }).catch(() => undefined)

  const found = await lookupIntentsOrder(env, OPENROUTER_APP_ID, a.invoiceKey, AbortSignal.timeout(ORDER_TIMEOUT_MS))
  if (found.state === 'error') return { ok: false, reason: 'lookup_failed' }
  if (found.state === 'found') {
    await mark()
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
    await mark()
    return { ok: true, state: 'created' }
  }
  // A concurrent create (another tab, or the main checkout) took the orderId:
  // the order exists, which is all this needs.
  const text = await res.text().catch(() => '')
  if (res.status === 409 && /orderIdConflict/i.test(text)) {
    await mark()
    return { ok: true, state: 'raced' }
  }
  console.warn('[tron-ton-alpha] business order create refused', res.status)
  return { ok: false, reason: 'create_failed' }
}

/** True once /option ensured this invoice's order (alpha was offered for it). */
export async function isAlphaInvoice(env: Env, invoiceKey: string): Promise<boolean> {
  const v = await env.MPP_STORE.get(alphaOrderMarkerKey(invoiceKey)).catch(() => null)
  return v !== null
}
