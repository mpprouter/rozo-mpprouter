/**
 * invoice-details endpoint: input validation, provider routing, and the
 * per-IP / per-session fixed-window rate limiter.
 *
 * Stripe resolution itself performs live network I/O, so these tests exercise
 * the guard rails BEFORE resolution (bad body, unsupported host, rate limits)
 * without hitting Stripe.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { handleInvoiceDetails } from '../src/routes/invoice-details'

// Coinbase resolution performs live network I/O too, so stub the upstream with
// a payable v1 link. These tests are about the guard rails, not normalization
// (that is covered in invoice-provider-coinbase.test.ts).
const COINBASE_LINK = {
  id: 'pl_abc',
  status: 'ACTIVE',
  maxAmount: '1.00',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  networkId: 8453,
  preApprovalExpiry: String(Math.floor(Date.parse('2099-01-01T00:00:00Z') / 1000)),
  maxUsage: 1,
  usageCount: 0,
  merchant: { name: 'Test Merchant' },
  fiat: { amount: '1.00', currency: 'USD' },
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(COINBASE_LINK), { status: 200 }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('200 with a normalized invoice for Coinbase (no longer 501)', async () => {
    const r = await handleInvoiceDetails(
      req({ url: 'https://payments.coinbase.com/payment-links/pl_abc' }),
      makeEnv(),
    )
    expect(r.status).toBe(200)
    const j = (await r.json()) as any
    expect(j.ok).toBe(true)
    // Same envelope and same normalized shape the Stripe branch returns.
    expect(j.invoice.provider).toBe('coinbase')
    expect(j.invoice.invoiceKey).toBe('pl_abc')
    expect(j.invoice.stablecoinAmountAtomic).toBe('1000000')
    expect(j.invoice.payable).toBe(true)
    expect(j.invoice.lockFingerprint).toMatch(/^sha256:/)
  })
})

describe('handleInvoiceDetails — per-IP rate limit', () => {
  // A DISTINCT invoice per request, so the per-IP limit is what trips, not the
  // (stricter) per-invoice limit.
  const linkN = (n: number) => `https://payments.coinbase.com/payment-links/pl_ratelimit${n}`

  it('throttles the 11th request from the same IP within the window', async () => {
    const env = makeEnv()
    for (let i = 0; i < 10; i++) {
      const r = await handleInvoiceDetails(req({ url: linkN(i) }, '9.9.9.9'), env)
      expect(r.status).toBe(200) // allowed, not throttled
    }
    const throttled = await handleInvoiceDetails(req({ url: linkN(99) }, '9.9.9.9'), env)
    expect(throttled.status).toBe(429)
    const j = (await throttled.json()) as any
    expect(j.error).toContain('per-IP')
  })

  it('does not throttle a different IP', async () => {
    const env = makeEnv()
    for (let i = 0; i < 10; i++) {
      await handleInvoiceDetails(req({ url: linkN(i) }, '8.8.8.8'), env)
    }
    // Different IP starts fresh
    const other = await handleInvoiceDetails(req({ url: linkN(0) }, '7.7.7.7'), env)
    expect(other.status).toBe(200)
  })

  it('applies the per-invoice limit to Coinbase too (4th hit on one link)', async () => {
    const env = makeEnv()
    const url = 'https://payments.coinbase.com/payment-links/pl_hammered'
    for (let i = 0; i < 3; i++) {
      const r = await handleInvoiceDetails(req({ url }, '5.5.5.5'), env)
      expect(r.status).toBe(200)
    }
    const throttled = await handleInvoiceDetails(req({ url }, '5.5.5.5'), env)
    expect(throttled.status).toBe(429)
    const j = (await throttled.json()) as any
    expect(j.error).toContain('per-session')
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
    // Not a 429 — the request proceeds (fails open) and resolves normally.
    expect(r.status).toBe(200)
  })
})
