/**
 * - quote-invoice makes NO intents order lookup (2026-10-12: the lookup takes
 *   ~2.5s in production and pushed every quote to 1.5-2.1s; deploy rolled back).
 * - GET /existing-order: read-only summary of the order a link already has,
 *   found with the same lookup create-invoice uses (orderId = link id under
 *   merchant_openrouter for Coinbase and rozotest_; stripe_crypto_<cpis_*>
 *   under wallet_rozopay for Stripe).
 * - nativeMinUsd: per open native coin USD minimum, supportedSources unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import { classifyOrderState, findExistingOrder } from '../src/routes/existing-order'
import { handleExistingOrder } from '../src/routes/existing-order-endpoint'
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

const orderCalls = (hits: string[]) => hits.filter((h) => h.includes('/payments/order/'))

async function existing(params: Record<string, string>, env = makeEnv(), ip = '198.51.100.1') {
  const u = new URL('https://mpp.test/v1/services/rozo-agent-api/existing-order')
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  const res = await handleExistingOrder(
    new Request(u, { method: 'GET', headers: { 'CF-Connecting-IP': ip } }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any, res }
}

describe('quote-invoice makes no order lookup', () => {
  const ORDERS = {
    [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid'),
    [`wallet_rozopay/stripe_crypto_${STRIPE_KEY}`]: row('rozo-s', 'payment_unpaid'),
  }

  it('Coinbase quote: zero intents calls, no existingOrder fields', async () => {
    const hits = mockFetch(ORDERS)
    const { status, json } = await quote({ payment_id: LINK })
    expect(status).toBe(200)
    expect(orderCalls(hits)).toHaveLength(0)
    expect(json).not.toHaveProperty('existingOrder')
    expect(json).not.toHaveProperty('existingOrderUnknown')
  })

  it('test invoice quote: zero intents calls', async () => {
    const id = await signTestPaymentId(SECRET, 11, 'noquote1')
    const hits = mockFetch({ [`merchant_openrouter/${id}`]: row('rozo-t', 'payment_unpaid') })
    const { status, json } = await quote({ payment_id: id })
    expect(status).toBe(200)
    expect(orderCalls(hits)).toHaveLength(0)
    expect(json).not.toHaveProperty('existingOrder')
  })

  it('Stripe quote: zero intents calls', async () => {
    const hits = mockFetch(ORDERS)
    const { status, json } = await quote({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(orderCalls(hits)).toHaveLength(0)
    expect(json).not.toHaveProperty('existingOrder')
  })
})

describe('GET existing-order', () => {
  it('returns the existing order with only safe fields', async () => {
    mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    const { status, json, res } = await existing({ payment_id: LINK })
    expect(status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(json).toEqual({
      existingOrder: {
        rozoPaymentId: 'rozo-1',
        status: 'payment_unpaid',
        source: { chainId: '900', tokenSymbol: 'SOL' },
        expiresAt: FUTURE,
        state: 'payable',
        paid: false,
      },
      unknown: false,
    })
    expectNoSecrets(json)
  })

  it('accepts a Coinbase link URL', async () => {
    mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    const { json } = await existing({ link: `https://payments.coinbase.com/payment-links/${LINK}` })
    expect(json.existingOrder?.rozoPaymentId).toBe('rozo-1')
  })

  it('prefers payment_id over link', async () => {
    const hits = mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    const { json } = await existing({
      payment_id: LINK,
      link: 'https://payments.coinbase.com/payment-links/pl_other_from_url',
    })
    expect(json.existingOrder?.rozoPaymentId).toBe('rozo-1')
    expect(hits.some((h) => h.includes('pl_other_from_url'))).toBe(false)
  })

  it('prefers a funded sibling; retry slots are not read while the base order is live', async () => {
    const hits = mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_unpaid'),
      [`merchant_openrouter/${LINK}__contract`]: row('rozo-contract', 'payment_payin_completed'),
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry', 'payment_unpaid'),
    })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-contract', state: 'funded', paid: true })
    expect(orderCalls(hits)).toHaveLength(4)
    expect(hits.some((h) => h.includes('__retry'))).toBe(false)
  })

  it('base expired + live retry slot: returns the retry-slot order (create-invoice reuses it)', async () => {
    const hits = mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_expired', PAST),
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry2', 'payment_expired', PAST),
      [`merchant_openrouter/${LINK}__retry3`]: row('rozo-retry3', 'payment_unpaid'),
    })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-retry3', state: 'payable', paid: false })
    expect(json.unknown).toBe(false)
    expect(orderCalls(hits)).toHaveLength(9)
  })

  it('the production case: signed test id, expired base, live retry slot', async () => {
    const id = await signTestPaymentId(SECRET, 10, 'b643b2c0139de4db')
    mockFetch({
      [`merchant_openrouter/${id}`]: row('5a552b2c', 'payment_expired', PAST),
      [`merchant_openrouter/${id}__retry2`]: row('rozo-live', 'payment_unpaid'),
    })
    const { json } = await existing({ payment_id: id })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-live', state: 'payable' })
  })

  it('funded retry-slot order: funded, even next to an expired base', async () => {
    mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_expired', PAST),
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry2', 'payment_payin_completed'),
    })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-retry2', state: 'funded', paid: true })
  })

  it('no live order: an expired order with funding evidence wins over a newer ended one', async () => {
    const late = { ...row('rozo-base', 'payment_expired', PAST) }
    late.source = { ...late.source, txHash: '0xfeed' } as any
    mockFetch({
      [`merchant_openrouter/${LINK}`]: late,
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry2', 'payment_expired', PAST),
    })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-base', state: 'funded' })
  })

  it('no live order and no evidence: the newest order, ended', async () => {
    mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_expired', PAST),
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry2', 'payment_expired', PAST),
    })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-retry2', state: 'ended' })
  })

  it('a live classic order is preferred over a live contract sibling', async () => {
    const contract = { ...row('rozo-contract', 'payment_unpaid') }
    contract.source = { ...contract.source, receiverAddressContract: 'C_CONTRACT' } as any
    mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_unpaid'),
      [`merchant_openrouter/${LINK}__contract`]: contract,
    })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-base', state: 'payable' })
    expect(JSON.stringify(json)).not.toContain('C_CONTRACT')
  })

  it('an expired row with funding evidence is funded', async () => {
    const funded = { ...row('rozo-late', 'payment_expired', PAST) }
    funded.source = { ...funded.source, confirmedAt: '2026-10-10T00:00:00Z' } as any
    mockFetch({ [`merchant_openrouter/${LINK}`]: funded })
    const { json } = await existing({ payment_id: LINK })
    expect(json.existingOrder).toMatchObject({ state: 'funded', paid: true })
  })

  it('none: existingOrder null, unknown false', async () => {
    mockFetch({})
    const { status, json } = await existing({ payment_id: LINK })
    expect(status).toBe(200)
    expect(json).toEqual({ existingOrder: null, unknown: false })
  })

  it('any slot failure: unknown true', async () => {
    mockFetch({
      [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid'),
      [`merchant_openrouter/${LINK}__contract2`]: 'error',
    })
    const { status, json } = await existing({ payment_id: LINK })
    expect(status).toBe(200)
    expect(json).toEqual({ existingOrder: null, unknown: true })
  })

  it('a hanging lookup is cut at the timeout and reported unknown', async () => {
    mockFetch({ [`merchant_openrouter/${LINK}`]: 'hang' })
    const started = Date.now()
    const r = await findExistingOrder(makeEnv(), { provider: 'coinbase', linkId: LINK }, { timeoutMs: 50 })
    expect(r).toEqual({ kind: 'unknown' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('signed test id is looked up under merchant_openrouter', async () => {
    const id = await signTestPaymentId(SECRET, 11, 'existing1')
    mockFetch({ [`merchant_openrouter/${id}`]: row('rozo-test', 'payment_unpaid') })
    const { json } = await existing({ payment_id: id })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-test', state: 'payable' })
  })

  it('unsigned test id: 400, no intents call', async () => {
    const hits = mockFetch({})
    const { status } = await existing({ payment_id: 'rozotest_100_quoteq1_0000000000000000' })
    expect(status).toBe(400)
    expect(orderCalls(hits)).toHaveLength(0)
  })

  it('invalid id: 400, no intents call', async () => {
    const hits = mockFetch({})
    for (const bad of ['not-a-link', 'pl_bad/../x', 'cpis_bad-chars!']) {
      const { status } = await existing({ payment_id: bad })
      expect(status).toBe(400)
    }
    const missing = await existing({})
    expect(missing.status).toBe(400)
    expect(orderCalls(hits)).toHaveLength(0)
  })

  it('cpis_ payment_id is looked up directly as stripe_crypto_<cpis_*> under wallet_rozopay', async () => {
    const hits = mockFetch({ [`wallet_rozopay/stripe_crypto_${STRIPE_KEY}`]: row('rozo-stripe', 'payment_payout_completed') })
    const { json } = await existing({ payment_id: STRIPE_KEY })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-stripe', state: 'funded', paid: true })
    expectNoSecrets(json)
    expect(hits.some((h) => h.includes('payin_session'))).toBe(false)
  })

  it('Stripe link is resolved to its cpis_ key, then looked up', async () => {
    mockFetch({ [`wallet_rozopay/stripe_crypto_${STRIPE_KEY}`]: row('rozo-stripe', 'payment_unpaid') })
    const { json } = await existing({ link: STRIPE_URL })
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-stripe', state: 'payable' })
  })

  it('Stripe lookup failure: unknown true', async () => {
    mockFetch({ [`wallet_rozopay/stripe_crypto_${STRIPE_KEY}`]: 'error' })
    const { json } = await existing({ link: STRIPE_URL })
    expect(json).toEqual({ existingOrder: null, unknown: true })
  })

  it('Stripe resolve shares the total deadline: a hanging resolve gives unknown', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((() => new Promise<Response>(() => {})) as typeof fetch)
      const p = existing({ link: STRIPE_URL })
      await vi.advanceTimersByTimeAsync(9_100)
      const { status, json } = await p
      expect(status).toBe(200)
      expect(json).toEqual({ existingOrder: null, unknown: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a Stripe resolve that rejects after the deadline is observed (no unhandled rejection)', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((() =>
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('late')), 9_500))) as typeof fetch)
      const p = existing({ link: STRIPE_URL })
      await vi.advanceTimersByTimeAsync(9_100)
      expect((await p).json).toEqual({ existingOrder: null, unknown: true })
      await vi.advanceTimersByTimeAsync(1_000) // the late rejection fires here
    } finally {
      vi.useRealTimers()
    }
  })

  it('Stripe resolve rate limit: 429 + Retry-After in the endpoint shape', async () => {
    const hits = mockFetch({})
    const env = makeEnv()
    const ip = '203.0.113.9'
    await (env as any).MPP_STORE.put(
      `ratelimit:invoice-details:ip:${ip}`,
      JSON.stringify({ n: 1000, w: Date.now() }),
    )
    const { status, json, res } = await existing({ link: STRIPE_URL }, env, ip)
    expect(status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(json).toMatchObject({ code: 'RATE_LIMITED', existingOrder: null, unknown: true })
    expect(hits).toHaveLength(0)
  })

  it('over the per-link budget: 429 with unknown true and no intents call', async () => {
    const env = makeEnv()
    const hits = mockFetch({ [`merchant_openrouter/${LINK}`]: row('rozo-1', 'payment_unpaid') })
    for (let i = 0; i < 20; i++) {
      const { status } = await existing({ payment_id: LINK }, env, '203.0.113.7')
      expect(status).toBe(200)
    }
    const before = orderCalls(hits).length
    const { status, json, res } = await existing({ payment_id: LINK }, env, '203.0.113.7')
    expect(status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(json).toMatchObject({ code: 'RATE_LIMITED', existingOrder: null, unknown: true })
    expect(orderCalls(hits).length).toBe(before)
  })

  it('rejects non-GET', async () => {
    const res = await handleExistingOrder(new Request('https://mpp.test/x', { method: 'POST' }), makeEnv())
    expect(res.status).toBe(405)
  })
})

describe('existing-order timing (intents GET ~2.5s in production)', () => {
  const SLOW_MS = 2_500

  /** Order lookups resolve after SLOW_MS; records when each one started. */
  function mockSlowOrders(orders: OrderMap, delays: Record<string, number> = {}) {
    const started: Array<{ key: string; at: number }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const m = /\/payments\/order\/([^/]+)\/([^/?]+)$/.exec(u)
      if (!m) return new Response('unexpected', { status: 500 })
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
      started.push({ key, at: Date.now() })
      const hit = orders[key]
      const delay = delays[key] ?? SLOW_MS
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          if (hit === 'hang') return
          resolve(hit ? Response.json(hit) : new Response('not found', { status: 404 }))
        }, delay)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        })
      })
    }) as typeof fetch)
    return started
  }

  afterEach(() => vi.useRealTimers())

  it('two sequential ~2.5s rounds (expired base, live retry) finish inside the 9s deadline', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    mockSlowOrders({
      [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_expired', PAST),
      [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry', 'payment_unpaid'),
    })
    const p = existing({ payment_id: LINK })
    await vi.advanceTimersByTimeAsync(5_100)
    const { json } = await p
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-retry', state: 'payable' })
    expect(json.unknown).toBe(false)
    expect(Date.now() - t0).toBeLessThan(9_000)
  })

  it('the retry round starts when the base slot answers, not after the contract slots', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    const started = mockSlowOrders(
      {
        [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_expired', PAST),
        [`merchant_openrouter/${LINK}__retry2`]: row('rozo-retry', 'payment_unpaid'),
      },
      {
        [`merchant_openrouter/${LINK}`]: 500, // base answers fast
        [`merchant_openrouter/${LINK}__contract`]: 4_000,
        [`merchant_openrouter/${LINK}__contract2`]: 4_000,
        [`merchant_openrouter/${LINK}__contract3`]: 4_000,
      },
    )
    let done = false
    const p = existing({ payment_id: LINK }).then((r) => { done = true; return r })
    await vi.advanceTimersByTimeAsync(600)
    const retryStarts = started.filter((s) => s.key.includes('__retry'))
    expect(retryStarts).toHaveLength(5)
    for (const r of retryStarts) expect(r.at - t0).toBeLessThan(1_000)
    // Done once the slowest slot (contract, 4s) answers: overlapped, not 4s + 2.5s.
    await vi.advanceTimersByTimeAsync(3_500)
    expect(done).toBe(true)
    const { json } = await p
    expect(json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-retry' })
  })

  it('no retry round while the base order is live', async () => {
    vi.useFakeTimers()
    const started = mockSlowOrders({ [`merchant_openrouter/${LINK}`]: row('rozo-base', 'payment_unpaid') })
    const p = existing({ payment_id: LINK })
    await vi.advanceTimersByTimeAsync(2_600)
    expect((await p).json.existingOrder).toMatchObject({ rozoPaymentId: 'rozo-base' })
    expect(started.some((s) => s.key.includes('__retry'))).toBe(false)
  })

  it('a lookup still running at 9s is cut and reported unknown', async () => {
    vi.useFakeTimers()
    mockSlowOrders({ [`merchant_openrouter/${LINK}`]: 'hang' })
    let done = false
    const p = existing({ payment_id: LINK }).then((r) => { done = true; return r })
    await vi.advanceTimersByTimeAsync(8_900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect((await p).json).toEqual({ existingOrder: null, unknown: true })
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
