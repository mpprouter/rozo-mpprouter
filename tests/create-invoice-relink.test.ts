/**
 * Coinbase create-invoice after the link's earlier Rozo order expired.
 *
 * Upstream keeps an orderId taken forever, so an unpaid order that expired
 * used to dead-end its Coinbase link: every later create answered 409
 * LINK_USED_OR_EXPIRED while the Coinbase link itself was still payable
 * (production, 2026-10-06). Now a fresh order is created under the next
 * deterministic `__retryN` slot, but only when every earlier order is
 * provably unfunded (relink-guard.ts): closed as payment_expired, no funding
 * evidence on the row, and tx-match's on-chain scan of every deposit address
 * (rotated-away legs included) answers nothing_found.
 *
 * The fetch mock models upstream uniqueness: a create with a taken orderId
 * answers 409 orderIdConflict, and creates are stored so concurrent callers
 * observe each other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { baseLinkIdOf, retryOrderIds } from '../src/mpp/contract-variant'
import { rowFundingEvidence } from '../src/routes/relink-guard'
import type { Env } from '../src/index'

const LINK = 'paymentSession_11111111-2222-3333-4444-555555555555'
const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

function makeEnv(): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
  } as unknown as Env
}

/** Upstream orders keyed by orderId (models the unique (app_id, order_id) index). */
let orders: Map<string, any>
let createCalls: string[]
let scanCalls: string[]
/** tx-match answer per Rozo order id; default nothing_found for that order. */
let scanAnswer: (id: string) => Response
/** Quote upstream answer. */
let quoteAnswer: () => Response
/** Status GET /payments/:id returns, by Rozo id (post-create re-check). */
let statusOverride: Map<string, string>
let nextId = 1
/** Delay (ms) inserted before each create so concurrent callers interleave. */
let createDelay = 0

function scanBody(id: string, verdict: string, status = 'payment_expired') {
  return Response.json({
    query_kind: 'order_id',
    tx_transfers: null,
    orders: [{ order_id: id, status, verdict, findings: [] }],
  })
}

function installFetchMock() {
  orders = new Map()
  createCalls = []
  scanCalls = []
  statusOverride = new Map()
  nextId = 1
  createDelay = 0
  scanAnswer = (id) => scanBody(id, 'nothing_found')
  quoteAnswer = () =>
    Response.json({ invoice: { amount: '10.5' }, merchant: 'OpenRouter, Inc', linkId: LINK })
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) return quoteAnswer()
    if (u.includes('/tx-match')) {
      const q = new URL(u).searchParams.get('q') ?? ''
      scanCalls.push(q)
      return scanAnswer(q)
    }
    if (u.includes('/payments/order/')) {
      const oid = decodeURIComponent(u.split('/').pop() ?? '')
      const row = orders.get(oid)
      return row ? Response.json(row) : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST' && !u.includes('/checkout')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (createDelay) await new Promise((r) => setTimeout(r, createDelay))
      createCalls.push(body.orderId)
      if (orders.has(body.orderId)) {
        return new Response(JSON.stringify({ error: 'orderIdConflict' }), { status: 409 })
      }
      const row = {
        id: `rozo-new-${nextId++}`,
        orderId: body.orderId,
        status: 'payment_unpaid',
        paymentLink: 'https://pay.rozo.ai/new',
        expiresAt: FUTURE,
        source: { chainId: body.source.chainId, tokenSymbol: body.source.tokenSymbol, amount: body.source.amount },
        metadata: body.metadata,
      }
      orders.set(body.orderId, row)
      return Response.json(row)
    }
    if (/\/payments\/[^/]+$/.test(u)) {
      const id = decodeURIComponent(u.split('/').pop() ?? '')
      const row = [...orders.values()].find((r) => r.id === id)
      if (!row) return new Response('not found', { status: 404 })
      return Response.json({ ...row, status: statusOverride.get(id) ?? row.status })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

function seedOrder(orderId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: `old-${orderId.slice(-8)}`,
    orderId,
    status: 'payment_expired',
    expiresAt: PAST,
    refundStatus: 'none',
    paymentLink: 'https://pay.rozo.ai/old',
    source: {
      chainId: '900',
      tokenSymbol: 'USDC',
      amount: '10.5',
      txHash: null,
      amountReceived: null,
      senderAddress: null,
      confirmedAt: null,
    },
    destination: { txHash: null, confirmedAt: null },
    ...overrides,
  }
  orders.set(orderId, row)
  return row
}

