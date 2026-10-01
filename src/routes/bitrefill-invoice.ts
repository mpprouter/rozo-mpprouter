/**
 * Bitrefill invoice payment (provider: "bitrefill").
 *
 * The caller already created a Bitrefill invoice and chose "USDC on Base".
 * We create ONE Rozo Intents exactOut payment whose destination is the
 * Bitrefill receiving address itself: Bitrefill receives exactly `amount`
 * Base USDC, the bridge fee is added to the source side. There is no funder
 * wallet, no pay-invoice call and no exec gate: settlement is the Rozo
 * payout itself, so the webhook ignores these orders (see webhook.ts).
 *
 * Idempotency follows the Coinbase line: the orderId is derived from the
 * Bitrefill invoice id, and the Rozo payment-api lookup
 * GET /payments/order/:appId/:orderId is the source of truth (an orderId can
 * only ever be created once upstream).
 */
import type { Env } from '../index'
import { forwardedClientHintHeader, withForwardedClientHint } from './client-hint-forward'
import { parseNativeSources } from './native-sources'
import { normalizeCheckoutClient } from './checkout-web-pricing'

const ROZO_INTENTS_URL = 'https://intentapiv4.rozo.ai/functions/v1/payment-api/'
const ROZO_INTENTS_BASE = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'
// Same merchant appId as the Coinbase/OpenRouter create-invoice line.
export const BITREFILL_APP_ID = 'merchant_openrouter'
const BASE_CHAIN_ID = '8453'
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Max USDC a single Bitrefill invoice may route through us. */
export const BITREFILL_MAX_USDC = 500
/** Minimum time left on the Bitrefill invoice before we open a deposit. */
export const BITREFILL_MIN_REMAINING_MS = 5 * 60 * 1000
/** orderId prefix; the webhook uses it to skip router-side settlement. */
export const BITREFILL_ORDER_PREFIX = 'bitrefill_'

// Known compromised / attacker addresses (lowercased). No shared blocklist
// exists in this repo, so these are hard-coded here.
const BLOCKED_ADDRESSES: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x5772fbe7a7817ef7f586215ca8b23b8dd22c8897',
  '0xf621ee3bae3cbe924ec05f795d14e31384bd11b6',
])

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/
const INVOICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isBitrefillOrderId(orderId: unknown): boolean {
  return typeof orderId === 'string' && orderId.startsWith(BITREFILL_ORDER_PREFIX)
}

