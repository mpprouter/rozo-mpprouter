import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleInvoiceStatus } from '../src/routes/webhook'
import type { Env } from '../src/index'

const SESSION_ID = 'paymentSession_03155b8e-a9c1-4d6f-88f2-7752f6904266'
const ROZO_ID = '4b9fefce-fc50-4fd1-8983-6698b8501331'

// The Stripe branch reads its fulfillment record through the atomic-store DO.
// An empty store makes `loadStripeRecordForStatus` return null, which is the
// real shape when no fulfillment has been seeded yet.
function atomicStoreStub() {
  const stub = {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname
      if (path === '/read') {
        return new Response(JSON.stringify({ value: null, version: 0 }), { status: 200 })
      }
      return new Response('unsupported', { status: 500 })
    },
  }
  return { idFromName: () => ({}), get: () => stub }
}

function env(): Env {
  return {
    ROZO_INTENTS_API_KEY: 'test-key',
    ATOMIC_STORE: atomicStoreStub(),
    MPP_STORE: {
      get: vi.fn().mockResolvedValue(null),
    },
  } as unknown as Env
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Coinbase v3 invoice status', () => {
  it('infers paymentSession_* from a Rozo order and reports capture success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: ROZO_ID,
        status: 'payment_payout_completed',
        orderId: SESSION_ID,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        paymentSessionId: SESSION_ID,
        status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
        amount: '1.05',
        asset: 'USD',
        expiresAt: '2026-07-27T00:00:00Z',
        customerDisplay: { merchantName: 'OpenRouter, Inc' },
      }), { status: 200 }))

    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.pl_id).toBe(SESSION_ID)
    expect(body.coinbase).toMatchObject({
      protocolVersion: 'v3',
      id: SESSION_ID,
      status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
      settled: true,
    })
    expect(fetchMock.mock.calls[1][0]).toContain(
      `/next-api/payment-sessions/${SESSION_ID}`,
    )
  })

  it('does not treat authorization pending as paid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      paymentSessionId: SESSION_ID,
      status: 'PAYMENT_SESSION_STATUS_AUTHORIZATION_PENDING',
      amount: '1.05',
      asset: 'USD',
    }), { status: 200 }))

    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?payment_id=${SESSION_ID}`),
      env(),
    )
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.coinbase.settled).toBe(false)
  })
})

describe('server-confirmed payin signal', () => {
  // Regression: a Stripe checkout page showed "Payment Complete" for an order
  // that was never paid. Its only server-truth signal was `coinbase.settled`,
  // which is always null on the Stripe branch, so the UI fell back to a
  // client-side wallet callback. `payin` gives both branches one field that is
  // derived from upstream state only.
  const STRIPE_KEY = 'cpis_1UB2YMLGazr34H47Ku8lrOwc'
  const STRIPE_ORDER = `stripe_crypto_${STRIPE_KEY}`

  function rozoRow(over: Record<string, unknown> = {}) {
    return {
      id: ROZO_ID,
      status: 'payment_unpaid',
      orderId: STRIPE_ORDER,
      source: { amount: '31.76', amountReceived: null, txHash: null, confirmedAt: null },
      destination: { amount: '31.76', txHash: null, confirmedAt: null },
      ...over,
    }
  }

  it('reports payin.confirmed=false for an unpaid Stripe order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(rozoRow()), { status: 200 }),
    )
    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?invoice_key=${STRIPE_KEY}&rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    const body = (await response.json()) as any
    expect(response.status).toBe(200)
    expect(body.provider).toBe('stripe_crypto')
    // Present-and-null, so a caller can tell "no Coinbase side" from "missing".
    expect(body.coinbase).toBeNull()
    expect(body.payin).toEqual({ confirmed: false, confirmedAt: null, via: null })
  })

  it('confirms a Stripe payin once the chain confirmation lands', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          rozoRow({
            status: 'payment_payin_completed',
            source: {
              amount: '31.76',
              amountReceived: '31.76',
              txHash: '0xabc',
              confirmedAt: '2026-09-02T01:20:00Z',
            },
          }),
        ),
        { status: 200 },
      ),
    )
    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?invoice_key=${STRIPE_KEY}&rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    const body = (await response.json()) as any
    expect(body.payin).toEqual({
      confirmed: true,
      confirmedAt: '2026-09-02T01:20:00Z',
      via: 'rozo_payin',
    })
  })

  it('confirms a Coinbase payin from provider settlement', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: ROZO_ID, status: 'payment_unpaid', orderId: SESSION_ID }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            paymentSessionId: SESSION_ID,
            status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
            amount: '1.05',
            asset: 'USD',
          }),
          { status: 200 },
        ),
      )
    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    const body = (await response.json()) as any
    expect(body.payin).toMatchObject({ confirmed: true, via: 'coinbase_settlement' })
  })
})
