/**
 * Celo USDT as a beta stable source (A2): closed by default, open only with
 * NATIVE_SOURCES_BETA "USDT@42220" AND `?beta=celo`; a Celo order needs the
 * merchant link to live at least CELO_MIN_LINK_LIFE_MS (unknown = refused).
 *
 * Design: ainative docs/design/20261122-celo-stablecoins-payin-implementation.zh.md A2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CELO_MIN_LINK_LIFE_MS, handleCreateInvoice, resolveSource } from '../src/routes/create-invoice'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import {
  STABLE_SOURCES,
  parseNativeSources,
  signTestPaymentId,
  stableTokensFor,
  supportedSources,
  withBetaSources,
} from '../src/routes/native-sources'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const SESSION_ID = 'paymentSession_celo_beta_test'
const PROD_NATIVE = 'ETH@8453,ETH@1,BNB@56,SOL@900,ETH@42161,POL@137'
const CELO_USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'
const CELO = { chainId: '42220', tokenSymbol: 'USDT' }

function makeKvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  }
}

function makeEnv(extra: Record<string, string> = {}): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    ATOMIC_STORE: makeAtomicStoreMock(),
    ROZO_TEST_LINK_SECRET: 'test-link-secret',
    MPP_STORE: makeKvStub(),
    NATIVE_SOURCES: PROD_NATIVE,
    NATIVE_SOURCES_BETA: 'ZEC@9133,BTC@9000,USDT@42220,USDC@42220',
    ZEC_RAIL: 'custody',
    ...extra,
  } as unknown as Env
}

let createdIntent: any = null
let createCalls = 0
let linkExpiresAt: string | null = null
let checkoutCalls = 0
let existingOrder: any = null
let conflictWinner: any = null
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

beforeEach(() => {
  createdIntent = null
  createCalls = 0
  checkoutCalls = 0
  existingOrder = null
  conflictWinner = null
  linkExpiresAt = inMinutes(24 * 60)
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('payments.coinbase.com/next-api/')) {
      if (!linkExpiresAt) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({
        paymentSessionId: SESSION_ID,
        status: 'PAYMENT_SESSION_STATUS_CREATED',
        amount: '5.00',
        asset: 'usdc',
        expiresAt: linkExpiresAt,
        customerDisplay: { merchantName: 'OpenRouter, Inc' },
        target: {
          paymentTargetWallet: {
            address: '0x4C3f2E391498e2590bd327a7A1CAA68Dd42c4647',
            network: 'PAYMENT_TARGET_NETWORK_BASE',
          },
        },
      }), { status: 200 })
    }
    if (u.includes('/quote-invoice')) {
      return new Response(JSON.stringify({ invoice: { amount: '5.00' }, merchant: 'OpenRouter, Inc', linkId: SESSION_ID }), { status: 200 })
    }
    if (u.includes('/payments/order/')) {
      if (existingOrder && u.endsWith(`/${SESSION_ID}`)) return new Response(JSON.stringify(existingOrder), { status: 200 })
      return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    if (u.includes('/checkout') && init?.method === 'POST') {
      checkoutCalls++
      return new Response('{"error":{"code":"invalidRequest"}}', { status: 400 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createCalls++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      // Slot race: a concurrent create won this orderId first.
      if (conflictWinner) {
        existingOrder = conflictWinner
        return new Response('{"error":{"code":"orderIdConflict","message":"orderIdConflict"}}', { status: 409 })
      }
      return new Response(JSON.stringify({
        id: 'rozo-pay-celo',
        status: 'payment_unpaid',
        paymentLink: 'https://pay.rozo.ai/c',
        expiresAt: '2999-01-01T01:00:00.000Z',
        source: {
          chainId: '42220',
          tokenSymbol: 'USDT',
          tokenAddress: CELO_USDT,
          amount: '5.05',
          receiverAddress: '0x1111111111111111111111111111111111111111',
        },
        destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '5.00' },
      }), { status: 200 })
    }
    // Re-read of a live order by id (after a failed /checkout rotation).
    if (existingOrder && u.endsWith(`/payments/${existingOrder.id}`)) {
      return new Response(JSON.stringify(existingOrder), { status: 200 })
    }
    if (u.includes('/payment-api/payments/')) {
      return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

async function post(
  handler: (r: Request, e: Env) => Promise<Response>,
  body: Record<string, unknown>,
  { env = makeEnv(), query = '' }: { env?: Env; query?: string } = {},
) {
  const res = await handler(
    new Request(`https://mpp.test/x${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

describe('Celo USDT beta source: opening rules', () => {
  const base = parseNativeSources(PROD_NATIVE)

  it('is not a default stable source', () => {
    expect(STABLE_SOURCES['42220']).toBeUndefined()
    expect(supportedSources(STABLE_SOURCES, base)['42220']).toBeUndefined()
    expect(stableTokensFor('42220', base)).toBeUndefined()
  })

  it('opens only with USDT@42220 in NATIVE_SOURCES_BETA AND ?beta=celo', () => {
    const on = withBetaSources(base, 'ZEC@9133,USDT@42220', 'https://x/q?beta=celo')
    expect(on.has('USDT@42220')).toBe(true)
    expect(supportedSources(STABLE_SOURCES, on)['42220']).toEqual(['USDT'])
    expect(stableTokensFor('42220', on)).toEqual(['USDT'])

    expect(withBetaSources(base, 'ZEC@9133,USDT@42220', 'https://x/q').has('USDT@42220')).toBe(false)
    expect(withBetaSources(base, 'ZEC@9133,BTC@9000', 'https://x/q?beta=celo').has('USDT@42220')).toBe(false)
    expect(withBetaSources(base, '', 'https://x/q?beta=celo').has('USDT@42220')).toBe(false)
    // Its token symbol is not its param: ?beta=usdt never opens it.
    expect(withBetaSources(base, 'USDT@42220', 'https://x/q?beta=usdt').has('USDT@42220')).toBe(false)
    // ?beta=celo opens nothing else.
    const celoOnly = withBetaSources(base, 'ZEC@9133,BTC@9000,USDT@42220', 'https://x/q?beta=celo')
    expect(celoOnly.has('ZEC@9133')).toBe(false)
    expect(celoOnly.has('BTC@9000')).toBe(false)
  })

  it('?beta=btc,celo (what the /celo page sends) opens BTC and Celo USDT, each independently', () => {
    const both = withBetaSources(base, 'ZEC@9133,BTC@9000,USDT@42220', 'https://x/q?beta=btc,celo')
    expect(both.has('BTC@9000')).toBe(true)
    expect(both.has('USDT@42220')).toBe(true)
    expect(both.has('ZEC@9133')).toBe(false)
    const sup = supportedSources(STABLE_SOURCES, both)
    expect(sup['42220']).toEqual(['USDT'])
    expect(sup['9000']).toEqual(['BTC'])
    // Without the Celo env key, btc still opens and Celo stays closed.
    const btcOnly = withBetaSources(base, 'ZEC@9133,BTC@9000', 'https://x/q?beta=btc,celo')
    expect(btcOnly.has('BTC@9000')).toBe(true)
    expect(btcOnly.has('USDT@42220')).toBe(false)
    // Repeated params work the same as a comma list.
    expect(withBetaSources(base, 'BTC@9000,USDT@42220', 'https://x/q?beta=btc&beta=celo').has('USDT@42220')).toBe(true)
  })

  it('resolveSource: Celo USDT resolves to the Celo USDT contract only when open', () => {
    const closed = resolveSource(CELO, base) as any
    expect(closed.error.code).toBe('UNSUPPORTED_SOURCE')
    const open = resolveSource(CELO, withBetaSources(base, 'USDT@42220', 'https://x/q?beta=celo')) as any
    expect(open.resolved).toMatchObject({ chainId: '42220', tokenSymbol: 'USDT', tokenAddress: CELO_USDT })
    // Celo USDC is not opened by the USDT key.
    const usdc = resolveSource({ chainId: '42220', tokenSymbol: 'USDC' }, withBetaSources(base, 'USDT@42220', 'https://x/q?beta=celo')) as any
    expect(usdc.error.code).toBe('UNSUPPORTED_SOURCE')
  })
})

describe('quote-invoice with Celo USDT', () => {
  it('default: no 42220; with ?beta=celo: Celo USDT listed and nothing else changes', async () => {
    const plain = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID })
    const beta = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { query: '?beta=celo' })
    expect(plain.status).toBe(200)
    expect(plain.json.supportedSources['42220']).toBeUndefined()
    expect(beta.status).toBe(200)
    expect(beta.json.supportedSources['42220']).toEqual(['USDT', 'USDC'])
    const strip = (j: any) => {
      const sup = { ...j.supportedSources }
      delete sup['42220']
      return { sup, callerPays: j.callerPays, title: j.title, sourceMeta: j.sourceMeta }
    }
    expect(strip(beta.json)).toEqual(strip(plain.json))
  })

  it('only USDT@42220 in NATIVE_SOURCES_BETA: Celo USDT listed, Celo USDC not', async () => {
    const r = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: makeEnv({ NATIVE_SOURCES_BETA: 'USDT@42220' }), query: '?beta=celo' })
    expect(r.json.supportedSources['42220']).toEqual(['USDT'])
  })

  it('NATIVE_SOURCES_BETA without USDT@42220: hidden even with ?beta=celo', async () => {
    const r = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: makeEnv({ NATIVE_SOURCES_BETA: 'ZEC@9133,BTC@9000' }), query: '?beta=celo' })
    expect(r.json.supportedSources['42220']).toBeUndefined()
  })
})

describe('create-invoice with Celo USDT', () => {
  it('closed (no ?beta=celo): 400 UNSUPPORTED_SOURCE, no upstream create', async () => {
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('UNSUPPORTED_SOURCE')
    expect(createCalls).toBe(0)
  })

  it('link that expires within CELO_MIN_LINK_LIFE_MS, or unknown expiry: refused before any create', async () => {
    expect(CELO_MIN_LINK_LIFE_MS).toBe(100 * 60_000)
    linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS - 60_000).toISOString()
    const short = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
    expect(short.status).toBe(400)
    expect(short.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(short.json.message).toContain('Celo')
    linkExpiresAt = null
    const unknown = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
    expect(unknown.status).toBe(400)
    expect(unknown.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
  })

  it('a live Base order is never rotated onto Celo when the link is too short: refused before /checkout', async () => {
    existingOrder = {
      id: 'rozo-pay-base',
      appId: 'merchant_openrouter',
      orderId: SESSION_ID,
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '5.05', receiverAddress: '0x2222222222222222222222222222222222222222' },
      destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '5.00' },
    }
    linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS - 60_000).toISOString()
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(checkoutCalls).toBe(0)
    expect(createCalls).toBe(0)
  })

  it('a Stripe invoice never creates a Celo order', async () => {
    const r = await post(handleCreateInvoice, { url: 'https://crypto.stripe.com/pay/cs_live_celotest', source: CELO }, { query: '?beta=celo' })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('UNSUPPORTED_SOURCE')
    expect(createCalls).toBe(0)
  })

  it('?beta=btc,celo create: Celo USDT order is created', async () => {
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=btc,celo' })
    expect(createCalls).toBe(1)
    expect(createdIntent.source).toMatchObject({ chainId: '42220', tokenSymbol: 'USDT', tokenAddress: CELO_USDT })
    expect(r.status).toBeLessThan(300)
    const q = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { query: '?beta=btc,celo' })
    expect(q.json.supportedSources['42220']).toEqual(['USDT', 'USDC'])
    expect(q.json.supportedSources['9000']).toEqual(['BTC'])
  })

  describe('a live Celo order reused for a request of another coin', () => {
    const BASE_USDC = { chainId: '8453', tokenSymbol: 'USDC' }
    // The live order is the one a real ?beta=celo create would have made
    // (same pricing metadata and amount), so only the Celo gates differ.
    const liveCelo = async () => {
      const made = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
      expect(made.status).toBeLessThan(300)
      const intent = createdIntent
      createCalls = 0
      return {
        id: 'rozo-pay-celo-live',
        appId: 'merchant_openrouter',
        orderId: SESSION_ID,
        status: 'payment_unpaid',
        paymentLink: 'https://pay.rozo.ai/celo-live',
        expiresAt: '2999-01-01T01:00:00.000Z',
        metadata: intent.metadata,
        source: {
          chainId: '42220',
          tokenSymbol: 'USDT',
          tokenAddress: CELO_USDT,
          amount: intent.source.amount,
          receiverAddress: '0x3333333333333333333333333333333333333333',
        },
        destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '5.00' },
      }
    }
    const expectNoPayInstructions = (j: any) => {
      expect(j.raw).toBeUndefined()
      expect(j.paymentLink).toBeUndefined()
      expect(JSON.stringify(j)).not.toContain('0x3333333333333333333333333333333333333333')
      expect(JSON.stringify(j)).not.toContain('pay.rozo.ai/celo-live')
    }

    it('without ?beta=celo: rotation fails, the Celo order is not handed out (409 CELO_NOT_ENABLED)', async () => {
      existingOrder = await liveCelo()
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC })
      expect(checkoutCalls).toBe(1)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('CELO_NOT_ENABLED')
      expect(r.json.rozoPaymentId).toBe('rozo-pay-celo-live')
      expectNoPayInstructions(r.json)
      expect(createCalls).toBe(0)
    })

    it('USDT@42220 removed from NATIVE_SOURCES_BETA: refused even with ?beta=celo', async () => {
      existingOrder = await liveCelo()
      const env = makeEnv({ NATIVE_SOURCES_BETA: 'ZEC@9133,BTC@9000' })
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC }, { env, query: '?beta=celo' })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('CELO_NOT_ENABLED')
      expectNoPayInstructions(r.json)
    })

    it('beta open but the link expires within CELO_MIN_LINK_LIFE_MS, or unknown expiry: refused', async () => {
      existingOrder = await liveCelo()
      linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS - 60_000).toISOString()
      const short = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC }, { query: '?beta=celo' })
      expect(short.status).toBe(400)
      expect(short.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
      expect(short.json.message).toContain('Celo')
      expectNoPayInstructions(short.json)
      linkExpiresAt = null
      const unknown = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC }, { query: '?beta=celo' })
      expect(unknown.status).toBe(400)
      expect(unknown.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
      expectNoPayInstructions(unknown.json)
    })

    it('create conflict: a plain request that loses the slot to a Celo order does not get it without ?beta=celo', async () => {
      conflictWinner = await liveCelo()
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC })
      expect(createCalls).toBe(1)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('CELO_NOT_ENABLED')
      expect(r.json.rozoPaymentId).toBe('rozo-pay-celo-live')
      expectNoPayInstructions(r.json)
    })

    it('create conflict: Celo winner with beta open but a short link: refused', async () => {
      conflictWinner = await liveCelo()
      linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS - 60_000).toISOString()
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC }, { query: '?beta=celo' })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
      expectNoPayInstructions(r.json)
    })

    it('create conflict control: Celo winner with beta open and a long link is handed back', async () => {
      conflictWinner = await liveCelo()
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC }, { query: '?beta=celo' })
      expect(r.status).toBe(200)
      expect(r.json.paymentLink).toBe('https://pay.rozo.ai/celo-live')
    })

    it('non-Celo control: a live Base order reused for a plain request is unchanged (no Celo gate)', async () => {
      const celo = await liveCelo()
      existingOrder = {
        ...celo,
        id: 'rozo-pay-base-live',
        paymentLink: 'https://pay.rozo.ai/base-live',
        source: { chainId: '8453', tokenSymbol: 'USDC', amount: celo.source.amount, receiverAddress: '0x2222222222222222222222222222222222222222' },
      }
      linkExpiresAt = null // a Celo gate would refuse on unknown expiry; a Base row must not care
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC })
      expect(r.status).toBe(200)
      expect(r.json.reused).toBe(true)
      expect(r.json.paymentLink).toBe('https://pay.rozo.ai/base-live')
      expect(checkoutCalls).toBe(0)
    })

    it('control: beta open and the link lives long enough: the Celo order is reused with sourceMismatch', async () => {
      existingOrder = await liveCelo()
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BASE_USDC }, { query: '?beta=celo' })
      expect(r.status).toBe(200)
      expect(r.json.reused).toBe(true)
      expect(r.json.sourceMismatch).toBe(true)
      expect(r.json.source).toMatchObject({ chainId: '42220', tokenSymbol: 'USDT' })
      expect(r.json.paymentLink).toBe('https://pay.rozo.ai/celo-live')
    })
  })

  it('fresh create: a link that crosses CELO_MIN_LINK_LIFE_MS during the upstream create is refused at hand-out', async () => {
    const realNow = Date.now.bind(Date)
    let offset = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    linkExpiresAt = new Date(realNow() + CELO_MIN_LINK_LIFE_MS + 30_000).toISOString()
    const fetchMock = globalThis.fetch as any
    const inner = fetchMock.getMockImplementation()
    fetchMock.mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('/payment-api') && init?.method === 'POST') offset += 60_000 // the create takes a minute
      return inner(input, init)
    })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
    expect(createCalls).toBe(1)
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(r.json.raw).toBeUndefined()
    expect(r.json.paymentLink).toBeUndefined()
  })

  describe('Celo USDC (USDC@42220)', () => {
    const CELO_USDC_SRC = { chainId: '42220', tokenSymbol: 'USDC' }
    const CELO_USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'

    it('closed without ?beta=celo, and closed when only USDT@42220 is listed', async () => {
      const plain = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO_USDC_SRC })
      expect(plain.status).toBe(400)
      expect(plain.json.code).toBe('UNSUPPORTED_SOURCE')
      const usdtOnly = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO_USDC_SRC }, { env: makeEnv({ NATIVE_SOURCES_BETA: 'USDT@42220' }), query: '?beta=celo' })
      expect(usdtOnly.status).toBe(400)
      expect(usdtOnly.json.code).toBe('UNSUPPORTED_SOURCE')
      expect(createCalls).toBe(0)
    })

    it('link shorter than CELO_MIN_LINK_LIFE_MS or unknown: refused before any create', async () => {
      linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS - 60_000).toISOString()
      const short = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO_USDC_SRC }, { query: '?beta=celo' })
      expect(short.status).toBe(400)
      expect(short.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
      linkExpiresAt = null
      const unknown = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO_USDC_SRC }, { query: '?beta=celo' })
      expect(unknown.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
      expect(createCalls).toBe(0)
    })

    it('open and the link lives long enough: creates upstream with the Celo USDC contract', async () => {
      linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS + 10 * 60_000).toISOString()
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO_USDC_SRC }, { query: '?beta=celo' })
      expect(createCalls).toBe(1)
      expect(createdIntent.source).toMatchObject({ chainId: '42220', tokenSymbol: 'USDC', tokenAddress: CELO_USDC })
      expect(r.status).toBeLessThan(300)
    })

    it('a live Celo USDC order reused for a Base request: refused when USDC@42220 is not open, even with USDT@42220 open', async () => {
      // Same pricing metadata a real ?beta=celo USDC create writes.
      const made = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO_USDC_SRC }, { query: '?beta=celo' })
      expect(made.status).toBeLessThan(300)
      const intent = createdIntent
      createCalls = 0
      existingOrder = {
        id: 'rozo-pay-celo-usdc',
        appId: 'merchant_openrouter',
        orderId: SESSION_ID,
        status: 'payment_unpaid',
        paymentLink: 'https://pay.rozo.ai/celo-usdc',
        expiresAt: '2999-01-01T01:00:00.000Z',
        metadata: intent.metadata,
        source: { chainId: '42220', tokenSymbol: 'USDC', tokenAddress: CELO_USDC, amount: intent.source.amount, receiverAddress: '0x4444444444444444444444444444444444444444' },
        destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '5.00' },
      }
      // Control: with USDC@42220 open the same order is handed back.
      const open = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'USDC' } }, { query: '?beta=celo' })
      expect(open.status).toBe(200)
      expect(open.json.paymentLink).toBe('https://pay.rozo.ai/celo-usdc')
      const env = makeEnv({ NATIVE_SOURCES_BETA: 'USDT@42220' })
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'USDC' } }, { env, query: '?beta=celo' })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('CELO_NOT_ENABLED')
      expect(JSON.stringify(r.json)).not.toContain('0x4444444444444444444444444444444444444444')
      expect(r.json.paymentLink).toBeUndefined()
    })

    it('a live Celo order with an unknown coin is never handed out', async () => {
      existingOrder = {
        id: 'rozo-pay-celo-odd',
        appId: 'merchant_openrouter',
        orderId: SESSION_ID,
        status: 'payment_unpaid',
        paymentLink: 'https://pay.rozo.ai/celo-odd',
        expiresAt: '2999-01-01T01:00:00.000Z',
        source: { chainId: '42220', tokenSymbol: 'CELO', amount: '5.05', receiverAddress: '0x5555555555555555555555555555555555555555' },
        destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '5.00' },
      }
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'USDC' } }, { query: '?beta=celo' })
      expect(r.json.paymentLink).toBeUndefined()
      expect(JSON.stringify(r.json)).not.toContain('0x5555555555555555555555555555555555555555')
    })
  })

  describe('internal test invoice (rozotest_) with ?beta=celo', () => {
    it('Celo USDT and USDC open with ?beta=celo, the synthetic 24 h link passes the 100 minute check', async () => {
      const id = await signTestPaymentId('test-link-secret', 10, 'celotest1')
      linkExpiresAt = null // a test invoice has no Coinbase link; it must not depend on one
      for (const tokenSymbol of ['USDT', 'USDC']) {
        createCalls = 0
        const r = await post(handleCreateInvoice, { payment_id: id, source: { chainId: '42220', tokenSymbol } }, { query: '?beta=celo' })
        expect(r.status).toBeLessThan(300)
        expect(createCalls).toBe(1)
        expect(createdIntent.source).toMatchObject({ chainId: '42220', tokenSymbol })
        expect(createdIntent.metadata.testMode).toBe(true)
      }
    })

    it('without ?beta=celo a test invoice cannot use Celo either', async () => {
      const id = await signTestPaymentId('test-link-secret', 10, 'celotest2')
      const r = await post(handleCreateInvoice, { payment_id: id, source: { chainId: '42220', tokenSymbol: 'USDC' } })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('UNSUPPORTED_SOURCE')
      expect(createCalls).toBe(0)
    })

    it('quote for a test invoice lists Celo USDT and USDC only with ?beta=celo', async () => {
      const id = await signTestPaymentId('test-link-secret', 10, 'celotest3')
      const plain = await post(handleQuoteInvoice as any, { payment_id: id })
      const beta = await post(handleQuoteInvoice as any, { payment_id: id }, { query: '?beta=celo' })
      expect(plain.json.supportedSources['42220']).toBeUndefined()
      expect(beta.json.supportedSources['42220']).toEqual(['USDT', 'USDC'])
    })
  })

  it('open and the link lives long enough: creates upstream with the Celo USDT contract', async () => {
    linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS + 10 * 60_000).toISOString()
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
    expect(createCalls).toBe(1)
    expect(createdIntent.source).toMatchObject({ chainId: '42220', tokenSymbol: 'USDT', tokenAddress: CELO_USDT })
    expect(r.status).toBeLessThan(300)
  })
})
