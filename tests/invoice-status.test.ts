import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleInvoiceStatus } from '../src/routes/webhook'
import type { Env } from '../src/index'

const SESSION_ID = 'paymentSession_03155b8e-a9c1-4d6f-88f2-7752f6904266'
const ROZO_ID = '4b9fefce-fc50-4fd1-8983-6698b8501331'

function env(): Env {
  return {
    ROZO_INTENTS_API_KEY: 'test-key',
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
