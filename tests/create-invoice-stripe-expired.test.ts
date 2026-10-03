/**
 * Stripe create-invoice when the Rozo order for the invoice already exists.
 *
 * One Stripe invoice maps to exactly one Rozo order (founder, 2026-10-03).
 * When that order expired, create-invoice must NOT open a second order (that
 * invited a second payment that can never be settled twice, see the reverted
 * #217). It answers 409 PAYMENT_EXPIRED with a plain message telling the payer
 * to create a new payment on the merchant site. A paid order keeps answering
 * ORDER_ALREADY_ACTIVE + alreadyPaid.
 *
 * The fetch mock models upstream uniqueness: a POST with a taken orderId
 * answers 409 orderIdConflict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { STRIPE_PAYMENT_EXPIRED_MESSAGE } from '../src/routes/create-invoice'
import type { Env } from '../src/index'

const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMTestBlob_EXPIRED123'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const INVOICE_KEY = 'cpis_expired123'
const BASE_ORDER_ID = `stripe_crypto_${INVOICE_KEY}`
const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

function makeKvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

function makeDoStub() {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  const stub = {
    async fetch(req: Request) {
      const url = new URL(req.url)
      const b: any = await req.json()
      if (url.pathname === '/read') {
        return Response.json({
          value: store.get(b.key) ?? null,
          version: versions.get(b.key) ?? 0,
        })
      }
      const cur = versions.get(b.key) ?? 0
      if (cur !== b.expectedVersion) {
        return Response.json({ ok: false, value: store.get(b.key) ?? null, version: cur })
      }
      if (b.op === 'set') store.set(b.key, b.value)
      else store.delete(b.key)
      versions.set(b.key, b.expectedVersion + 1)
      return Response.json({ ok: true })
    },
  }
  return { idFromName: (n: string) => ({ name: n }), get: () => stub }
}

function makeEnv(): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: makeKvStub(),
    ATOMIC_STORE: makeDoStub(),
    INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    BASE_RPC_URL: undefined,
  } as unknown as Env
}

/** Upstream orders by orderId (models the unique (app_id, order_id) index). */
let orders: Map<string, any>
let createCalls: string[]
let lookupFails = false
let raceOnCreate = false
let payInvoiceCalls = 0
let nextId = 1
let sessionId = INVOICE_KEY
let lookupFailCount = 0

function installFetchMock() {
  orders = new Map()
  createCalls = []
  lookupFails = false
  raceOnCreate = false
  payInvoiceCalls = 0
  nextId = 1
  sessionId = INVOICE_KEY
  lookupFailCount = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/resume_payin_session')) {
      return Response.json({
        sessionId: INVOICE_KEY,
        clientSecret: 'cs_secret',
        publishableKey: 'pk_live_test',
        mode: 'pay',
      })
    }
    if (u.includes('/payin_session')) {
      return Response.json({
        id: sessionId,
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
        valid_before: FUTURE,
      })
    }
    if (u.includes('pay-invoice') || u.includes('agentapi')) {
      payInvoiceCalls++
      return Response.json({ success: true })
    }
    if (u.includes('/payments/order/')) {
      if (lookupFails) return new Response('boom', { status: 503 })
      if (lookupFailCount > 0) {
        lookupFailCount--
        return new Response('boom', { status: 503 })
      }
      const oid = decodeURIComponent(u.split('/').pop() ?? '')
      const row = orders.get(oid)
      return row ? Response.json(row) : new Response('not found', { status: 404 })
    }
    if (/\/payments\/[^/]+$/.test(u) && (!init?.method || init.method === 'GET')) {
      const id = decodeURIComponent(u.split('/').pop() ?? '')
      const row = [...orders.values()].find((r) => r.id === id)
      return row ? Response.json(row) : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      createCalls.push(body.orderId)
      if (raceOnCreate) {
        raceOnCreate = false
        seedOrder(body.orderId, 'payment_unpaid', FUTURE, 'race-winner')
      }
      if (orders.has(body.orderId)) {
        return new Response(JSON.stringify({ error: 'orderIdConflict' }), { status: 409 })
      }
      const row = {
        id: `rozo-pay-${nextId++}`,
        orderId: body.orderId,
        status: 'payment_unpaid',
        paymentLink: 'https://pay.rozo.ai/x',
        expiresAt: FUTURE,
        source: { chainId: body.source.chainId, tokenSymbol: body.source.tokenSymbol },
        metadata: body.metadata,
      }
      orders.set(body.orderId, row)
      return Response.json(row)
    }
    // Base RPC balance read: plenty of funder balance.
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0'),
    })
  }) as typeof fetch)
}

