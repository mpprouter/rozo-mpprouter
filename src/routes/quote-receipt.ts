const RECEIPT_TTL_SECONDS = 60
const encoder = new TextEncoder()

export interface QuoteReceiptPayload {
  v: 1
  paymentId: string
  amount: string
  merchant: string
  iat: number
  exp: number
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
): Promise<string> {
  const payload: QuoteReceiptPayload = {
    v: 1,
    paymentId,
    amount,
    merchant,
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
      payload.v !== 1 ||
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
    return payload as QuoteReceiptPayload
  } catch {
    return null
  }
}