export function bitrefillOrderId(invoiceId: string): string {
  return `${BITREFILL_ORDER_PREFIX}${invoiceId}`
}

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error, message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function ok(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

type ResolveSource = (
  raw: unknown,
  nativeAllowed: ReadonlySet<string>,
) => { resolved?: { chainId: string; tokenSymbol: string }; error?: { code: string; message: string; supported?: unknown } }

export async function handleBitrefillCreateInvoice(
  request: Request,
  env: Env,
  parsed: Record<string, unknown>,
  resolveSource: ResolveSource,
): Promise<Response> {
  if (String(env.BITREFILL_ENABLED ?? 'false').toLowerCase() !== 'true') {
    return fail(403, 'BITREFILL_DISABLED', 'Bitrefill invoice payment is not enabled.')
  }

  const br = parsed.bitrefill
  if (!br || typeof br !== 'object' || Array.isArray(br)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill must be an object with invoiceId, address and amount.')
  }
  const { invoiceId, address, amount, expiresAt } = br as Record<string, unknown>

  if (typeof invoiceId !== 'string' || !INVOICE_ID_RE.test(invoiceId)) {
    return fail(400, 'INVALID_INPUT', 'bitrefill.invoiceId must be 1-128 chars of [A-Za-z0-9_-].')
  }
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return fail(400, 'INVALID_ADDRESS', 'bitrefill.address must be a 0x-prefixed 40-hex Base address.')
  }
  if (BLOCKED_ADDRESSES.has(address.toLowerCase())) {
    return fail(400, 'BLOCKED_ADDRESS', 'This receiving address is not allowed.')
  }
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    return fail(400, 'INVALID_AMOUNT', 'bitrefill.amount must be a positive decimal string with at most 6 decimals.')
  }
  if (Number(amount) > BITREFILL_MAX_USDC) {
    return fail(400, 'AMOUNT_OUT_OF_RANGE', `bitrefill.amount must be at most ${BITREFILL_MAX_USDC} USDC.`)
  }
  let expiresAtIso: string | null = null
  if (expiresAt !== undefined && expiresAt !== null) {
    const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN
    if (!Number.isFinite(t)) {
      return fail(400, 'INVALID_INPUT', 'bitrefill.expiresAt must be an ISO-8601 timestamp.')
    }
    if (t - Date.now() < BITREFILL_MIN_REMAINING_MS) {
      return fail(400, 'INVOICE_EXPIRING', 'The Bitrefill invoice expires in under 5 minutes. Create a new invoice.')
    }
    expiresAtIso = new Date(t).toISOString()
  }

  const src = resolveSource(parsed.source, parseNativeSources(env.NATIVE_SOURCES))
  if (!src.resolved) {
    return fail(400, 'UNSUPPORTED_SOURCE', src.error?.message ?? 'Unsupported source.', {
      supported: src.error?.supported,
    })
  }
  const source = src.resolved

  const orderId = bitrefillOrderId(invoiceId)

  const lookupExisting = async (): Promise<{ state: 'found'; row: any } | { state: 'missing' } | { state: 'error' }> => {
    try {
      const r = await fetch(
        `${ROZO_INTENTS_BASE}/payments/order/${encodeURIComponent(BITREFILL_APP_ID)}/${encodeURIComponent(orderId)}`,
        { method: 'GET', headers: { 'X-API-Key': env.ROZO_INTENTS_API_KEY } },
      )
      if (r.status === 404) return { state: 'missing' }
      if (!r.ok) return { state: 'error' }
      const row = await r.json().catch(() => undefined)
      return row === undefined ? { state: 'error' } : { state: 'found', row }
    } catch {
      return { state: 'error' }
    }
  }
  const duplicate = (row: any) =>
    fail(409, 'DUPLICATE_INVOICE', 'A payment already exists for this Bitrefill invoice. Resume it instead of paying again.', {
      invoiceId,
      rozoPaymentId: row?.id ?? null,
      expiresAt: row?.expiresAt ?? null,
    })

  const existing = await lookupExisting()
  if (existing.state === 'found') return duplicate(existing.row)
  if (existing.state === 'error') {
    return fail(502, 'INTENTS_API_FAILED', 'Could not check for an existing payment for this invoice. Retry shortly.')
  }

  const client = normalizeCheckoutClient(parsed.client)
  const attribution = parsed.attribution
  const attributionField =
    attribution && typeof attribution === 'object' && !Array.isArray(attribution) ? { attribution } : {}

  const intentsBody = {
    appId: BITREFILL_APP_ID,
    orderId,
    type: 'exactOut',
    display: {
      title: `Bitrefill invoice ${invoiceId}`,
      currency: 'USD',
      merchantName: 'Bitrefill',
      merchantDescription: 'Bitrefill via ROZO Checkout',
    },
    source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    destination: {
      chainId: BASE_CHAIN_ID,
      receiverAddress: address,
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC_ADDRESS,
      amount,
    },
    ...attributionField,
    metadata: {
      source: 'mpprouter-create-invoice',
      provider: 'bitrefill',
      bitrefillInvoiceId: invoiceId,
      ...(client ? { client } : {}),
    },
  }

  let resp: Response
  try {
    resp = await fetch(ROZO_INTENTS_URL, {
      method: 'POST',
      headers: withForwardedClientHint(
        { 'content-type': 'application/json', 'X-API-Key': env.ROZO_INTENTS_API_KEY },
        forwardedClientHintHeader(request, client),
      ),
      body: JSON.stringify(intentsBody),
    })
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API unreachable.')
  }
  const text = await resp.text()
  if (!resp.ok) {
    if (resp.status === 409 && /orderIdConflict/i.test(text)) {
      const raced = await lookupExisting()
      return duplicate(raced.state === 'found' ? raced.row : null)
    }
    return fail(502, 'INTENTS_API_FAILED', `Rozo intents API returned ${resp.status}.`)
  }
  let created: any
  try {
    created = JSON.parse(text)
  } catch {
    return fail(502, 'INTENTS_API_FAILED', 'Rozo intents API returned a malformed body.')
  }

  // Effective expiry: the earlier of Bitrefill's and the Rozo deposit's.
  const rozoExp = typeof created?.expiresAt === 'string' ? Date.parse(created.expiresAt) : NaN
  const bitrefillExp = expiresAtIso ? Date.parse(expiresAtIso) : NaN
  const candidates = [rozoExp, bitrefillExp].filter(Number.isFinite)
  const effectiveExpiresAt = candidates.length ? new Date(Math.min(...candidates)).toISOString() : null

  return ok({
    provider: 'bitrefill',
    invoiceId,
    rozoPaymentId: created?.id ?? null,
    destination: { chainId: BASE_CHAIN_ID, tokenSymbol: 'USDC', address, amount },
    expiresAt: effectiveExpiresAt,
    ...(created?.paymentLink ? { paymentLink: created.paymentLink } : {}),
    ...(created?.source ? { source: created.source } : {}),
  })
}
