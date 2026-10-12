/**
 * quote-invoice additions:
 * - existingOrder: read-only summary of the order a link already has, found
 *   with the same lookup create-invoice uses (orderId = link id under
 *   merchant_openrouter for Coinbase and rozotest_; stripe_crypto_<cpis_*>
 *   under wallet_rozopay for Stripe). Omitted when absent, failed or slow.
 * - nativeMinUsd: per open native coin USD minimum, supportedSources unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import { classifyOrderState, findExistingOrder } from '../src/routes/existing-order'
import { NATIVE_MIN_USD, nativeMinUsd, parseNativeSources, signTestPaymentId } from '../src/routes/native-sources'
import type { Env } from '../src/index'

const SECRET = 'test-link-secret'
const LINK = 'pl_existing_order_test'
const STRIPE_KEY = 'cpis_1UIMzfDSZgxV3MJKGYmbSlu0'
const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMQARoXBLOBTUOQ'

class FakeKV {
  store = new Map<string, string>()
  async get(key: string) { return this.store.get(key) ?? null }
  async put(key: string, value: string) { this.store.set(key, value) }
}

function makeEnv(extra: Record<string, string> = {}): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    ROZO_TEST_LINK_SECRET: SECRET,
    MPP_STORE: new FakeKV(),
    ...extra,
  } as unknown as Env
}

const FUTURE = '2999-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'

// A full upstream row, including fields that must never reach the quote.
function row(id: string, status: string, expiresAt = FUTURE) {
  return {
    id,
    status,
    expiresAt,
    source: {
      chainId: 900,
      tokenSymbol: 'sol',
      receiverAddress: 'RECEIVER_ADDR_SECRET',
      amount: '0.0123',
      paymentLink: 'lnbc1secretbolt11',
    },
    destination: { receiverAddress: '0xDEST_SECRET', amount: '1.00' },
    metadata: { token: 'tok_secret', receipt: 'rcpt_secret' },
  }
}

type OrderMap = Record<string, any | 'error' | 'hang'>

function mockFetch(orders: OrderMap) {
  const hits: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    hits.push(u)
    if (u.includes('agentapi.rozo.ai/quote-invoice')) {
      return Response.json({ invoice: { amount: '10.00' }, merchant: 'OpenRouter, Inc', linkId: LINK })
    }
    if (u.includes('resume_payin_session')) {
      return Response.json({ sessionId: STRIPE_KEY, clientSecret: 'cs', publishableKey: 'pk' })
    }
    if (u.includes('payin_session')) {
      return Response.json({
        id: STRIPE_KEY, merchant: 'acct_x', business_name: 'Command Code', state: 'checkout',
        payment_details: { amount: 136, currency: 'usd' },
        supported_currencies: [{ id: 'usdc.base', currency_network: 'base', chain_id: 8453, asset_code: 'usdc', contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payment_options: ['wallet_connect'] }],
        transaction_details: {}, valid_before: '1789980699',
      })
    }
    const m = /\/payments\/order\/([^/]+)\/([^/?]+)$/.exec(u)
    if (m) {
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
      const hit = orders[key]
      if (hit === 'error') return new Response('boom', { status: 500 })
      if (hit === 'hang') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (hit) return Response.json(hit)
      return new Response('not found', { status: 404 })
    }
    return new Response('unexpected ' + u, { status: 500 })
  }) as typeof fetch)
  return hits
}

async function quote(body: Record<string, unknown>, env = makeEnv()) {
  const res = await handleQuoteInvoice(
    new Request('https://mpp.test/quote-invoice', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

function expectNoSecrets(json: any) {
  const s = JSON.stringify(json.existingOrder)
  for (const bad of ['RECEIVER_ADDR_SECRET', '0xDEST_SECRET', 'lnbc1secretbolt11', 'tok_secret', 'rcpt_secret', '0.0123']) {
    expect(s).not.toContain(bad)
  }
  expect(Object.keys(json.existingOrder).sort()).toEqual(['expiresAt', 'paid', 'rozoPaymentId', 'source', 'state', 'status'])
}

afterEach(() => vi.restoreAllMocks())

describe('quote-invoice existingOrder: Coinbase', () => {
  it('includes the existing unpaid order with only safe fields', async () => {
    mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    const { status, json } = await quote({ payment_id: LINK })
    expect(status).toBe(200)
    expect(json.existingOrder).toEqual({
      rozoPaymentId: 'rozo-1',
      status: 'payment_unpaid',
      source: { chainId: '900', tokenSymbol: 'SOL' },
      expiresAt: FUTURE,
      state: 'payable',
      paid: false,
    })
    expect(json).not.toHaveProperty('existingOrderUnknown')
    expectNoSecrets(json)
  })

  it('marks paid for a status past unpaid, preferring it over a live unpaid sibling', async () => {
    mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_unpaid'),
      [`merchant_openrouter/${LINK}__contract`]: row('rozo-contract', 'payment_payin_completed'),
    })
    const { json } = await quote({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-contract', state: 'funded', paid: true })
  })

  it('does not scan retry slots (bounded fan-out): base + contract slots only', async () => {
    const hits = mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-old', 'payment_expired', PAST),
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry', 'payment_unpaid'),
    })
    const { json } = await quote({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-old', state: 'ended', paid: false })
    expect(hits.filter((h) => h.includes('/payments/order/'))).toHaveLength(4)
    expect(hits.some((h) => h.includes('__retry'))).toBe(false)
  })

  it('an expired row with funding evidence is funded, not ended', async () => {
    const funded = { ...row('rozo-late', 'payment_expired', PAST) }
    funded.source = { ...funded.source, confirmedAt: '2026-10-10T00:00:00Z' } as any
    mockFetch({ [`merchant_openrouter/${LINK}`]: funded })
    const { json } = await quote({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-late', state: 'funded', paid: true })
  })

  it('prefers the explicit payment_id over the URL-derived id', async () => {
    const hits = mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    const { json } = await quote({
      payment_id: LINK,
      url: 'https://payments.coinbase.com/payment-links/pl_other_from_url',
    })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-1' })
    expect(hits.some((h) => h.includes('pl_other_from_url'))).toBe(false)
  })

  it('never sends a malformed id to the intents API', async () => {
    const hits = mockFetch({})
    const r = await findExistingOrder(makeEnv(), { provider: 'coinbase', linkId: 'not-a-link/../x' })
    expect(r).toEqual({ kind: 'none' })
    const s = await findExistingOrder(makeEnv(), { provider: 'stripe_crypto', invoiceKey: 'bogus' })
    expect(s).toEqual({ kind: 'none' })
    expect(hits).toHaveLength(0)
  })

  it('over the lookup budget: no intents call, existingOrderUnknown, quote still 200', async () => {
    const env = makeEnv()
    const hits = mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    const req = () => handleQuoteInvoice(
      new Request('https://mpp.test/quote-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({ payment_id: LINK }),
      }),
      env,
    )
    for (let i = 0; i < 20; i++) {
      const body = (await (await req()).json()) as any
      expect(body.existingOrder?.rozoPaymentId).toBe('rozo-1')
    }
    const before = hits.filter((h) => h.includes('/payments/order/')).length
    const res = await req()
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(body.existingOrderUnknown).toBe(true)
    expect(body).not.toHaveProperty('existingOrder')
    expect(hits.filter((h) => h.includes('/payments/order/')).length).toBe(before)
  })

  it('omits existingOrder when the link has no order', async () => {
    mockFetch({})
    const { status, json } = await quote({ payment_id: LINK })
    expect(status).toBe(200)
    expect(json).not.toHaveProperty('existingOrder')
  })

  it('any slot lookup failure gives existingOrderUnknown, and the quote still succeeds', async () => {
    mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid'),
      [`merchant_openrouter/${LINK}__contract2`]: 'error',
    })
    const { status, json } = await quote({ payment_id: LINK })
    expect(status).toBe(200)
    expect(json.linkId).toBe(LINK)
    expect(json).not.toHaveProperty('existingOrder')
    expect(json.existingOrderUnknown).toBe(true)
  })

  it('a lookup that hangs past the timeout is unknown, not none', async () => {
    mockFetch({ [`merchant_openrouter/${LINK}`]: 'hang' })
    const started = Date.now()
    const r = await findExistingOrder(makeEnv(), { provider: 'coinbase', linkId: LINK }, { timeoutMs: 50 })
    expect(r).toEqual({ kind: 'unknown' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('the quote waits at most ~1.5s for a hanging lookup and flags it unknown', async () => {
    mockFetch({ [`merchant_openrouter/${LINK}`]: 'hang' })
    const started = Date.now()
    const { status, json } = await quote({ payment_id: LINK })
    const took = Date.now() - started
    expect(status).toBe(200)
    expect(json.existingOrderUnknown).toBe(true)
    expect(took).toBeGreaterThanOrEqual(1400)
    expect(took).toBeLessThan(2500)
  })
})

describe('quote-invoice existingOrder: test invoice and Stripe', () => {
  it('looks up a rozotest_ invoice under merchant_openrouter with the test id', async () => {
    const id = await signTestPaymentId(SECRET, 11, 'existing1')
    const hits = mockFetch({ [`merchant_openrouter/${id}`]: row('rozo-test', 'payment_unpaid') })
    const { status, json } = await quote({ payment_id: id })
    expect(status).toBe(200)
    expect(json.testInvoice).toBe(true)
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-test', state: 'payable', paid: false })
    expectNoSecrets(json)
    expect(hits.some((h) => h.includes('agentapi.rozo.ai'))).toBe(false)
  })

  it('test invoice without an order has no existingOrder', async () => {
    const id = await signTestPaymentId(SECRET, 11, 'existing2')
    mockFetch({})
    const { json } = await quote({ payment_id: id })
    expect(json).not.toHaveProperty('existingOrder')
  })

  it('looks up a Stripe invoice as stripe_crypto_<cpis_*> under wallet_rozopay', async () => {
    mockFetch({ [`wallet_rozopay/stripe_crypto_${STRIPE_KEY}`]: row('rozo-stripe', 'payment_payout_completed') })
    const { status, json } = await quote({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(json.provider).toBe('stripe_crypto')
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-stripe', status: 'payment_payout_completed', state: 'funded', paid: true })
    expectNoSecrets(json)
  })

  it('Stripe lookup failure gives existingOrderUnknown', async () => {
    mockFetch({ [`wallet_rozopay/stripe_crypto_${STRIPE_KEY}`]: 'error' })
    const { status, json } = await quote({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(json).not.toHaveProperty('existingOrder')
    expect(json.existingOrderUnknown).toBe(true)
  })

  it('Stripe link without an order has neither field', async () => {
    mockFetch({})
    const { json } = await quote({ url: STRIPE_URL })
    expect(json).not.toHaveProperty('existingOrder')
    expect(json).not.toHaveProperty('existingOrderUnknown')
  })
})

describe('classifyOrderState', () => {
  const base = (status: string, expiresAt = FUTURE, extra: any = {}) => ({ id: 'x', status, expiresAt, source: {}, ...extra })
  it('payable only when unpaid, unexpired and unfunded', () => {
    expect(classifyOrderState(base('payment_unpaid'))).toBe('payable')
    expect(classifyOrderState(base('payment_unpaid', PAST))).toBe('ended')
    expect(classifyOrderState(base('payment_unpaid', FUTURE, { source: { amountReceived: '0.5' } }))).toBe('funded')
  })
  it('funded on any funding evidence, even when expired', () => {
    expect(classifyOrderState(base('payment_expired', PAST, { source: { txHash: '0xabc' } }))).toBe('funded')
    expect(classifyOrderState(base('payment_expired', PAST, { amountMismatch: { got: '1' } }))).toBe('funded')
    expect(classifyOrderState(base('payment_payin_completed'))).toBe('funded')
  })
  it('ended for expired without evidence, refunded, bounced, failed', () => {
    expect(classifyOrderState(base('payment_expired', PAST))).toBe('ended')
    expect(classifyOrderState(base('payment_refunded', PAST, { refundTxHash: '0xr' }))).toBe('ended')
    expect(classifyOrderState(base('payment_bounced'))).toBe('ended')
    expect(classifyOrderState(base('payment_failed'))).toBe('ended')
  })
})

describe('quote-invoice nativeMinUsd', () => {
  it('mirrors the rozo-intents-api built-in native minimums', () => {
    expect(NATIVE_MIN_USD).toEqual({ '1': 1, '8453': 0.1, '42161': 0.1, '56': 0.1, '137': 0.1, '900': 1 })
  })

  it('lists only open coins, keyed by chain and symbol', () => {
    expect(nativeMinUsd(parseNativeSources('ETH@8453,SOL@900'))).toEqual({ '8453': { ETH: 0.1 }, '900': { SOL: 1 } })
    expect(nativeMinUsd(new Set())).toEqual({})
  })

  it('test invoice reports every native coin minimum and keeps supportedSources unchanged', async () => {
    const id = await signTestPaymentId(SECRET, 11, 'mins0001')
    mockFetch({})
    const { json } = await quote({ payment_id: id })
    expect(json.nativeMinUsd).toEqual({
      '1': { ETH: 1 }, '8453': { ETH: 0.1 }, '42161': { ETH: 0.1 },
      '56': { BNB: 0.1 }, '137': { POL: 0.1 }, '900': { SOL: 1 },
    })
    expect(json.supportedSources['900']).toEqual(['USDC', 'USDT', 'SOL'])
  })

  it('real quote reports minimums for NATIVE_SOURCES coins only', async () => {
    mockFetch({})
    const { json } = await quote({ payment_id: LINK }, makeEnv({ NATIVE_SOURCES: 'SOL@900' }))
    expect(json.nativeMinUsd).toEqual({ '900': { SOL: 1 } })
    expect(json.supportedSources['900']).toEqual(['USDC', 'USDT', 'SOL'])
  })
})
