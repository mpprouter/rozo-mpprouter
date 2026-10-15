/**
 * invoice-status with only a Coinbase id finds the Rozo order filed under the
 * link (the /btc/<id> reopen path) and relays an unpaid Lightning order's
 * BOLT11 so the checkout can show the same QR again. Before 2026-10-15 the
 * answer was rozoPayment: null for a payable Lightning order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleInvoiceStatus } from '../src/routes/webhook'
import type { Env } from '../src/index'

const SESSION_ID = 'paymentSession_89cb65aa-2343-4634-a62a-1f9eb51edb3d'
const ROZO_ID = '9f9a5d4b-2148-4f4b-8ccc-58dbe2cc7397'
const FUTURE = '2999-01-01T00:00:00.000Z'
// Synthetic BOLT11-shaped string, not a real invoice.
const BOLT11 = 'lnbc131740n1' + 'a'.repeat(120)

class FakeKV {
  store = new Map<string, string>()
  async get(key: string) { return this.store.get(key) ?? null }
  async put(key: string, value: string) { this.store.set(key, value) }
}

function env(kv: FakeKV = new FakeKV()): Env {
  return {
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: kv,
  } as unknown as Env
}

function lightningRow(status = 'payment_unpaid') {
  return {
    id: ROZO_ID,
    status,
    orderId: SESSION_ID,
    createdAt: '2026-10-15T13:16:20.852Z',
    expiresAt: FUTURE,
    paymentLink: 'https://invoice.rozo.ai/checkout?id=' + ROZO_ID,
    lnInvoice: BOLT11,
    source: { chainId: 'lightning', tokenSymbol: 'BTC', amount: '13274' },
    destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.61', receiverAddress: '0xDEST' },
    metadata: { webhook_secret: 'never-relayed' },
  }
}

const notFound = () =>
  new Response(JSON.stringify({ error: { code: 'paymentNotFound' } }), { status: 404 })

function mockFetch(opts: { orderRow?: any; byId?: any } = {}) {
  const hits: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    hits.push(u)
    if (u.includes('/next-api/payment-sessions/')) {
      return Response.json({
        paymentSessionId: SESSION_ID,
        status: 'PAYMENT_SESSION_STATUS_CREATED',
        amount: '10.50',
        asset: 'USDC',
        customerDisplay: { merchantName: 'OpenRouter, Inc' },
      })
    }
    if (u.includes(`/payments/order/merchant_openrouter/${encodeURIComponent(SESSION_ID)}`)) {
      return opts.orderRow ? Response.json(opts.orderRow) : notFound()
    }
    if (u.includes('/payments/order/')) return notFound()
    if (u.includes(`/payments/${ROZO_ID}`)) {
      return opts.byId ? Response.json(opts.byId) : notFound()
    }
    throw new Error('unexpected fetch ' + u)
  }) as any)
  return hits
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function status(query: string, e: Env = env()) {
  const res = await handleInvoiceStatus(
    new Request(`https://example.com/invoice-status?${query}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
    e,
  )
  return { res, body: (await res.json()) as any }
}

describe('invoice-status by Coinbase id finds the order behind the link', () => {
  it('relays the unpaid Lightning order and its BOLT11', async () => {
    const hits = mockFetch({ orderRow: lightningRow(), byId: lightningRow() })
    const { res, body } = await status(`payment_id=${SESSION_ID}`)
    expect(res.status).toBe(200)
    expect(body.rozo_payment_id).toBe(ROZO_ID)
    expect(body.rozoPayment).toMatchObject({
      id: ROZO_ID,
      status: 'payment_unpaid',
      lnInvoice: BOLT11,
      source: { chainId: 'lightning', tokenSymbol: 'BTC' },
    })
    expect(body.payin.confirmed).toBe(false)
    // The by-link scan ran under merchant_openrouter, then the full row by id.
    expect(hits.some((u) => u.includes('/payments/order/merchant_openrouter/'))).toBe(true)
    expect(hits.some((u) => u.endsWith(`/payments/${ROZO_ID}`))).toBe(true)
    // Secrets on the row never reach the caller.
    expect(JSON.stringify(body)).not.toContain('never-relayed')
  })

  it('answers rozoPayment: null when the link has no order (as before)', async () => {
    mockFetch()
    const { res, body } = await status(`payment_id=${SESSION_ID}`)
    expect(res.status).toBe(200)
    expect(body.rozo_payment_id).toBeNull()
    expect(body.rozoPayment).toBeNull()
    expect(body.coinbase.status).toBe('PAYMENT_SESSION_STATUS_CREATED')
  })

  it('does not relay the BOLT11 once the order is past unpaid', async () => {
    mockFetch({ orderRow: lightningRow('payment_started'), byId: lightningRow('payment_started') })
    const { body } = await status(`payment_id=${SESSION_ID}`)
    expect(body.rozo_payment_id).toBe(ROZO_ID)
    expect(body.rozoPayment.lnInvoice).toBeUndefined()
  })

  it('leaves an explicit rozo_payment_id lookup untouched (no by-link scan)', async () => {
    const hits = mockFetch({ byId: lightningRow() })
    const { body } = await status(`payment_id=${SESSION_ID}&rozo_payment_id=${ROZO_ID}`)
    expect(body.rozo_payment_id).toBe(ROZO_ID)
    expect(hits.some((u) => u.includes('/payments/order/'))).toBe(false)
  })

  it('skips the scan over existing-order\'s per-link budget (answer as before, no 429)', async () => {
    const kv = new FakeKV()
    const e = env(kv)
    const hits = mockFetch({ orderRow: lightningRow(), byId: lightningRow() })
    for (let i = 0; i < 20; i++) await status(`payment_id=${SESSION_ID}`, e)
    const before = hits.length
    const { res, body } = await status(`payment_id=${SESSION_ID}`, e)
    expect(res.status).toBe(200)
    expect(body.rozoPayment).toBeNull()
    expect(hits.slice(before).some((u) => u.includes('/payments/order/'))).toBe(false)
  })

  it('a scan that errors leaves the answer as before', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/next-api/payment-sessions/')) {
        return Response.json({ paymentSessionId: SESSION_ID, status: 'PAYMENT_SESSION_STATUS_CREATED', amount: '10.50', asset: 'USDC' })
      }
      return new Response('upstream down', { status: 503 })
    }) as any)
    const { res, body } = await status(`payment_id=${SESSION_ID}`)
    expect(res.status).toBe(200)
    expect(body.rozo_payment_id).toBeNull()
    expect(body.rozoPayment).toBeNull()
  })
})
