/**
 * create-invoice returns `linkExpiresAt`: the EXTERNAL payment link's own
 * deadline (Stripe session `valid_before`, Coinbase v3 `expiresAt` / v1
 * `preApprovalExpiry`), next to the Rozo order's `expiresAt`, so the checkout
 * page can show the earlier of the two.
 *
 * Coinbase reads it through the same read-only resolver invoice-details uses,
 * after the quote succeeded. Any failure degrades to null and never changes
 * the status code or the order that is created.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice, resolveCoinbaseLinkExpiry } from '../src/routes/create-invoice'
import type { Env } from '../src/index'

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMTestBlob_ABC123xyz'
const SESSION_ID = 'paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2'
const LINK_ID = 'pl_testAlchemy001'
const ORDER_EXPIRES = '2999-01-01T00:00:00.000Z'
const COINBASE_EXPIRES = '2998-06-01T12:00:00.000Z'
const STRIPE_VALID_BEFORE = '2997-03-01T08:30:00.000Z'

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
        return Response.json({ value: store.get(b.key) ?? null, version: versions.get(b.key) ?? 0 })
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
  } as unknown as Env
}

let quoteLinkId = SESSION_ID
let existingRow: any = null
let createdIntent: any = null
/** What the Coinbase next-api answers; per test. */
let coinbaseResponse: () => Response | Promise<Response> = () => new Response('{}')
let coinbaseCalls: string[] = []

function v3Session() {
  return {
    paymentSessionId: SESSION_ID,
    status: 'PAYMENT_SESSION_STATUS_CREATED',
    amount: '10.5',
    asset: 'usdc',
    expiresAt: COINBASE_EXPIRES,
    customerDisplay: { merchantName: 'OpenRouter, Inc' },
    target: {
      paymentTargetWallet: {
        address: '0x4C3f2E391498e2590bd327a7A1CAA68Dd42c4647',
        network: 'PAYMENT_TARGET_NETWORK_BASE',
      },
    },
  }
}

function v1Link() {
  return {
    id: LINK_ID,
    status: 'ACTIVE',
    maxAmount: '10.5',
    token: BASE_USDC,
    networkId: 8453,
    preApprovalExpiry: String(Math.floor(Date.parse(COINBASE_EXPIRES) / 1000)),
    maxUsage: 1,
    usageCount: 0,
    merchant: { name: 'OpenRouter, Inc' },
    fiat: { amount: '10.5', currency: 'USD' },
  }
}

