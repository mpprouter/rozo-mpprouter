import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMerchantSettlement } from '../src/routes/webhook'
import type { Env } from '../src/index'

const SESSION_ID = 'paymentSession_03155b8e-a9c1-4d6f-88f2-7752f6904266'
const PL_ID = 'pl_01abcdefghjkmnpqrstvwxyz0'
const ROZO_ID = '4b9fefce-fc50-4fd1-8983-6698b8501331'

function atomicStoreStub() {
  const stub = {
    async fetch(request: Request) {
      if (new URL(request.url).pathname === '/read') return new Response(JSON.stringify({ value: null, version: 0 }), { status: 200 })
      return new Response('unsupported', { status: 500 })
    },
  }
  return { idFromName: () => ({}), get: () => stub }
}

function env(routerRecord: unknown = null): Env {
  return {
    ROZO_INTENTS_API_KEY: 'test-key',
    ATOMIC_STORE: atomicStoreStub(),
    MPP_STORE: { get: vi.fn().mockResolvedValue(routerRecord ? JSON.stringify(routerRecord) : null) },
  } as unknown as Env
}

const rozo = (orderId: string) => new Response(JSON.stringify({ id: ROZO_ID, status: 'payment_payout_completed', orderId }), { status: 200 })
const v3 = (status: string) => new Response(JSON.stringify({ paymentSessionId: SESSION_ID, status, customerDisplay: { merchantName: 'OpenRouter, Inc' } }), { status: 200 })

afterEach(() => vi.restoreAllMocks())

describe('resolveMerchantSettlement', () => {
  it('Coinbase v3 settles only on CAPTURE_SUCCEEDED', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(SESSION_ID)).mockResolvedValueOnce(v3('PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED'))
    expect(await resolveMerchantSettlement(env(), ROZO_ID)).toEqual({
      found: true, settled: true, status: 'coinbase_v3:PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED', merchant: 'OpenRouter, Inc',
    })
  })

  it.each(['PAYMENT_SESSION_STATUS_AUTHORIZED', 'PAYMENT_SESSION_STATUS_AUTHORIZATION_ACCEPTED', 'PAYMENT_SESSION_STATUS_PENDING'])(
    'Coinbase v3 %s is not settled, even with a router `paid` record',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(SESSION_ID)).mockResolvedValueOnce(v3(status))
      const r = await resolveMerchantSettlement(env({ status: 'paid' }), ROZO_ID)
      expect(r.settled).toBe(false)
      expect(r.status).toBe(`coinbase_v3:${status}`)
    },
  )

  it('Coinbase v3 lookup failure is not settled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(SESSION_ID)).mockResolvedValueOnce(new Response('x', { status: 500 }))
    expect((await resolveMerchantSettlement(env({ status: 'paid' }), ROZO_ID)).settled).toBe(false)
  })

  it('legacy v1 link: settled via usage count or router `paid`', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(PL_ID))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: PL_ID, status: 'ACTIVE', usageCount: 1, maxUsage: 1 }), { status: 200 }))
    expect(await resolveMerchantSettlement(env(), ROZO_ID)).toMatchObject({ settled: true, status: 'coinbase_v1:settled' })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(PL_ID)).mockResolvedValueOnce(new Response('x', { status: 404 }))
    expect(await resolveMerchantSettlement(env({ status: 'paid' }), ROZO_ID)).toMatchObject({ settled: true, status: 'router:paid' })
  })

  it('legacy v1 link with payin only (router paying, link unused) is not settled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(PL_ID))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: PL_ID, status: 'ACTIVE', usageCount: 0, maxUsage: 1 }), { status: 200 }))
    expect(await resolveMerchantSettlement(env({ status: 'paying' }), ROZO_ID)).toMatchObject({ settled: false, status: 'router:paying' })
  })

  it('unknown payment is not found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404 }))
    expect(await resolveMerchantSettlement(env(), ROZO_ID)).toMatchObject({ found: false, settled: false })
  })

  it('Stripe order without a paid record is not settled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo('stripe_crypto_cpis_abc123'))
    expect(await resolveMerchantSettlement(env(), ROZO_ID)).toMatchObject({ settled: false, status: 'stripe_router:missing' })
  })
})
