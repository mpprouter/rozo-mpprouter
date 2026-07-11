/**
 * invoice-details endpoint: input validation, provider routing, and the
 * per-IP / per-session fixed-window rate limiter.
 *
 * Stripe resolution itself performs live network I/O, so these tests exercise
 * the guard rails BEFORE resolution (bad body, unsupported host, rate limits)
 * without hitting Stripe.
 */

import { describe, it, expect } from 'vitest'
import { handleInvoiceDetails } from '../src/routes/invoice-details'

// Minimal in-memory KV honoring get/put with TTL ignored (tests run in a
// single window). Enough to drive the fixed-window counter.
class FakeKV {
  store = new Map<string, string>()
  async get(key: string) {
    return this.store.get(key) ?? null
  }
  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

function makeEnv() {
  return { MPP_STORE: new FakeKV() } as any
}

function req(body: unknown, ip = '1.2.3.4') {
  return new Request('https://router.test/v1/services/rozo-agent-api/invoice-details', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  })
}

describe('handleInvoiceDetails — input validation', () => {
  it('405 on non-POST', async () => {
    const r = await handleInvoiceDetails(
      new Request('https://router.test/x', { method: 'GET' }),
      makeEnv(),
    )
    expect(r.status).toBe(405)
  })

  it('400 on invalid JSON', async () => {
    const bad = new Request('https://router.test/x', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
      body: '{not json',
    })
    const r = await handleInvoiceDetails(bad, makeEnv())
    expect(r.status).toBe(400)
  })

  it('400 when url missing', async () => {
    const r = await handleInvoiceDetails(req({}), makeEnv())
    expect(r.status).toBe(400)
    const j = (await r.json()) as any
    expect(j.ok).toBe(false)
    expect(j.supported_url_families).toBeDefined()
  })

  it('400 for an unsupported/look-alike host (never resolves it)', async () => {
    const r = await handleInvoiceDetails(
      req({ url: 'https://crypto.stripe.com.evil.com/pay/CDM' }),
      makeEnv(),
    )
    expect(r.status).toBe(400)
    const j = (await r.json()) as any
    expect(j.error).toContain('Unsupported')
  })

  it('501 for Coinbase (detail served elsewhere in Phase A)', async () => {
    const r = await handleInvoiceDetails(
      req({ url: 'https://payments.coinbase.com/payment-links/pl_abc' }),
      makeEnv(),
    )
    expect(r.status).toBe(501)
    const j = (await r.json()) as any
    expect(j.provider).toBe('coinbase')
  })
})

describe('handleInvoiceDetails — per-IP rate limit', () => {
  it('throttles the 11th request from the same IP within the window', async () => {
    const env = makeEnv()
    // Use a Coinbase URL so we exercise the limiter without hitting Stripe.
    const url = 'https://payments.coinbase.com/payment-links/pl_ratelimit'
    let last: Response | null = null
    for (let i = 0; i < 10; i++) {
      last = await handleInvoiceDetails(req({ url }, '9.9.9.9'), env)
      expect(last.status).toBe(501) // allowed (Coinbase 501, but not throttled)
    }
    const throttled = await handleInvoiceDetails(req({ url }, '9.9.9.9'), env)
    expect(throttled.status).toBe(429)
    const j = (await throttled.json()) as any
    expect(j.error).toContain('per-IP')
  })

  it('does not throttle a different IP', async () => {
    const env = makeEnv()
    const url = 'https://payments.coinbase.com/payment-links/pl_x'
    for (let i = 0; i < 10; i++) {
      await handleInvoiceDetails(req({ url }, '8.8.8.8'), env)
    }
    // Different IP starts fresh
    const other = await handleInvoiceDetails(req({ url }, '7.7.7.7'), env)
    expect(other.status).toBe(501)
  })

  it('fails open when KV throws (never takes down the endpoint)', async () => {
    const brokenKV = {
      async get() {
        throw new Error('kv down')
      },
      async put() {
        throw new Error('kv down')
      },
    }
    const env = { MPP_STORE: brokenKV } as any
    const r = await handleInvoiceDetails(
      req({ url: 'https://payments.coinbase.com/payment-links/pl_abc' }),
      env,
    )
    // Not a 429 — request proceeds (fails open) and hits the Coinbase 501.
    expect(r.status).toBe(501)
  })
})
