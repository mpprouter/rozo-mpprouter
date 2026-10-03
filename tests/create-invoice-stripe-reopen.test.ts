/**
 * Stripe create-invoice: reopening a still-valid Stripe link after the Rozo
 * order for it expired.
 *
 * Upstream (rozo-intents-api) keeps an orderId taken forever, even by an
 * expired order (unique index on (app_id, order_id)), so re-creating under
 * `stripe_crypto_<cpis>` 409s with orderIdConflict. Before the fix the Stripe
 * branch turned that into a generic 502 and the invoice could never get a new
 * order. The fix creates the new order under a variant slot
 * (`stripe_crypto_<cpis>__r2`, ...), and the webhook maps every slot back to
 * the same invoiceKey so the per-invoice settlement guard still holds.
 *
 * The fetch mock models upstream uniqueness for real: a POST with a taken
 * orderId answers 409 orderIdConflict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import {
  handleStripeWebhookEvent,
  invoiceKeyFromOrderId,
  isStripeOrderId,
  readDailySpentAtomic,
  stripeKvKey,
} from '../src/routes/stripe-fulfillment'
import { casRead } from '../src/routes/stripe-atomic'
import type { Env } from '../src/index'

const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMTestBlob_REOPEN123'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const INVOICE_KEY = 'cpis_reopen123'
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

function installFetchMock() {
  orders = new Map()
  createCalls = []
  lookupFails = false
  raceOnCreate = false
  payInvoiceCalls = 0
  nextId = 1
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
        id: INVOICE_KEY,
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

describe('Stripe reopen after the Rozo order expired', () => {
  it('creates a new order under a variant orderId instead of a 502 (the bug)', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    const { status, json } = await createInvoice(env)
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.reused).toBe(false)
    expect(createCalls).toEqual([`${BASE_ORDER_ID}__r2`])
    expect(json.rozoPaymentId).toBe('rozo-pay-1')
  })

  it('a second expiry moves on to the next variant slot', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    seedOrder(`${BASE_ORDER_ID}__r2`, 'payment_expired', PAST)
    const { status } = await createInvoice(env)
    expect(status).toBe(200)
    expect(createCalls).toEqual([`${BASE_ORDER_ID}__r3`])
  })

  it('reuses a live unpaid variant order instead of creating another', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    const first = await createInvoice(env)
    expect(first.json.rozoPaymentId).toBe('rozo-pay-1')
    const { status, json } = await createInvoice(env)
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe('rozo-pay-1')
    expect(createCalls).toEqual([`${BASE_ORDER_ID}__r2`])
  })

  it('never creates a new order when an expired-by-time order was paid', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_payout_completed', PAST, 'paid-base')
    const { status, json } = await createInvoice(env)
    expect(status).toBe(409)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.alreadyPaid).toBe(true)
    expect(json.rozoPaymentId).toBe('paid-base')
    expect(createCalls).toEqual([])
  })

  it('never creates a new order when a variant order is paid', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    seedOrder(`${BASE_ORDER_ID}__r2`, 'payment_payin_completed', PAST, 'paying-r2')
    const { status, json } = await createInvoice(env)
    expect(status).toBe(409)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.rozoPaymentId).toBe('paying-r2')
    expect(createCalls).toEqual([])
  })

  it('waits (clear 409) while an unpaid order is past expiresAt but not yet marked expired', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_unpaid', PAST)
    const { status, json } = await createInvoice(env)
    expect(status).toBe(409)
    expect(json.code).toBe('ORDER_EXPIRING')
    expect(createCalls).toEqual([])
  })

  it('fails closed (no create) when the order lookup errors', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    lookupFails = true
    const { status, json } = await createInvoice(env)
    expect(status).toBe(502)
    expect(json.code).toBe('INTENTS_API_FAILED')
    expect(createCalls).toEqual([])
  })

  it('maps an exhausted set of slots to a clear error, not a 502', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    for (let n = 2; n <= 8; n++) seedOrder(`${BASE_ORDER_ID}__r${n}`, 'payment_expired', PAST)
    const { status, json } = await createInvoice(env)
    expect(status).toBe(409)
    expect(json.code).toBe('STRIPE_ORDER_ATTEMPTS_EXHAUSTED')
    expect(createCalls).toEqual([])
  })

  it('maps a racing orderIdConflict to a clear 409, not a 502', async () => {
    const env = makeEnv()
    // The base slot looks free at scan time, but a concurrent caller takes it
    // before our create lands.
    raceOnCreate = true
    const { status, json } = await createInvoice(env)
    expect(status).toBe(409)
    expect(json.code).toBe('ORDER_CREATE_CONFLICT')
  })

  it('points the fulfillment record at the new order', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    // First create (before expiry) seeded the record with the old payment id.
    orders.delete(BASE_ORDER_ID)
    await createInvoice(env)
    orders.get(BASE_ORDER_ID)!.status = 'payment_expired'
    orders.get(BASE_ORDER_ID)!.expiresAt = PAST
    const { json } = await createInvoice(env)
    expect(json.rozoPaymentId).toBe('rozo-pay-2')
    const { value } = await casRead(env, stripeKvKey(INVOICE_KEY))
    expect(JSON.parse(value!).rozoPaymentId).toBe('rozo-pay-2')
  })
})

describe('variant orderIds keep the per-invoice settlement guard', () => {
  it('maps every variant slot back to the same invoiceKey', () => {
    expect(isStripeOrderId(`${BASE_ORDER_ID}__r2`)).toBe(true)
    expect(invoiceKeyFromOrderId(`${BASE_ORDER_ID}__r2`)).toBe(INVOICE_KEY)
    expect(invoiceKeyFromOrderId(`${BASE_ORDER_ID}__r8`)).toBe(INVOICE_KEY)
    expect(invoiceKeyFromOrderId(BASE_ORDER_ID)).toBe(INVOICE_KEY)
  })

  it('two orders for one invoice (base + variant) cannot both settle', async () => {
    const env = makeEnv()
    // Base order created, expired; reopen creates the variant. Both exist.
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    const created = await createInvoice(env)
    expect(created.status).toBe(200)
    const variantId = `${BASE_ORDER_ID}__r2`
    const now = new Date(Date.UTC(2026, 9, 3))
    const evt = (orderId: string, eventId: string, rozoPaymentId: string) => ({
      eventId,
      eventType: 'payment_payout_completed',
      orderId,
      rozoPaymentId,
      invoiceAmountStr: '10.00',
    })
    // Concurrent payouts from both orders.
    const [a, b] = await Promise.all([
      handleStripeWebhookEvent(env, evt(BASE_ORDER_ID, 'evBase', 'old-base'), now),
      handleStripeWebhookEvent(env, evt(variantId, 'evVariant', 'rozo-pay-1'), now),
    ])
    expect(payInvoiceCalls).toBe(1)
    expect([a, b].filter((r) => r.status === 'provider_submitted').length).toBe(1)
    expect(await readDailySpentAtomic(env, now)).toBe(10_000_000n)

    // A later event from either order never fires a second settlement.
    const c = await handleStripeWebhookEvent(env, evt(variantId, 'evVariant2', 'rozo-pay-1'), now)
    const d = await handleStripeWebhookEvent(env, evt(BASE_ORDER_ID, 'evBase2', 'old-base'), now)
    expect(payInvoiceCalls).toBe(1)
    expect(c.status).not.toBe('provider_submitted')
    expect(d.status).not.toBe('provider_submitted')
  })

  it('sequential: once the variant settled, the base order cannot settle again', async () => {
    const env = makeEnv()
    seedOrder(BASE_ORDER_ID, 'payment_expired', PAST)
    await createInvoice(env)
    const now = new Date(Date.UTC(2026, 9, 3))
    const first = await handleStripeWebhookEvent(
      env,
      { eventId: 'e1', eventType: 'payment_payout_completed', orderId: `${BASE_ORDER_ID}__r2`, rozoPaymentId: 'rozo-pay-1', invoiceAmountStr: '10.00' },
      now,
    )
    expect(first.status).toBe('provider_submitted')
    const second = await handleStripeWebhookEvent(
      env,
      { eventId: 'e2', eventType: 'payment_payout_completed', orderId: BASE_ORDER_ID, rozoPaymentId: 'old-base', invoiceAmountStr: '10.00' },
      now,
    )
    expect(second.status).not.toBe('provider_submitted')
    expect(payInvoiceCalls).toBe(1)
  })
})