async function create(env: Env = makeEnv(), body: Record<string, unknown> = {}) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payment_id: LINK, source: { chainId: '8453', tokenSymbol: 'USDC' }, ...body }),
    }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

beforeEach(() => installFetchMock())
afterEach(() => vi.restoreAllMocks())

describe('re-order slots', () => {
  it('every retry slot normalizes back to the link id', () => {
    for (const id of retryOrderIds(LINK)) expect(baseLinkIdOf(id)).toBe(LINK)
    expect(retryOrderIds('pl_x')).toEqual([
      'pl_x__retry2', 'pl_x__retry3', 'pl_x__retry4', 'pl_x__retry5', 'pl_x__retry6',
    ])
    expect(baseLinkIdOf('pl_x__retry7')).toBe('pl_x__retry7')
    expect(baseLinkIdOf('pl_x__retry2_more')).toBe('pl_x__retry2_more')
  })
})

describe('Coinbase link whose earlier order expired', () => {
  it('expired + provably unfunded -> a fresh order under __retry2', async () => {
    seedOrder(LINK)
    const { status, json } = await create()
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.reused).toBe(false)
    expect(createCalls).toEqual([`${LINK}__retry2`])
    expect(json.replacesExpiredPaymentIds).toEqual([orders.get(LINK).id])
    // The guard scanned the old order on chain, by its Rozo id.
    expect(scanCalls).toEqual([orders.get(LINK).id])
    // The new order still names the real Coinbase link for settlement.
    expect(orders.get(`${LINK}__retry2`).metadata.coinbasePaymentLinkId).toBe(LINK)
  })

  it('the next create reuses the live re-order instead of minting another', async () => {
    seedOrder(LINK)
    const env = makeEnv()
    const first = await create(env)
    expect(first.status).toBe(200)
    const second = await create(env)
    expect(second.status).toBe(200)
    expect(second.json.reused).toBe(true)
    expect(second.json.rozoPaymentId).toBe(first.json.rozoPaymentId)
    expect(createCalls).toEqual([`${LINK}__retry2`])
  })

  it('base and __retry2 both expired unfunded -> __retry3, both guarded', async () => {
    const a = seedOrder(LINK)
    const b = seedOrder(`${LINK}__retry2`)
    const { status } = await create()
    expect(status).toBe(200)
    expect(createCalls).toEqual([`${LINK}__retry3`])
    expect(scanCalls.sort()).toEqual([a.id, b.id].sort())
  })

  it.each([
    ['source.txHash', { source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.5', txHash: '0xabc' } }],
    ['source.amountReceived', { source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.5', amountReceived: '3' } }],
    ['source.senderAddress', { source: { chainId: '900', tokenSymbol: 'USDC', amount: '10.5', senderAddress: 'Sender111' } }],
    ['refundStatus', { refundStatus: 'pending' }],
    ['bounceCode', { bounceCode: 'underpaid' }],
    ['merchantDeliveredAt', { merchantDeliveredAt: PAST }],
  ])('expired but the row records funds (%s) -> 409 ORDER_ALREADY_ACTIVE, no order', async (_k, o) => {
    seedOrder(LINK, o)
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.reason).toBe('previous_order_funded')
    expect(json.rozoPaymentId).toBe(orders.get(LINK).id)
    expect(createCalls).toEqual([])
    expect(scanCalls).toEqual([])
  })

  it.each(['funds_on_other_chain', 'funds_on_expected_chain', 'swept_unattributed', 'funds_in_other_token'])(
    'expired, row clean, but the on-chain scan (rotated legs) finds %s -> 409 ORDER_ALREADY_ACTIVE',
    async (verdict) => {
      seedOrder(LINK)
      scanAnswer = (id) => scanBody(id, verdict)
      const { status, json } = await create()
      expect(status).toBe(409)
      expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
      expect(json.reason).toBe('previous_order_funds_found')
      expect(createCalls).toEqual([])
    },
  )

  it('one of two expired orders is funded -> blocked, even if the other is clean', async () => {
    seedOrder(LINK)
    const funded = seedOrder(`${LINK}__retry2`)
    scanAnswer = (id) => scanBody(id, id === funded.id ? 'funds_on_other_chain' : 'nothing_found')
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.rozoPaymentId).toBe(funded.id)
    expect(createCalls).toEqual([])
  })

  it.each([
    ['rate limited', () => new Response(JSON.stringify({ error: 'RATE_LIMITED' }), { status: 429 })],
    ['scan outage', () => new Response('boom', { status: 500 })],
    ['network error', () => { throw new Error('down') }],
    ['no order in the answer', () => Response.json({ orders: [] })],
    ['answer for another order', () => scanBody('someone-else', 'nothing_found')],
  ])('scan unverifiable (%s) -> 409 PAYMENT_EXPIRED unconfirmed, no order', async (_k, answer) => {
    seedOrder(LINK)
    scanAnswer = answer as any
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.code).toBe('PAYMENT_EXPIRED')
    expect(json.error.code).toBe('PAYMENT_EXPIRED')
    expect(json.confirmed).toBe(false)
    expect(json.reason).toBe('previous_order_unverifiable')
    expect(json.message).toMatch(/do not pay again/)
    expect(createCalls).toEqual([])
  })

  it('scan sees a status change (late payment) -> blocked', async () => {
    seedOrder(LINK)
    scanAnswer = (id) => scanBody(id, 'already_paid', 'payment_payin_completed')
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(createCalls).toEqual([])
    expect(json.confirmed).toBe(false)
  })

  it('past expiresAt but upstream has not closed it (payment_unpaid) -> PAYMENT_EXPIRED unconfirmed, no scan, no order', async () => {
    seedOrder(LINK, { status: 'payment_unpaid' })
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.code).toBe('PAYMENT_EXPIRED')
    expect(json.confirmed).toBe(false)
    expect(json.reason).toBe('previous_order_not_closed')
    expect(scanCalls).toEqual([])
    expect(createCalls).toEqual([])
  })

  it.each(['payment_payin_completed', 'payment_payout_completed', 'payment_refunded', 'payment_bounced'])(
    'an earlier order at %s (any slot) -> ORDER_ALREADY_ACTIVE, no order',
    async (st) => {
      seedOrder(LINK)
      seedOrder(`${LINK}__retry2`, { status: st, id: 'paid-r2' })
      const { status, json } = await create()
      expect(status).toBe(409)
      expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
      expect(json.rozoPaymentId).toBe('paid-r2')
      expect(createCalls).toEqual([])
    },
  )

  it('a live base order is reused (unchanged) and no retry slot is read', async () => {
    seedOrder(LINK, { status: 'payment_unpaid', expiresAt: FUTURE, id: 'live-base' })
    const lookups: string[] = []
    const inner = (globalThis.fetch as any).getMockImplementation()
    ;(globalThis.fetch as any).mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) lookups.push(decodeURIComponent(u.split('/').pop()))
      return inner(input, init)
    })
    const { status, json } = await create()
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe('live-base')
    expect(createCalls).toEqual([])
    expect(lookups.some((id) => id.includes('__retry'))).toBe(false)
  })

  it('a live re-order (__retry3) is reused over the expired ones', async () => {
    seedOrder(LINK)
    seedOrder(`${LINK}__retry2`)
    seedOrder(`${LINK}__retry3`, { status: 'payment_unpaid', expiresAt: FUTURE, id: 'live-r3' })
    const { status, json } = await create()
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe('live-r3')
    expect(createCalls).toEqual([])
    expect(scanCalls).toEqual([])
  })

  it('a live contract-mode sibling blocks a second order for a no-intent caller (reused instead)', async () => {
    seedOrder(LINK)
    seedOrder(`${LINK}__contract`, {
      status: 'payment_unpaid',
      expiresAt: FUTURE,
      id: 'live-contract',
      source: { chainId: '1500', tokenSymbol: 'USDC', amount: '10.5', receiverAddressContract: 'CCONTRACT' },
    })
    const { status, json } = await create(makeEnv(), { source: { chainId: '1500', tokenSymbol: 'USDC' } })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe('live-contract')
    expect(json.intentMismatch).toBe(true)
    expect(createCalls).toEqual([])
  })

  it('upstream link already paid -> PAYMENT_ALREADY_PAID, no scan, no order', async () => {
    seedOrder(LINK)
    quoteAnswer = () =>
      new Response(
        JSON.stringify({ code: 'LINK_USED_OR_EXPIRED', detail: 'payment session is not payable: PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' }),
        { status: 409 },
      )
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.code).toBe('PAYMENT_ALREADY_PAID')
    expect(createCalls).toEqual([])
    expect(scanCalls).toEqual([])
  })

  it('upstream link expired -> LINK_USED_OR_EXPIRED, no order', async () => {
    seedOrder(LINK)
    quoteAnswer = () => new Response(JSON.stringify({ error: 'expired' }), { status: 410 })
    const { status, json } = await create()
    expect(status).toBe(410)
    expect(json.code).toBe('LINK_USED_OR_EXPIRED')
    expect(createCalls).toEqual([])
  })

  it('every re-order slot used -> PAYMENT_EXPIRED confirmed (new merchant link needed)', async () => {
    seedOrder(LINK)
    for (const id of retryOrderIds(LINK)) seedOrder(id)
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.code).toBe('PAYMENT_EXPIRED')
    expect(json.confirmed).toBe(true)
    expect(createCalls).toEqual([])
  })

  it('late payment revives the old order between guard and create -> new order withheld', async () => {
    const old = seedOrder(LINK)
    statusOverride.set(old.id, 'payment_payin_completed')
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.rozoPaymentId).toBe(old.id)
    expect(json.paymentLink).toBeUndefined()
    // The abandoned order exists upstream but was never handed out.
    expect(createCalls).toEqual([`${LINK}__retry2`])
  })

  it('post-create re-check unreadable -> fail closed (502), new order not handed out', async () => {
    const old = seedOrder(LINK)
    statusOverride.set(old.id, 'UNREADABLE')
    const inner = (globalThis.fetch as any).getMockImplementation()
    ;(globalThis.fetch as any).mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (/\/payments\/old-/.test(u)) return new Response('boom', { status: 503 })
      return inner(input, init)
    })
    const { status, json } = await create()
    expect(status).toBe(502)
    expect(json.code).toBe('INTENTS_API_FAILED')
    expect(json.paymentLink).toBeUndefined()
  })

  it('slot race loser re-checks the replaced orders before reusing the winner', async () => {
    const old = seedOrder(LINK)
    // A concurrent caller already created __retry2 after our scan; meanwhile a
    // late payment revived the old order.
    const inner = (globalThis.fetch as any).getMockImplementation()
    let scannedOnce = false
    ;(globalThis.fetch as any).mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/tx-match') && !scannedOnce) {
        scannedOnce = true
        orders.set(`${LINK}__retry2`, {
          id: 'winner', orderId: `${LINK}__retry2`, status: 'payment_unpaid', expiresAt: FUTURE,
          paymentLink: 'https://pay.rozo.ai/w', source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.5' },
        })
        statusOverride.set(old.id, 'payment_payin_completed')
      }
      return inner(input, init)
    })
    const { status, json } = await create()
    expect(status).toBe(409)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.rozoPaymentId).toBe(old.id)
  })

  it('two creates at once -> exactly one order, both callers get it', async () => {
    seedOrder(LINK)
    createDelay = 5
    const env = makeEnv()
    const [a, b] = await Promise.all([create(env), create(env)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.json.rozoPaymentId).toBe(b.json.rozoPaymentId)
    const made = [...orders.keys()].filter((k) => k !== LINK)
    expect(made).toEqual([`${LINK}__retry2`])
    expect([a.json.reused, b.json.reused].sort()).toEqual([false, true])
  })

  it('a contract-intent and a classic create at once -> still one fresh order', async () => {
    seedOrder(LINK)
    createDelay = 5
    const env = makeEnv()
    const stellar = { source: { chainId: '1500', tokenSymbol: 'USDC' } }
    const [a, b] = await Promise.all([
      create(env, { ...stellar, intent: 'stellar_payin_contracts' }),
      create(env, stellar),
    ])
    const made = [...orders.keys()].filter((k) => k !== LINK)
    expect(made).toHaveLength(1)
    expect(made[0]).toBe(`${LINK}__retry2`)
    // Whoever lost either reuses the winner or is told to retry; never a 2nd order.
    for (const r of [a, b]) expect([200, 409]).toContain(r.status)
  })

  it('two first-ever creates at once -> one order under the base id, both callers get it', async () => {
    createDelay = 5
    const env = makeEnv()
    const [a, b] = await Promise.all([create(env), create(env)])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.json.rozoPaymentId).toBe(b.json.rozoPaymentId)
    expect([...orders.keys()]).toEqual([LINK])
  })

  it('first-ever create is unchanged: base orderId, no scan', async () => {
    const { status, json } = await create()
    expect(status).toBe(200)
    expect(createCalls).toEqual([LINK])
    expect(scanCalls).toEqual([])
    expect(json.replacesExpiredPaymentIds).toBeUndefined()
  })
})

describe('rowFundingEvidence', () => {
  it('a clean expired row has none', () => {
    expect(rowFundingEvidence({ status: 'payment_expired', refundStatus: 'none', source: { amountReceived: '0' }, destination: {} })).toBeNull()
  })
  it('flags snake_case raw fields too', () => {
    expect(rowFundingEvidence({ source_tx_hash: '0x1' })).toBe('source.txHash')
  })
})
