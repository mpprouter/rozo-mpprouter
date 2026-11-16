import { MAX_CHECKOUT_WEB_FEE_BPS } from './checkout-web-pricing'

// 10 minutes. Was 60s when the checkout quoted and created back-to-back;
// since rozo-chat-ai #40 the page quotes on mount and only creates on the
// Pay click, and real dwell time before Pay is 2-18 min (rozo-chat-ai #47).
// The receipt is HMAC-signed and pins amount/fee/pricingVersion, so a longer
// TTL only widens the window in which a fee change is honoured at the old price.
const RECEIPT_TTL_SECONDS = 600
const encoder = new TextEncoder()

export interface QuoteReceiptPayload {
  v: 1 | 2 | 3
  paymentId: string
  amount: string
  merchant: string
  /** Present on v2 receipts. Binds the browser/CLI pricing decision. */
  original?: string
  serviceFee?: string
  callerPays?: string
  feeBps?: number
  pricingVersion?: string
  client?: string | null
  /** Authenticated server-side checkout identity. Present on v3 receipts. */
  channel?: string | null
  iat: number
  exp: number
}

export interface QuoteReceiptPricing {
  original: string
  serviceFee: string
  callerPays: string
  feeBps: number
  pricingVersion: string
  client: string | null
  channel?: string | null
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function createQuoteReceipt(
  paymentId: string,
  amount: string,
  merchant: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  pricing?: QuoteReceiptPricing,
): Promise<string> {
  const payload: QuoteReceiptPayload = {
    v: pricing ? (Object.prototype.hasOwnProperty.call(pricing, 'channel') ? 3 : 2) : 1,
    paymentId,
    amount,
    merchant,
    ...(pricing ?? {}),
    iat: nowSeconds,
    exp: nowSeconds + RECEIPT_TTL_SECONDS,
  }
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importKey(secret),
    encoder.encode(encodedPayload),
  )
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`
}

export async function verifyQuoteReceipt(
  receipt: string,
  expectedPaymentId: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<QuoteReceiptPayload | null> {
  const [encodedPayload, encodedSignature, extra] = receipt.split('.')
  if (!encodedPayload || !encodedSignature || extra) return null

  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await importKey(secret),
      base64UrlDecode(encodedSignature),
      encoder.encode(encodedPayload),
    )
    if (!valid) return null

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encodedPayload)),
    ) as Partial<QuoteReceiptPayload>
    if (
      (payload.v !== 1 && payload.v !== 2 && payload.v !== 3) ||
      payload.paymentId !== expectedPaymentId ||
      typeof payload.amount !== 'string' ||
      typeof payload.merchant !== 'string' ||
      !payload.merchant ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.iat > nowSeconds + 30 ||
      payload.exp <= nowSeconds
    ) {
      return null
    }
    if (
      (payload.v === 2 || payload.v === 3) &&
      (typeof payload.original !== 'string' ||
        typeof payload.serviceFee !== 'string' ||
        typeof payload.callerPays !== 'string' ||
        typeof payload.feeBps !== 'number' ||
        !Number.isSafeInteger(payload.feeBps) ||
        payload.feeBps < 0 ||
        payload.feeBps > MAX_CHECKOUT_WEB_FEE_BPS ||
        typeof payload.pricingVersion !== 'string' ||
        !payload.pricingVersion ||
        (payload.client !== null && typeof payload.client !== 'string'))
    ) {
      return null
    }
    if (payload.v === 3 && payload.channel !== null && typeof payload.channel !== 'string') return null
    return payload as QuoteReceiptPayload
  } catch {
    return null
  }
}

/**
 * Public quote identity (Agent Checkout G5): a non-secret id derived from the
 * signed receipt and the receipt's own expiry. Same receipt -> same id, so a
 * spend-request snapshot can tell whether the quote it was built from changed.
 * Reads the payload of a receipt this Worker just signed; it does not verify.
 */
export async function quoteIdentity(receipt: string): Promise<{ quoteId: string; quoteExpiresAt: string } | null> {
  const [encodedPayload] = receipt.split('.')
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as { exp?: unknown }
    if (typeof payload.exp !== 'number') return null
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(receipt)))
    const hex = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
    return { quoteId: `q_${hex.slice(0, 32)}`, quoteExpiresAt: new Date(payload.exp * 1000).toISOString() }
  } catch {
    return null
  }
}
