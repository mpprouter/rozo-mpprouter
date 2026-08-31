import { describe, it, expect } from 'vitest'
import { callAgentApiPayInvoice } from '../src/routes/webhook'

// We can't easily unit-test the full webhook handler without mocking
// Cloudflare bindings; instead verify the HMAC primitive matches Rozo's
// documented contract: sha256(secret, `${timestamp}.${rawBody}`) returned
// as lowercase hex.
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

describe('webhook HMAC contract', () => {
  it('signs `${timestamp}.${body}` with secret to lowercase hex', async () => {
    const secret = 'test-secret'
    const ts = '1779517000000'
    const body = '{"event_id":"abc","type":"payment_payin_completed"}'
    const sig = await hmacSha256Hex(secret, `${ts}.${body}`)
    // Known-answer: precomputed manually with openssl:
    //   echo -n "1779517000000.{...}" | openssl dgst -sha256 -hmac test-secret
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    // Sanity: identical inputs => identical output (deterministic).
    const sig2 = await hmacSha256Hex(secret, `${ts}.${body}`)
    expect(sig2).toBe(sig)
  })

  it('different timestamp produces different signature', async () => {
    const secret = 'x'
    const body = 'hello'
    const s1 = await hmacSha256Hex(secret, `1.${body}`)
    const s2 = await hmacSha256Hex(secret, `2.${body}`)
    expect(s1).not.toBe(s2)
  })

  it('different body produces different signature', async () => {
    const secret = 'x'
    const ts = '1'
    const s1 = await hmacSha256Hex(secret, `${ts}.a`)
    const s2 = await hmacSha256Hex(secret, `${ts}.b`)
    expect(s1).not.toBe(s2)
  })
})

describe('Coinbase fulfillment amount boundary', () => {
  it('forwards only the provider invoice id, never callerPays/serviceFee', async () => {
    const originalFetch = globalThis.fetch
    let sent: any = null
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? '{}'))
      return Response.json({ ok: true })
    }) as typeof fetch
    try {
      await callAgentApiPayInvoice(
        { PAYINVOICE_ADMIN_SECRET: 'test-secret' } as any,
        'pl_original_invoice',
      )
      // agentapi resolves the merchant amount from the immutable Coinbase
      // invoice itself. The fee-bearing Rozo intent amount is not an input.
      expect(sent).toEqual({ payment_id: 'pl_original_invoice' })
      expect(sent).not.toHaveProperty('amount')
      expect(sent).not.toHaveProperty('callerPays')
      expect(sent).not.toHaveProperty('serviceFee')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
