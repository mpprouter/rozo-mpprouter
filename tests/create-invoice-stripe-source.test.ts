/**
 * Stripe create-invoice honors the caller's `source` (pay-with chain/token).
 *
 * The Stripe branch used to return before `resolveSource()` ran, so a caller
 * asking to pay with e.g. Solana USDT had that silently dropped and was billed
 * on Base USDC instead — no error, no effect. These tests pin the fixed
 * behavior and, just as importantly, pin what must NOT change: the destination
 * is always Base USDC to the funder wallet.
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

describe('Stripe create-invoice — source is honored, not swallowed', () => {
  it('creates the intent on the requested source (Solana USDT)', async () => {
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactIn')
    expect(createdIntent.source).toMatchObject({
      chainId: '900',
      tokenSymbol: 'USDT',
      tokenAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    })
    expect(json.source).toEqual({ chainId: '900', tokenSymbol: 'USDT' })
  })

  it('still defaults to Base USDC when no source is given', async () => {
    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(createdIntent.source).toMatchObject({ chainId: '8453', tokenSymbol: 'USDC' })
    expect(json.source).toEqual({ chainId: '8453', tokenSymbol: 'USDC' })
  })

  it('echoes the Rozo intent as raw (parity with the Coinbase branch)', async () => {
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: 'lightning', tokenSymbol: 'BTC' },
    })
    expect(status).toBe(200)
    // The frontend renders payin instructions (e.g. raw.lnInvoice) from this.
    expect(json.raw).toMatchObject({ id: 'rozo-pay-1' })
    // Must never echo the Stripe URL through raw.
    expect(JSON.stringify(json.raw)).not.toContain('crypto.stripe.com')
  })

  it('uses exactOut with a pinned destination amount for a Lightning source', async () => {
    const { status } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: 'lightning', tokenSymbol: 'BTC' },
    })
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.source).toEqual({ chainId: 'lightning', tokenSymbol: 'BTC' })
    // BTC price floats, so no source.amount — the destination pins what we get.
    expect(createdIntent.source.amount).toBeUndefined()
    expect(createdIntent.destination.amount).toBe('10')
  })

  it('charges and persists the same 1% browser fee on stablecoin and Lightning', async () => {
    stripeMerchantTitle = 'OpenRouter'
    const quoteReceipt = await openRouterFeeReceipt()
    for (const source of [
      undefined,
      { chainId: 'lightning', tokenSymbol: 'BTC' },
    ]) {
      const { status, json } = await createInvoice(
        {
          url: STRIPE_URL,
          client: 'rozo-checkout-web',
          quoteReceipt,
          ...(source ? { source } : {}),
        },
        '100',
      )
      expect(status).toBe(200)
      expect(json).toMatchObject({
        original: '10',
        serviceFee: '0.1',
        callerPays: '10.1',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v2',
      })
      expect(createdIntent.type === 'exactOut'
        ? createdIntent.destination.amount
        : createdIntent.source.amount).toBe('10.1')
      expect(createdIntent.metadata).toMatchObject({
        client: 'rozo-checkout-web',
        invoiceAmountAtomic: '10000000',
        original: '10',
        serviceFee: '0.1',
        callerPays: '10.1',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v2',
      })
    }
  })

  it('invoice-details returns the signed Stripe pricing snapshot the confirm card must show', async () => {
    stripeMerchantTitle = 'OpenRouter'
    const response = await handleInvoiceDetails(
      new Request('https://mpp.test/invoice-details', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        body: JSON.stringify({ url: STRIPE_URL, client: 'rozo-checkout-web' }),
      }),
      makeEnv('100'),
    )
    const body = await response.json() as any
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      original: '10',
      serviceFee: '0.1',
      callerPays: '10.1',
      feeBps: 100,
      pricingVersion: 'checkout-web-fee-v2',
    })
    await expect(
      verifyQuoteReceipt(body.quoteReceipt, 'cpis_test123', 'test-admin-secret'),
    ).resolves.toMatchObject({
      original: '10',
      serviceFee: '0.1',
      callerPays: '10.1',
      client: null,
    })
  })

  it('refuses fee-enabled Stripe create without the invoice-details receipt', async () => {
    stripeMerchantTitle = 'OpenRouter'
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      client: 'rozo-checkout-web',
    }, '100')
    expect(status).toBe(409)
    expect(json.error.code).toBe('QUOTE_RECEIPT_REQUIRED')
    expect(createdIntent).toBeNull()
  })

  it('rejects mismatched and expired Stripe receipts without creating', async () => {
    stripeMerchantTitle = 'OpenRouter'
    const mismatched = await createQuoteReceipt(
      'cpis_other',
      '10',
      'OpenRouter',
      'test-admin-secret',
    )
    for (const quoteReceipt of [mismatched, await openRouterFeeReceipt(1_000)]) {
      const { status, json } = await createInvoice({
        url: STRIPE_URL,
        client: 'rozo-checkout-web',
        quoteReceipt,
      }, '100')
      expect(status).toBe(409)
      expect(json.error.code).toBe('QUOTE_RECEIPT_INVALID_OR_EXPIRED')
      expect(createdIntent).toBeNull()
    }
  })

  it('keeps zero-fee Stripe compatibility for an invalid or client-mismatched receipt', async () => {
    stripeMerchantTitle = 'OpenRouter'
    const clientMismatched = await createQuoteReceipt(
      'cpis_test123',
      '10',
      'OpenRouter',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '10',
        serviceFee: '0',
        callerPays: '10',
        feeBps: 0,
        pricingVersion: 'checkout-web-fee-v2',
        client: null,
      },
    )
    for (const quoteReceipt of ['tampered.receipt', clientMismatched]) {
      const { status, json } = await createInvoice({
        url: STRIPE_URL,
        client: 'rozo-checkout-web',
        quoteReceipt,
      }, '0')
      expect(status).toBe(200)
      expect(json.serviceFee).toBe('0')
      expect(createdIntent.source.amount).toBe('10')
    }
  })

  it('honors the signed Stripe quote price when the env changes before create', async () => {
    stripeMerchantTitle = 'OpenRouter'
    const quoteReceipt = await createQuoteReceipt(
      'cpis_test123',
      '10',
      'OpenRouter',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '10',
        serviceFee: '0.1',
        callerPays: '10.1',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v2',
        client: null,
      },
    )

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '0')

    expect(status).toBe(200)
    expect(json.callerPays).toBe('10.1')
    expect(createdIntent.source.amount).toBe('10.1')
  })

  it('rejects an unsupported source explicitly instead of silently ignoring it', async () => {
    // Base has no USDT. Previously this was swallowed and billed as Base USDC.
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '8453', tokenSymbol: 'USDT' },
    })
    expect(status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_SOURCE')
    expect(json.supported_sources).toBeDefined()
    // Nothing was created upstream.
    expect(createdIntent).toBeNull()
  })

  it('rejects a malformed source before touching Stripe at all', async () => {
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { tokenSymbol: 'USDC' }, // no chainId
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_SOURCE')
    expect(createdIntent).toBeNull()
  })
})

describe('Stripe create-invoice — what source must NOT change', () => {
  it('always settles to the funder wallet in Base USDC regardless of source', async () => {
    for (const source of [
      { chainId: '900', tokenSymbol: 'USDT' },
      { chainId: '1', tokenSymbol: 'USDC' },
      { chainId: '1500', tokenSymbol: 'USDC' },
    ]) {
      await createInvoice({ url: STRIPE_URL, source })
      expect(createdIntent.destination).toMatchObject({
        chainId: '8453',
        receiverAddress: SETTLEMENT_RECEIVER,
        tokenSymbol: 'USDC',
        tokenAddress: BASE_USDC,
      })
    }
  })

  it('does not change the amount the caller pays', async () => {
    // $10 invoice -> 10*100/105 discount, independent of the source chain.
    const base = await createInvoice({ url: STRIPE_URL })
    const solana = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })
    expect(base.json.callerPays).toBe('10')
    expect(solana.json.callerPays).toBe('10')
  })
})

describe('Stripe create-invoice — reuse with a conflicting source', () => {
  it('rejects a zero-fee pending order when the browser canary price is now 1%', async () => {
    stripeMerchantTitle = 'OpenRouter, Inc.'
    const quoteReceipt = await createQuoteReceipt(
      'cpis_test123',
      '10',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '10',
        serviceFee: '0.1',
        callerPays: '10.1',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v2',
        client: null,
      },
    )
    existingIntent = {
      id: 'rozo-existing-price',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '100')

    expect(status).toBe(409)
    expect(json.error.code).toBe('LEGACY_PRICING_ORDER_PENDING')
    expect(createdIntent).toBeNull()
  })

  it('reuses a fee-priced pending order when lookup omits metadata but amount matches', async () => {
    stripeMerchantTitle = 'OpenRouter, Inc.'
    const quoteReceipt = await createQuoteReceipt(
      'cpis_test123',
      '10',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '10',
        serviceFee: '0.1',
        callerPays: '10.1',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v2',
        client: null,
      },
    )
    existingIntent = {
      id: 'rozo-existing-price',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.1' },
    }

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '100')

    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.callerPays).toBe('10.1')
    expect(createdIntent).toBeNull()
  })

  it('rejects a fee-bearing row with unreadable amount after rollback to zero', async () => {
    stripeMerchantTitle = 'OpenRouter, Inc.'
    existingIntent = {
      id: 'rozo-existing-price',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC' },
      metadata: {
        original: '10',
        serviceFee: '0.1',
        callerPays: '10.1',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v2',
      },
    }

    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(409)
    expect(json.error.code).toBe('LEGACY_PRICING_ORDER_PENDING')
    expect(createdIntent).toBeNull()
  })

  it('rotates the unpaid order onto the requested source instead of echoing the old one', async () => {
    existingIntent = {
      id: 'rozo-existing-1',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }
    checkoutResponse = () =>
      new Response(
        JSON.stringify({
          id: 'rozo-existing-1',
          status: 'payment_unpaid',
          paymentLink: 'https://pay.rozo.ai/existing-rotated',
          expiresAt: '2999-02-01T00:00:00.000Z',
          source: { chainId: '900', tokenSymbol: 'USDT' },
        }),
        { status: 200 },
      )

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.sourceRotated).toBe(true)
    // Rotated in place: no new intent, and the caller pays on the chain they asked for.
    expect(createdIntent).toBeNull()
    expect(checkoutBody).toEqual({ source: { chainId: '900', tokenSymbol: 'USDT' } })
    expect(json.source).toEqual({ chainId: '900', tokenSymbol: 'USDT' })
    expect(json.paymentLink).toBe('https://pay.rozo.ai/existing-rotated')
    expect(json.warnings ?? []).toEqual([])
  })

  it('falls back to the existing source with a warning when rotation fails', async () => {
    existingIntent = {
      id: 'rozo-existing-1b',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }
    checkoutResponse = () =>
      new Response(JSON.stringify({ error: 'checkoutNotAllowed' }), { status: 400 })

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    // Never a hard failure — the caller still gets a payable order.
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.sourceMismatch).toBe(true)
    expect(createdIntent).toBeNull()
    expect(json.source).toEqual({ chainId: '8453', tokenSymbol: 'USDC' })
    expect(json.warnings?.join(' ')).toContain('was not applied')
    expect(json.warnings?.join(' ')).toContain('checkoutNotAllowed')
  })

  it('answers 409 when the order left payment_unpaid during a failed rotation (lookup→rotate race)', async () => {
    existingIntent = {
      id: 'rozo-existing-1c',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }
    // A payer funded the order while our /checkout call was in flight: the
    // rotation is refused, and the refetched row is no longer unpaid.
    checkoutResponse = () =>
      new Response(JSON.stringify({ error: 'checkoutNotAllowed' }), { status: 400 })
    refetchedIntent = { ...existingIntent, status: 'payment_completed' }

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    expect(status).toBe(409)
    expect(json.ok).toBe(false)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.status).toBe('payment_completed')
    expect(createdIntent).toBeNull()
  })

  it('does not warn or rotate when the reused intent matches the requested source', async () => {
    existingIntent = {
      id: 'rozo-existing-2',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '900', tokenSymbol: 'USDT', amount: '10' },
    }

    const { json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })
    expect(json.reused).toBe(true)
    expect(checkoutBody).toBeNull()
    expect(json.sourceRotated).toBeUndefined()
    expect(json.warnings ?? []).not.toContain(expect.stringContaining('was not applied'))
  })
})

describe('Stripe create-invoice — an unexpired order that is no longer unpaid', () => {
  it('returns 409 ORDER_ALREADY_ACTIVE instead of reusing or recreating', async () => {
    existingIntent = {
      id: 'rozo-existing-3',
      status: 'payment_started',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    expect(status).toBe(409)
    expect(json.ok).toBe(false)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.status).toBe('payment_started')
    expect(json.rozoPaymentId).toBe('rozo-existing-3')
    expect(json.expiresAt).toBe('2999-01-01T00:00:00.000Z')
    // No duplicate order, no rotation attempt.
    expect(createdIntent).toBeNull()
    expect(checkoutBody).toBeNull()
  })
})
