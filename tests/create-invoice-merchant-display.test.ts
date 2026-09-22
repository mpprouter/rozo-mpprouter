/**
 * create-invoice sends the real merchant identity to the Rozo payment-api.
 *
 * Every order this route creates is filed under the single aggregator appId
 * `merchant_openrouter`, and the Rozo payment response's `merchant` block is
 * otherwise built purely from that appId's merchants row. So without the
 * per-order display override an invoice for any other merchant rendered
 * "Pay OpenRouter" on invoice.rozo.ai, which reads merchant.name and
 * merchant.description directly.
 *
 * The merchant name is already required earlier in this handler (a quote
 * without one 502s), so the override needs no per-merchant config: a brand new
 * merchant works the moment the upstream quote names it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import type { Env } from '../src/index'

function makeKvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  }
}

function makeEnv(): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: makeKvStub(),
  } as unknown as Env
}

/** Body POSTed to the Rozo intents API. */
let createdIntent: any = null
/** Merchant name the upstream quote reports for this run. */
let quoteMerchant = 'Command Code'

const PAYMENT_ID = 'paymentSession_merchant_display_test'

function installFetchMock() {
  createdIntent = null
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({
          invoice: { amount: '9.78' },
          merchant: quoteMerchant,
          linkId: PAYMENT_ID,
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      return new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
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
    if (u.includes('/payment-api')) {
      return new Response(JSON.stringify({ status: 'payment_unpaid' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

async function createInvoice(body: Record<string, unknown>) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    makeEnv(),
  )
  return { status: res.status, json: (await res.json()) as any }
}

const EVM_SOURCE = { chainId: '8453', tokenSymbol: 'USDC' }
const LIGHTNING_SOURCE = { chainId: 'lightning', tokenSymbol: 'BTC' }

beforeEach(() => {
  quoteMerchant = 'Command Code'
  installFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('create-invoice — per-order merchant display', () => {
  it('sends the real merchant name and description on the EVM (exactIn) path', async () => {
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE })

    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactIn')
    expect(createdIntent.display.merchantName).toBe('Command Code')
    expect(createdIntent.display.merchantDescription).toBe('Command Code via ROZO Checkout')
  })

  it('sends them on the Lightning (exactOut) path too', async () => {
    const { status } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: LIGHTNING_SOURCE,
    })

    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.display.merchantName).toBe('Command Code')
    expect(createdIntent.display.merchantDescription).toBe('Command Code via ROZO Checkout')
  })

  it('works for any merchant with no per-merchant config', async () => {
    quoteMerchant = 'Some Brand New Merchant'
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE })

    expect(status).toBe(200)
    expect(createdIntent.display.merchantName).toBe('Some Brand New Merchant')
    expect(createdIntent.display.merchantDescription).toBe(
      'Some Brand New Merchant via ROZO Checkout',
    )
  })

  it('keeps the OpenRouter line reading naturally', async () => {
    quoteMerchant = 'OpenRouter, Inc'
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE })

    expect(status).toBe(200)
    expect(createdIntent.display.merchantName).toBe('OpenRouter, Inc')
    expect(createdIntent.display.merchantDescription).toBe(
      'OpenRouter, Inc via ROZO Checkout',
    )
  })

  it('does not change appId, title or settlement routing', async () => {
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE })

    expect(status).toBe(200)
    // The aggregator appId stays the owner of the order (founder: "MID 可以是这个").
    expect(createdIntent.appId).toBe('merchant_openrouter')
    expect(createdIntent.display.title).toContain('Command Code')
    expect(createdIntent.display.currency).toBe('USD')
    expect(createdIntent.destination.chainId).toBeDefined()
    expect(createdIntent.destination.receiverAddress).toBeDefined()
  })
})