function installFetchMock() {
  quoteLinkId = SESSION_ID
  existingRow = null
  createdIntent = null
  coinbaseCalls = []
  coinbaseResponse = () => new Response(JSON.stringify(v3Session()), { status: 200 })
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('payments.coinbase.com/next-api/')) {
      coinbaseCalls.push(u)
      return coinbaseResponse()
    }
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({ invoice: { amount: '10.5' }, merchant: 'OpenRouter, Inc', linkId: quoteLinkId }),
        { status: 200 },
      )
    }
    if (u.includes('/resume_payin_session')) {
      return new Response(
        JSON.stringify({ sessionId: 'cpis_test123', clientSecret: 'cs_secret', publishableKey: 'pk_live_test', mode: 'pay' }),
        { status: 200 },
      )
    }
    if (u.includes('/payin_session')) {
      return new Response(
        JSON.stringify({
          id: 'cpis_test123',
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
          valid_before: STRIPE_VALID_BEFORE,
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      const lookedUp = decodeURIComponent(u.split('/').pop() ?? '')
      const isBase = lookedUp === quoteLinkId || lookedUp.startsWith('stripe')
      return existingRow && isBase
        ? new Response(JSON.stringify(existingRow), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: ORDER_EXPIRES }),
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

function unpaidRow(id: string, sourceChain = '8453') {
  return {
    id,
    status: 'payment_unpaid',
    expiresAt: ORDER_EXPIRES,
    paymentLink: 'https://pay.rozo.ai/existing',
    source: { chainId: sourceChain, tokenSymbol: 'USDC', receiverAddress: '0xabc' },
    metadata: {
      internal: { original: '10.5', serviceFee: '0', callerPays: '10.5', feeBps: 0, pricingVersion: 'checkout-web-fee-v3' },
    },
  }
}

beforeEach(() => installFetchMock())
afterEach(() => vi.restoreAllMocks())

describe('create-invoice linkExpiresAt — Stripe', () => {
  it('returns the Stripe session valid_before on a fresh order', async () => {
    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(json.reused).toBe(false)
    expect(json.expiresAt).toBe(ORDER_EXPIRES)
    expect(json.linkExpiresAt).toBe(STRIPE_VALID_BEFORE)
  })

  it('returns it on a reused order too', async () => {
    existingRow = { ...unpaidRow('rozo-existing'), metadata: { internal: { original: '10', serviceFee: '0', callerPays: '10', feeBps: 0, pricingVersion: 'checkout-web-fee-v3' } } }
    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.expiresAt).toBe(ORDER_EXPIRES)
    expect(json.linkExpiresAt).toBe(STRIPE_VALID_BEFORE)
  })
})

describe('create-invoice linkExpiresAt — Coinbase', () => {
  it('returns the v3 session expiresAt on a fresh order', async () => {
    const { status, json } = await createInvoice({ payment_id: SESSION_ID })
    expect(status).toBe(200)
    expect(json.reused).toBe(false)
    expect(json.expiresAt).toBe(ORDER_EXPIRES)
    expect(json.linkExpiresAt).toBe(COINBASE_EXPIRES)
    expect(coinbaseCalls).toHaveLength(1)
    expect(coinbaseCalls[0]).toContain(`/payment-sessions/${SESSION_ID}`)
  })

  it('returns the v1 link preApprovalExpiry', async () => {
    quoteLinkId = LINK_ID
    coinbaseResponse = () => new Response(JSON.stringify(v1Link()), { status: 200 })
    const { status, json } = await createInvoice({ payment_id: LINK_ID })
    expect(status).toBe(200)
    expect(json.linkExpiresAt).toBe(COINBASE_EXPIRES)
    expect(coinbaseCalls[0]).toContain(`/payment-links/${LINK_ID}`)
  })

  it('returns it on a reused order', async () => {
    existingRow = unpaidRow('rozo-existing')
    const { status, json } = await createInvoice({ payment_id: SESSION_ID })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe('rozo-existing')
    expect(json.linkExpiresAt).toBe(COINBASE_EXPIRES)
  })

  it('degrades to null when the Coinbase lookup fails; the order is still created', async () => {
    coinbaseResponse = () => new Response('boom', { status: 500 })
    const { status, json } = await createInvoice({ payment_id: SESSION_ID })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.rozoPaymentId).toBe('rozo-pay-1')
    expect(json.expiresAt).toBe(ORDER_EXPIRES)
    expect(json.linkExpiresAt).toBeNull()
    expect(createdIntent).not.toBeNull()
  })

  it('degrades to null when the Coinbase lookup throws or returns junk', async () => {
    coinbaseResponse = () => { throw new TypeError('network down') }
    let r = await createInvoice({ payment_id: SESSION_ID })
    expect(r.status).toBe(200)
    expect(r.json.linkExpiresAt).toBeNull()

    installFetchMock()
    coinbaseResponse = () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 })
    r = await createInvoice({ payment_id: SESSION_ID })
    expect(r.status).toBe(200)
    expect(r.json.linkExpiresAt).toBeNull()
  })

  it('does not call Coinbase when the quote fails, and the error is unchanged', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('payments.coinbase.com/next-api/')) coinbaseCalls.push(u)
      if (u.includes('/quote-invoice')) return new Response('gone', { status: 410 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch)
    const { status, json } = await createInvoice({ payment_id: SESSION_ID })
    expect(status).toBe(410)
    expect(json.error?.code ?? json.code).toBe('LINK_USED_OR_EXPIRED')
    expect(json.linkExpiresAt).toBeUndefined()
    expect(coinbaseCalls).toHaveLength(0)
  })
})

describe('resolveCoinbaseLinkExpiry', () => {
  it('times out to null', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(((_input: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch)
    const started = Date.now()
    await expect(resolveCoinbaseLinkExpiry(SESSION_ID, 30)).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('ignores ids that are not Coinbase checkout ids', async () => {
    await expect(resolveCoinbaseLinkExpiry('rozotest_1_2_3')).resolves.toBeNull()
    await expect(resolveCoinbaseLinkExpiry(null)).resolves.toBeNull()
    await expect(resolveCoinbaseLinkExpiry('pl_../../x')).resolves.toBeNull()
    expect(coinbaseCalls).toHaveLength(0)
  })
})
