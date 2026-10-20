/**
 * create-invoice attaches a Server-Timing stage breakdown to every response
 * (success and early error) and relays the upstream intents Server-Timing as
 * X-Upstream-Server-Timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice, relayableUpstreamTiming } from '../src/routes/create-invoice'
import { withCors } from '../src/utils/cors'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

function makeEnv(): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    ATOMIC_STORE: makeAtomicStoreMock(),
    INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
  } as unknown as Env
}

let createHeaders: Record<string, string>
/** Artificial latency (ms) for the Stripe session reads and the intents create. */
let stripeDelayMs = 0
let intentsDelayMs = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

beforeEach(() => {
  createHeaders = { 'content-type': 'application/json' }
  stripeDelayMs = 0
  intentsDelayMs = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/resume_payin_session')) {
      await sleep(stripeDelayMs)
      return Response.json({ sessionId: 'cpis_st', clientSecret: 'cs', publishableKey: 'pk_live_test', mode: 'pay' })
    }
    if (u.includes('/payin_session')) {
      await sleep(stripeDelayMs)
      return Response.json({
        id: 'cpis_st',
        state: 'checkout',
        business_name: 'Test Merchant',
        merchant: 'acct_test',
        payment_details: { amount: 1000, currency: 'usd' },
        supported_currencies: [
          {
            id: 'usdc.base',
            chain_id: 8453,
            currency_network: 'base',
            mainnet: true,
            asset_code: 'usdc',
            currency_minor_units: 6,
            contract_address: BASE_USDC.toLowerCase(),
            payment_options: ['wallet_connect'],
          },
        ],
        valid_before: '2999-01-01T00:00:00.000Z',
      })
    }
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({ invoice: { amount: '10.5' }, merchant: 'OpenRouter, Inc', linkId: 'paymentSession_st_test' }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      await sleep(intentsDelayMs)
      return new Response(
        JSON.stringify({ id: 'rozo-pay-st', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
        { status: 200, headers: createHeaders },
      )
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

function createReq(body: string) {
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', origin: 'https://checkout.rozo.ai' },
    body,
  })
}

const COINBASE_BODY = JSON.stringify({
  payment_id: 'paymentSession_st_test',
  source: { chainId: '1500', tokenSymbol: 'USDC' },
})

function stageNames(header: string | null): string[] {
  return (header ?? '').split(',').map((p) => p.trim().split(';')[0])
}

function stageDurations(header: string | null): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (header ?? '').split(',')) {
    const [name, dur] = part.trim().split(';dur=')
    out[name] = Number(dur)
  }
  return out
}

describe('create-invoice Server-Timing', () => {
  it('is set on a success response with every stage the create path went through', async () => {
    createHeaders['Server-Timing'] = 'db;dur=12, handler;dur=40'
    const res = await handleCreateInvoice(createReq(COINBASE_BODY), makeEnv())
    expect(res.status).toBe(200)
    const names = stageNames(res.headers.get('Server-Timing'))
    expect(names).toEqual(['gate', 'quote', 'slots', 'upstream', 'post', 'total'])
    expect(res.headers.get('Server-Timing')).toMatch(/^gate;dur=\d+, .*total;dur=\d+$/)
    expect(res.headers.get('X-Upstream-Server-Timing')).toBe('db;dur=12, handler;dur=40')
  })

  it('omits X-Upstream-Server-Timing when upstream sent none', async () => {
    const res = await handleCreateInvoice(createReq(COINBASE_BODY), makeEnv())
    expect(res.status).toBe(200)
    expect(res.headers.get('Server-Timing')).toBeTruthy()
    expect(res.headers.has('X-Upstream-Server-Timing')).toBe(false)
  })

  it('is set on an early 400 (bad JSON body)', async () => {
    const res = await handleCreateInvoice(createReq('{not json'), makeEnv())
    expect(res.status).toBe(400)
    expect(stageNames(res.headers.get('Server-Timing'))).toEqual(['gate', 'total'])
  })

  it('survives withCors and is exposed to browsers', async () => {
    createHeaders['Server-Timing'] = 'db;dur=3'
    const req = createReq(COINBASE_BODY)
    const res = withCors(req, await handleCreateInvoice(req, makeEnv()))
    expect(res.headers.get('Server-Timing')).toContain('total;dur=')
    expect(res.headers.get('X-Upstream-Server-Timing')).toBe('db;dur=3')
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim())
    expect(exposed).toContain('server-timing')
    expect(exposed).toContain('x-upstream-server-timing')
  })

  it('Stripe: upstream measures only the intents call, not the Stripe session resolution', async () => {
    stripeDelayMs = 60 // two sequential Stripe reads, ~120 ms total
    intentsDelayMs = 20
    const body = JSON.stringify({ url: 'https://crypto.stripe.com/pay/CDMTimingBlob_ABC123xyz' })
    const res = await handleCreateInvoice(createReq(body), makeEnv())
    expect(res.status).toBe(200)
    const header = res.headers.get('Server-Timing')
    expect(stageNames(header)).toEqual(['gate', 'stripe_resolve', 'stripe_lookup', 'upstream', 'post', 'total'])
    const d = stageDurations(header)
    expect(d.stripe_resolve).toBeGreaterThanOrEqual(100)
    expect(d.upstream).toBeGreaterThanOrEqual(15)
    expect(d.upstream).toBeLessThan(100)
  })

  it('X-Upstream-Server-Timing drops Cloudflare edge entries and is capped at 512 chars', async () => {
    createHeaders['Server-Timing'] = 'cfL4;desc="?proto=TCP&rtt=1", db;dur=12, cfEdge;dur=3, handler;dur=40;desc="create"'
    const res = await handleCreateInvoice(createReq(COINBASE_BODY), makeEnv())
    expect(res.headers.get('X-Upstream-Server-Timing')).toBe('db;dur=12, handler;dur=40;desc="create"')

    expect(relayableUpstreamTiming(null)).toBeNull()
    expect(relayableUpstreamTiming('cfL4;dur=1, cfEdge;dur=2')).toBeNull()
    const long = Array.from({ length: 100 }, (_, i) => `stage${i};dur=${i}`).join(', ')
    const capped = relayableUpstreamTiming(long)!
    expect(capped.length).toBe(512)
    expect(long.startsWith(capped)).toBe(true)
  })
})
