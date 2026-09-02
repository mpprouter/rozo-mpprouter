/**
 * invoice-details endpoint: input validation, provider routing, and the
 * per-IP / per-invoice fixed-window rate limiter.
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

  it('throttles the 61st request from the same IP within the window', async () => {
    const env = makeEnv()
    for (let i = 0; i < 60; i++) {
      const r = await handleInvoiceDetails(req({ url: linkN(i) }, '9.9.9.9'), env)
      expect(r.status).toBe(200) // allowed, not throttled
    }
    const throttled = await handleInvoiceDetails(req({ url: linkN(99) }, '9.9.9.9'), env)
    expect(throttled.status).toBe(429)
    const j = (await throttled.json()) as any
    expect(j.code).toBe('RATE_LIMITED')
    expect(j.scope).toBe('ip')
    // The user-facing string must not leak internal bucket names.
    expect(j.error).not.toContain('per-IP')
    expect(throttled.headers.get('Retry-After')).toBeTruthy()
  })

  it('does not throttle a different IP', async () => {
    const env = makeEnv()
    for (let i = 0; i < 60; i++) {
      await handleInvoiceDetails(req({ url: linkN(i) }, '8.8.8.8'), env)
    }
    // Different IP starts fresh
    const other = await handleInvoiceDetails(req({ url: linkN(0) }, '7.7.7.7'), env)
    expect(other.status).toBe(200)
  })

  it('applies the per-invoice limit to Coinbase too, but only past 30 hits', async () => {
    const env = makeEnv()
    const url = 'https://payments.coinbase.com/payment-links/pl_hammered'
    // Per-IP (10/min) would trip first, so give each request its own IP: the
    // per-invoice bucket is now keyed by invoice AND IP, which means a single
    // IP can never exhaust another visitor's budget for the same link.
    for (let i = 0; i < 30; i++) {
      const r = await handleInvoiceDetails(req({ url }, `5.5.5.${i}`), env)
      expect(r.status).toBe(200)
    }
    // Same IP as the first request: its own per-invoice bucket still has 29
    // left, so it is NOT throttled by the other 29 visitors' traffic.
    const stillOk = await handleInvoiceDetails(req({ url }, '5.5.5.0'), env)
    expect(stillOk.status).toBe(200)
  })

  it('throttles the 31st hit on one invoice from the same IP, before the per-IP ceiling', async () => {
    const env = makeEnv()
    const url = 'https://payments.coinbase.com/payment-links/pl_hammered2'
    for (let i = 0; i < 30; i++) {
      const r = await handleInvoiceDetails(req({ url }, '6.6.6.6'), env)
      expect(r.status).toBe(200)
    }
    const throttled = await handleInvoiceDetails(req({ url }, '6.6.6.6'), env)
    expect(throttled.status).toBe(429)
    const j = (await throttled.json()) as any
    // `scope` is the assertion that matters: it proves the INVOICE bucket
    // tripped and not the per-IP ceiling, which is what makes this bucket
    // reachable rather than dead code.
    expect(j.scope).toBe('invoice')
    expect(j.code).toBe('RATE_LIMITED')
    expect(j.error).not.toContain('per-session')
    expect(throttled.headers.get('Retry-After')).toBeTruthy()
  })

  it('resets on a fixed window boundary, not on inactivity', async () => {
    const env = makeEnv()
    const url = 'https://payments.coinbase.com/payment-links/pl_window'
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(start)
    // Exhaust the per-IP budget (60/min) inside one window.
    for (let i = 0; i < 60; i++) {
      await handleInvoiceDetails(req({ url: `${url}${i}` }, '4.4.4.4'), env)
    }
    // 59s later, still inside the window even though traffic never stopped.
    clock.mockReturnValue(start + 59_000)
    const blocked = await handleInvoiceDetails(req({ url }, '4.4.4.4'), env)
    expect(blocked.status).toBe(429)
    // 61s after the FIRST request the window rolls over, regardless of the
    // continuous traffic that kept resetting the KV TTL.
    clock.mockReturnValue(start + 61_000)
    const allowed = await handleInvoiceDetails(req({ url }, '4.4.4.4'), env)
    expect(allowed.status).toBe(200)
    clock.mockRestore()
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
