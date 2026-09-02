/**
 * create-invoice echoes back the invoice URL the caller supplied.
 *
 * A checkout client that keeps only our response needs the merchant's own
 * invoice URL to link back to it. Echoing the caller's own string in the same
 * response discloses nothing new. These tests pin that, and — more importantly
 * — pin the boundary it must not cross: the Stripe /pay/<blob> hash is a
 * replayable capability, so nothing keyed by paymentId/invoiceKey may return
 * it, and it must stay out of the Rozo intent metadata.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { handleInvoiceDetails } from '../src/routes/invoice-details'
import { createQuoteReceipt, verifyQuoteReceipt } from '../src/routes/quote-receipt'
import type { Env } from '../src/index'

const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMTestBlob_ABC123xyz'
const SETTLEMENT_RECEIVER = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function makeKvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
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

function makeEnv(feeBps?: string): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: makeKvStub(),
    ATOMIC_STORE: makeDoStub(),
    INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    CHECKOUT_WEB_FEE_BPS: feeBps,
  } as unknown as Env
}

/** Captures the body POSTed to the Rozo intents API so we can assert on it. */
let createdIntent: any = null
/** When set, the idempotency lookup returns this instead of 404. */
let existingIntent: any = null
/** Body POSTed to /payments/:id/checkout (source rotation), if any. */
let checkoutBody: any = null
/** What the rotation endpoint answers; overridden per-test to simulate failure. */
let checkoutResponse: () => Response = () => new Response('{}', { status: 200 })
/** When set, the post-rotation status refetch returns this instead of existingIntent. */
let refetchedIntent: any = null
let stripeMerchantTitle = 'Test Merchant'

function installFetchMock() {
  createdIntent = null
  existingIntent = null
  checkoutBody = null
  refetchedIntent = null
  stripeMerchantTitle = 'Test Merchant'
  checkoutResponse = () => new Response('{}', { status: 200 })
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/resume_payin_session')) {
      return new Response(
        JSON.stringify({
          sessionId: 'cpis_test123',
          clientSecret: 'cs_secret',
          publishableKey: 'pk_live_test',
          mode: 'pay',
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payin_session')) {
      return new Response(
        JSON.stringify({
          id: 'cpis_test123',
          state: 'checkout',
          business_name: stripeMerchantTitle,
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
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      return existingIntent
        ? new Response(JSON.stringify(existingIntent), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/checkout')) {
      checkoutBody = JSON.parse(String(init?.body ?? '{}'))
      return checkoutResponse()
    }
    // Status refetch after a failed rotation (GET /payments/:id).
    if (/\/payments\/[^/]+$/.test(u) && (!init?.method || init.method === 'GET')) {
      const row = refetchedIntent ?? existingIntent
      return row
        ? new Response(JSON.stringify(row), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api')) {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({
          id: 'rozo-pay-1',
          paymentLink: 'https://pay.rozo.ai/x',
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

async function createInvoice(body: Record<string, unknown>, feeBps?: string) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    makeEnv(feeBps),
  )
  return { status: res.status, json: (await res.json()) as any }
}

async function openRouterFeeReceipt(nowSeconds = Math.floor(Date.now() / 1000)) {
  return createQuoteReceipt(
    'cpis_test123',
    '10',
    'OpenRouter',
    'test-admin-secret',
    nowSeconds,
    {
      original: '10',
      serviceFee: '0.1',
      callerPays: '10.1',
      feeBps: 100,
      pricingVersion: 'checkout-web-fee-v2',
      client: null,
    },
  )
}

beforeEach(() => {
  installFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('create-invoice echoes the caller-supplied invoice URL', () => {
  it('returns invoiceUrl verbatim on a fresh Stripe order', async () => {
    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(json.invoiceUrl).toBe(STRIPE_URL)
  })

  it('returns invoiceUrl on a reused Stripe order too', async () => {
    existingIntent = {
      id: 'rozo-pay-existing',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }
    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.invoiceUrl).toBe(STRIPE_URL)
  })

  it('never puts the URL into the Rozo intent metadata', async () => {
    await createInvoice({ url: STRIPE_URL })
    const meta = JSON.stringify(createdIntent?.metadata ?? {})
    expect(meta).not.toContain('crypto.stripe.com')
    expect(meta).not.toContain('CDMTestBlob_ABC123xyz')
  })

  it('omits invoiceUrl when the caller identified the invoice by id', async () => {
    const { json } = await createInvoice({ payment_id: 'pl_test_abc' })
    expect(json.invoiceUrl).toBeUndefined()
  })
})

describe('quote-invoice echoes the caller-supplied invoice URL', () => {
  const COINBASE_URL = 'https://payments.coinbase.com/payment-links/pl_quote_echo'

  async function quote(body: Record<string, unknown>) {
    const { handleQuoteInvoice } = await import('../src/routes/pay-invoice-admin')
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      Response.json({
        linkId: 'pl_quote_echo',
        merchant: 'OpenRouter, Inc.',
        invoice: { amount: '1.05' },
      })) as typeof fetch)
    const res = await handleQuoteInvoice(
      new Request('https://mpp.test/quote-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { PAYINVOICE_ADMIN_SECRET: 'test-secret' } as Env,
    )
    return { status: res.status, json: (await res.json()) as any }
  }

  it('returns invoiceUrl verbatim when the caller passed a URL', async () => {
    const { status, json } = await quote({ url: COINBASE_URL })
    expect(status).toBe(200)
    expect(json.invoiceUrl).toBe(COINBASE_URL)
  })

  it('echoes a Stripe URL just the same — it is the caller\'s own string', async () => {
    const { json } = await quote({ url: STRIPE_URL })
    expect(json.invoiceUrl).toBe(STRIPE_URL)
  })

  it('omits invoiceUrl when the caller passed only a payment_id', async () => {
    const { json } = await quote({ payment_id: 'pl_quote_echo' })
    expect(json.invoiceUrl).toBeUndefined()
  })
})
