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
      // Only a Coinbase id: the by-link order scan runs next; no order here.
      .mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'paymentNotFound' } }), { status: 404 }))

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

describe('invoice-status current pay-in route', () => {
  it('exposes the current source chain, token and deposit address (stale-tab check)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: ROZO_ID,
        status: 'payment_unpaid',
        orderId: SESSION_ID,
        source: {
          chainId: '1',
          tokenSymbol: 'USDC',
          receiverAddress: '0xAbC0000000000000000000000000000000000001',
          amount: '1.06',
          tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response('nf', { status: 404 }))

    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    const body = await response.json() as any
    expect(response.status).toBe(200)
    expect(body.rozoPayment.source).toMatchObject({
      chainId: '1',
      tokenSymbol: 'USDC',
      receiverAddress: '0xAbC0000000000000000000000000000000000001',
      amount: '1.06',
    })
    // Still an allow-list: unrelated upstream fields do not leak through.
    expect(body.rozoPayment.source.tokenAddress).toBeUndefined()
  })
})

describe('invoice-status upstream read ordering (plan 2)', () => {
  function deferred() {
    let resolve!: (r: Response) => void
    const promise = new Promise<Response>((r) => { resolve = r })
    return { promise, resolve }
  }
  const rozoRow = {
    id: ROZO_ID,
    status: 'payment_unpaid',
    orderId: SESSION_ID,
  }
  const sessionBody = {
    paymentSessionId: SESSION_ID,
    status: 'PAYMENT_SESSION_STATUS_AUTHORIZATION_PENDING',
    amount: '1.05',
    asset: 'USD',
  }
  const isCoinbase = (url: string) => url.includes('/next-api/')

  it('starts the Coinbase and Rozo reads together when both ids are given', async () => {
    const cb = deferred()
    const rozo = deferred()
    const started: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: any) => {
      const url = String(input instanceof Request ? input.url : input)
      started.push(isCoinbase(url) ? 'coinbase' : 'rozo')
      return isCoinbase(url) ? cb.promise : rozo.promise
    })

    const pending = handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?payment_id=${SESSION_ID}&rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    // Let the handler run up to its first await on the network.
    await new Promise((r) => setTimeout(r, 0))
    // Neither fetch has resolved, yet both have started.
    expect(started.sort()).toEqual(['coinbase', 'rozo'])

    rozo.resolve(new Response(JSON.stringify(rozoRow), { status: 200 }))
    cb.resolve(new Response(JSON.stringify(sessionBody), { status: 200 }))
    const response = await pending
    const body = (await response.json()) as any
    expect(response.status).toBe(200)
    expect(body.pl_id).toBe(SESSION_ID)
    expect(body.coinbase).toMatchObject({ protocolVersion: 'v3', id: SESSION_ID })
    expect(body.rozoPayment).toBeTruthy()
    // No extra Coinbase read: the explicit one already answered.
    expect(started).toHaveLength(2)
  })

  it('still answers 200 with the Rozo side when the parallel Coinbase read fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (isCoinbase(url)) return new Response('boom', { status: 503 })
      return new Response(JSON.stringify(rozoRow), { status: 200 })
    })
    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?payment_id=${SESSION_ID}&rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    const body = (await response.json()) as any
    expect(response.status).toBe(200)
    expect(body.coinbase).toBeNull()
    expect(body.rozoPayment).toBeTruthy()
  })

  it('keeps the rozo-only lookup serial: Rozo first, then the derived Coinbase id', async () => {
    const rozo = deferred()
    const started: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: any) => {
      const url = String(input instanceof Request ? input.url : input)
      if (isCoinbase(url)) {
        started.push('coinbase')
        return Promise.resolve(new Response(JSON.stringify(sessionBody), { status: 200 }))
      }
      started.push('rozo')
      return rozo.promise
    })

    const pending = handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?rozo_payment_id=${ROZO_ID}`),
      env(),
    )
    await new Promise((r) => setTimeout(r, 0))
    // The Coinbase id is not known until the Rozo row arrives.
    expect(started).toEqual(['rozo'])

    rozo.resolve(new Response(JSON.stringify(rozoRow), { status: 200 }))
    const response = await pending
    const body = (await response.json()) as any
    expect(started).toEqual(['rozo', 'coinbase'])
    expect(response.status).toBe(200)
    expect(body.pl_id).toBe(SESSION_ID)
  })

  it('leaves the Stripe branch order unchanged: reconcile and record read before the Rozo GET', async () => {
    const STRIPE_KEY = 'cpis_1UB2YMLGazr34H47Ku8lrOwc'
    const events: string[] = []
    const storeStub = {
      async fetch(request: Request) {
        events.push(`store:${new URL(request.url).pathname}`)
        return new Response(JSON.stringify({ value: null, version: 0 }), { status: 200 })
      },
    }
    const e = {
      ...env(),
      ATOMIC_STORE: { idFromName: () => ({}), get: () => storeStub },
    } as unknown as Env
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input)
      events.push(isCoinbase(url) ? 'coinbase' : 'rozo')
      return new Response(
        JSON.stringify({ ...rozoRow, orderId: `stripe_crypto_${STRIPE_KEY}` }),
        { status: 200 },
      )
    })
    const response = await handleInvoiceStatus(
      new Request(`https://example.com/invoice-status?invoice_key=${STRIPE_KEY}&rozo_payment_id=${ROZO_ID}`),
      e,
    )
    expect(response.status).toBe(200)
    expect(events).not.toContain('coinbase')
    const rozoAt = events.indexOf('rozo')
    expect(rozoAt).toBeGreaterThan(0)
    // Every store access (reconcile + record read) happened before the GET.
    expect(events.slice(0, rozoAt).every((x) => x.startsWith('store:'))).toBe(true)
    expect(events.slice(rozoAt + 1).filter((x) => x === 'rozo')).toHaveLength(0)
  })
})