function seedOrder(orderId: string, status: string, expiresAt: string, id = `old-${orderId}`) {
  orders.set(orderId, {
    id,
    orderId,
    status,
    expiresAt,
    paymentLink: 'https://pay.rozo.ai/old',
    source: { chainId: '8453', tokenSymbol: 'USDC' },
    metadata: { invoiceKey: INVOICE_KEY },
  })
}

async function createInvoice(env: Env) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: STRIPE_URL }),
    }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

beforeEach(() => installFetchMock())
afterEach(() => vi.restoreAllMocks())

function expectExpired(status: number, json: any) {
  expect(status).toBe(409)
  expect(json.ok).toBe(false)
  expect(json.code).toBe('PAYMENT_EXPIRED')
  expect(json.error.code).toBe('PAYMENT_EXPIRED')
  expect(json.message).toBe(STRIPE_PAYMENT_EXPIRED_MESSAGE)
  expect(json.error.message).toBe(STRIPE_PAYMENT_EXPIRED_MESSAGE)
  expect(json.message).not.toMatch(/[–—]/)
  expect(json.paymentLink).toBeUndefined()
}

describe('Stripe invoice whose Rozo order already exists', () => {
  it.each(['payment_expired', 'payment_refunded', 'payment_bounced'])(
    'order %s -> 409 PAYMENT_EXPIRED, no new order',
    async (st) => {
      seedOrder(BASE_ORDER_ID, st, PAST)
      const { status, json } = await createInvoice(makeEnv())
      expectExpired(status, json)
      expect(json.rozoPaymentId).toBe(`old-${BASE_ORDER_ID}`)
      expect(createCalls).toEqual([])
    },
  )

  it('unpaid but past expiresAt (not yet swept upstream) -> PAYMENT_EXPIRED, no new order', async () => {
    seedOrder(BASE_ORDER_ID, 'payment_unpaid', PAST)
    const { status, json } = await createInvoice(makeEnv())
    expectExpired(status, json)
    expect(createCalls).toEqual([])
  })

  it.each(['payment_payout_completed', 'payment_payin_completed'])(
    'paid order (%s), even past expiresAt -> ORDER_ALREADY_ACTIVE + alreadyPaid',
    async (st) => {
      seedOrder(BASE_ORDER_ID, st, PAST, 'paid-base')
      const { status, json } = await createInvoice(makeEnv())
      expect(status).toBe(409)
      expect(json.code).toBe('ORDER_ALREADY_ACTIVE')
      expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
      expect(json.alreadyPaid).toBe(true)
      expect(json.rozoPaymentId).toBe('paid-base')
      expect(createCalls).toEqual([])
    },
  )

  it('in-flight order -> ORDER_ALREADY_ACTIVE without alreadyPaid', async () => {
    seedOrder(BASE_ORDER_ID, 'payment_payin_pending', FUTURE)
    const { status, json } = await createInvoice(makeEnv())
    expect(status).toBe(409)
    expect(json.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.alreadyPaid).toBeUndefined()
  })

  it('reuses a live unpaid order', async () => {
    const env = makeEnv()
    const first = await createInvoice(env)
    expect(first.status).toBe(200)
    const { status, json } = await createInvoice(env)
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe(first.json.rozoPaymentId)
    expect(createCalls).toEqual([BASE_ORDER_ID])
  })

  it('no order yet -> creates exactly one order under the base orderId', async () => {
    const { status, json } = await createInvoice(makeEnv())
    expect(status).toBe(200)
    expect(json.reused).toBe(false)
    expect(createCalls).toEqual([BASE_ORDER_ID])
  })

  it('lookup failed and create hit orderIdConflict on an expired order -> PAYMENT_EXPIRED, not 502', async () => {
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    // The first lookup fails; the re-read after the 409 succeeds.
    lookupFailCount = 1
    const { status, json } = await createInvoice(makeEnv())
    expectExpired(status, json)
    expect(createCalls).toEqual([BASE_ORDER_ID])
    expect(lookupFailCount).toBe(0)
  })

  it('a concurrent create of a live order -> ORDER_CREATE_CONFLICT (retry reuses it)', async () => {
    raceOnCreate = true
    const { status, json } = await createInvoice(makeEnv())
    expect(status).toBe(409)
    expect(json.code).toBe('ORDER_CREATE_CONFLICT')
    expect(json.error.code).toBe('ORDER_CREATE_CONFLICT')
  })

  it('never creates a variant orderId, whatever the history', async () => {
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    for (let i = 0; i < 3; i++) await createInvoice(makeEnv())
    expect(createCalls.some((id) => id.includes('__r'))).toBe(false)
    expect(createCalls).toEqual([])
  })

  it('refuses a Stripe session id that is not cpis_<alphanumeric>, before any order', async () => {
    sessionId = 'cpis_abc__r2'
    const { status } = await createInvoice(makeEnv())
    expect(status).toBe(502)
    expect(createCalls).toEqual([])
  })
})
