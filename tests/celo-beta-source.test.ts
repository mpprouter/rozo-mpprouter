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
    NATIVE_SOURCES_BETA: 'ZEC@9133,BTC@9000,USDT@42220',
    ZEC_RAIL: 'custody',
    ...extra,
  } as unknown as Env
}

let createdIntent: any = null
let createCalls = 0
let linkExpiresAt: string | null = null
let checkoutCalls = 0
let existingOrder: any = null
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

beforeEach(() => {
  createdIntent = null
  createCalls = 0
  checkoutCalls = 0
  existingOrder = null
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
    expect(beta.json.supportedSources['42220']).toEqual(['USDT'])
    const strip = (j: any) => {
      const sup = { ...j.supportedSources }
      delete sup['42220']
      return { sup, callerPays: j.callerPays, title: j.title, sourceMeta: j.sourceMeta }
    }
    expect(strip(beta.json)).toEqual(strip(plain.json))
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
    expect(q.json.supportedSources['42220']).toEqual(['USDT'])
    expect(q.json.supportedSources['9000']).toEqual(['BTC'])
  })

  it('open and the link lives long enough: creates upstream with the Celo USDT contract', async () => {
    linkExpiresAt = new Date(Date.now() + CELO_MIN_LINK_LIFE_MS + 10 * 60_000).toISOString()
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: CELO }, { query: '?beta=celo' })
    expect(createCalls).toBe(1)
    expect(createdIntent.source).toMatchObject({ chainId: '42220', tokenSymbol: 'USDT', tokenAddress: CELO_USDT })
    expect(r.status).toBeLessThan(300)
  })
})
