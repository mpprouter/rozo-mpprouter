/**
 * Native coin sources (ETH/BNB/SOL) and internal rozotest_ invoices.
 *
 * Native checkout opens per chain via NATIVE_SOURCES; rozo-intents-api is the
 * final gate and quotes the coin amount. A native order is exactOut to the
 * settlement wallet, like Lightning. rozotest_ invoices are signed with
 * ROZO_TEST_LINK_SECRET, skip the Coinbase quote, open every native coin and
 * are closed by the webhook as test_settled instead of paying Coinbase.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice, nativeQuoteFields, resolveSource } from '../src/routes/create-invoice'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import {
  ALL_NATIVE_SOURCES,
  STABLE_SOURCES,
  parseNativeSources,
  signTestPaymentId,
  supportedSources,
  verifyTestPaymentId,
} from '../src/routes/native-sources'
import type { Env } from '../src/index'

const SECRET = 'test-link-secret'

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
    ROZO_TEST_LINK_SECRET: SECRET,
    MPP_STORE: makeKvStub(),
    ...extra,
  } as unknown as Env
}

let createdIntent: any = null
let quoteCalls = 0

beforeEach(() => {
  createdIntent = null
  quoteCalls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) {
      quoteCalls++
      return new Response(JSON.stringify({
        invoice: { amount: '10.5' },
        merchant: 'OpenRouter, Inc',
        linkId: 'paymentSession_native_test',
      }), { status: 200 })
    }
    if (u.includes('/payments/order/')) return new Response('not found', { status: 404 })
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({
        id: 'rozo-pay-native',
        paymentLink: 'https://pay.rozo.ai/n',
        expiresAt: '2999-01-01T12:00:00.000Z',
        quoteExpiresAt: '2999-01-01T00:00:00.000Z',
        source: { amount: '0.00388', chainId: createdIntent?.source?.chainId },
      }), { status: 200 })
    }
    if (u.includes('/payment-api')) return new Response(JSON.stringify({ status: 'payment_unpaid' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

async function post(handler: typeof handleCreateInvoice, body: Record<string, unknown>, env = makeEnv()) {
  const res = await handler(
    new Request('https://mpp.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

describe('native source table', () => {
  it('parses only the four supported native coins', () => {
    expect([...parseNativeSources('eth@8453, BNB@56,SOL@900,ETH@42161,POL@137,ETH@137,garbage')].sort())
      .toEqual(['BNB@56', 'ETH@42161', 'ETH@8453', 'SOL@900'])
    expect(parseNativeSources(undefined).size).toBe(0)
  })

  it('adds only open native coins to the supported list', () => {
    const none = supportedSources(STABLE_SOURCES, new Set())
    expect(none['8453']).toEqual(['USDC'])
    const some = supportedSources(STABLE_SOURCES, parseNativeSources('ETH@8453,SOL@900'))
    expect(some['8453']).toEqual(['USDC', 'ETH'])
    expect(some['900']).toEqual(['USDC', 'USDT', 'SOL'])
    expect(some['56']).toEqual(['USDC', 'USDT'])
  })

  it('resolveSource rejects a native coin that is not open and resolves one that is', () => {
    const closed = resolveSource({ chainId: '8453', tokenSymbol: 'ETH' })
    expect(closed.error?.code).toBe('UNSUPPORTED_SOURCE')
    expect(closed.error?.supported?.['8453']).toEqual(['USDC'])
    const open = resolveSource({ chainId: '56', tokenSymbol: 'bnb' }, parseNativeSources('BNB@56'))
    expect(open.resolved).toMatchObject({
      chainId: '56', tokenSymbol: 'BNB', tokenAddress: '0x0000000000000000000000000000000000000000',
    })
    const sol = resolveSource({ chainId: '900', tokenSymbol: 'SOL' }, ALL_NATIVE_SOURCES)
    expect(sol.resolved?.tokenAddress).toBe('native')
    // Stablecoins are unaffected.
    expect(resolveSource({ chainId: '56', tokenSymbol: 'USDT' }).resolved?.tokenSymbol).toBe('USDT')
  })
})

describe('rozotest_ payment ids', () => {
  it('round-trips and rejects tampering, wrong secret, no secret and >$20', async () => {
    const id = await signTestPaymentId(SECRET, 150, 'abc123def')
    expect(id).toMatch(/^rozotest_150_abc123def_[0-9a-f]{16}$/)
    expect(await verifyTestPaymentId(SECRET, id)).toBe(150)
    expect(await verifyTestPaymentId('other', id)).toBeNull()
    expect(await verifyTestPaymentId(undefined, id)).toBeNull()
    expect(await verifyTestPaymentId(SECRET, id.replace('rozotest_150', 'rozotest_151'))).toBeNull()
    expect(await verifyTestPaymentId(SECRET, 'rozotest_2001_abc123def_0000000000000000')).toBeNull()
    await expect(signTestPaymentId(SECRET, 2001, 'abc123def')).rejects.toThrow()
  })
})

describe('quote-invoice', () => {
  it('quotes a test id locally, priced exactly like a real invoice, with every native coin', async () => {
    const id = await signTestPaymentId(SECRET, 100, 'quoteq1')
    const { status, json } = await post(handleQuoteInvoice as any, { payment_id: id }, makeEnv({ CHECKOUT_WEB_FEE_BPS: '100' }))
    expect(status).toBe(200)
    expect(quoteCalls).toBe(0)
    expect(json).toMatchObject({ testInvoice: true, callerPays: '1.01', feeBps: 100, linkId: id })
    expect(json.supportedSources['1']).toContain('ETH')
    expect(json.supportedSources['56']).toContain('BNB')
    expect(json.supportedSources['900']).toContain('SOL')
    expect(typeof json.quoteReceipt).toBe('string')
  })

  it('rejects an unsigned test id', async () => {
    const { status, json } = await post(handleQuoteInvoice as any, { payment_id: 'rozotest_100_quoteq1_0000000000000000' })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_INPUT')
    expect(quoteCalls).toBe(0)
  })

  it('reports supportedSources from NATIVE_SOURCES on a real quote', async () => {
    const { json } = await post(handleQuoteInvoice as any, { payment_id: 'paymentSession_native_test' }, makeEnv({ NATIVE_SOURCES: 'ETH@8453' }))
    expect(json.supportedSources['8453']).toEqual(['USDC', 'ETH'])
    expect(json.supportedSources['900']).not.toContain('SOL')
  })
})

describe('create-invoice with a native source', () => {
  it('rejects native on a real invoice while NATIVE_SOURCES is unset', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: 'paymentSession_native_test', source: { chainId: '8453', tokenSymbol: 'ETH' },
    })
    expect(status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_SOURCE')
    expect(createdIntent).toBeNull()
  })

  it('creates an exactOut merchant_openrouter order when the coin is open', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: 'paymentSession_native_test', source: { chainId: '8453', tokenSymbol: 'ETH' },
    }, makeEnv({ NATIVE_SOURCES: 'ETH@8453' }))
    expect(status).toBe(200)
    expect(createdIntent).toMatchObject({
      appId: 'merchant_openrouter',
      type: 'exactOut',
      source: { chainId: '8453', tokenSymbol: 'ETH' },
      destination: { chainId: '8453', tokenSymbol: 'USDC', amount: json.callerPays },
    })
    expect(createdIntent.source.amount).toBeUndefined()
    expect(json.quoteExpiresAt).toBe('2999-01-01T00:00:00.000Z')
    expect(json.nativeAmount).toBe('0.00388')
  })

  it('caps callerPays with NATIVE_MAX_USD', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: 'paymentSession_native_test', source: { chainId: '8453', tokenSymbol: 'ETH' },
    }, makeEnv({ NATIVE_SOURCES: 'ETH@8453', NATIVE_MAX_USD: '10' }))
    expect(status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_SOURCE')
    expect(createdIntent).toBeNull()
  })

  it('creates a test invoice order with any native coin and no Coinbase quote', async () => {
    const id = await signTestPaymentId(SECRET, 150, 'create01')
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: id, source: { chainId: '900', tokenSymbol: 'SOL' },
    })
    expect(status).toBe(200)
    expect(quoteCalls).toBe(0)
    expect(json.testInvoice).toBe(true)
    expect(createdIntent).toMatchObject({
      appId: 'merchant_openrouter',
      orderId: id,
      type: 'exactOut',
      source: { chainId: '900', tokenSymbol: 'SOL' },
      destination: { amount: '1.5' },
    })
  })
})

describe('test invoice with the production fee', () => {
  it('quote -> create with the signed receipt, like the browser', async () => {
    const env = makeEnv({ CHECKOUT_WEB_FEE_BPS: '100' })
    const id = await signTestPaymentId(SECRET, 200, 'withfee1')
    const q = await post(handleQuoteInvoice as any, { payment_id: id }, env)
    const c = await post(handleCreateInvoice, {
      payment_id: id, source: { chainId: '56', tokenSymbol: 'BNB' }, quoteReceipt: q.json.quoteReceipt,
    }, env)
    expect(c.status).toBe(200)
    expect(createdIntent).toMatchObject({ type: 'exactOut', source: { chainId: '56', tokenSymbol: 'BNB' }, destination: { amount: '2.02' } })
  })
})

describe('reusing an unpaid native order', () => {
  it('matches pricing on the USD destination, not the coin amount', async () => {
    const env = makeEnv({ NATIVE_SOURCES: 'ETH@1' })
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('/quote-invoice')) {
        return new Response(JSON.stringify({ invoice: { amount: '10.5' }, merchant: 'OpenRouter, Inc', linkId: 'paymentSession_native_test' }), { status: 200 })
      }
      if (u.includes('/payments/order/')) {
        return new Response(JSON.stringify({
          id: 'rozo-pay-existing',
          status: 'payment_unpaid',
          expiresAt: '2999-01-01T12:00:00.000Z',
          quoteExpiresAt: '2999-01-01T00:00:00.000Z',
          source: { chainId: '1', tokenSymbol: 'ETH', amount: '0.00388' },
          destination: { amount: '10.5' },
          metadata: { original: '10.5', serviceFee: '0', callerPays: '10.5', feeBps: 0, pricingVersion: 'checkout-web-fee-v3' },
        }), { status: 200 })
      }
      if (u.includes('/payment-api')) return new Response(JSON.stringify({ status: 'payment_unpaid' }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch)
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: 'paymentSession_native_test', source: { chainId: '1', tokenSymbol: 'ETH' },
    }, env)
    expect(json.error?.code).not.toBe('LEGACY_PRICING_ORDER_PENDING')
    expect(status).toBe(200)
    expect(json).toMatchObject({ reused: true, rozoPaymentId: 'rozo-pay-existing', nativeAmount: '0.00388' })
  })
})

describe('nativeQuoteFields', () => {
  it('flags an expired price lock on a reused order', () => {
    const past = nativeQuoteFields({ quoteExpiresAt: '2000-01-01T00:00:00.000Z', source: { amount: '0.1' } })
    expect(past).toMatchObject({ quoteExpired: true, nativeAmount: '0.1' })
    const future = nativeQuoteFields({ quoteExpiresAt: '2999-01-01T00:00:00.000Z' })
    expect(future.quoteExpired).toBeUndefined()
    expect(nativeQuoteFields({ expiresAt: 'x' })).toEqual({})
  })
})

describe('checkout test mode: $0.10 test order on BNB Chain USDC', () => {
  it('keeps the standard settlement destination and tags metadata.testMode', async () => {
    const id = await signTestPaymentId(SECRET, 10, 'tenccent1')
    const { status, json } = await post(handleCreateInvoice, { payment_id: id, source: { chainId: '56', tokenSymbol: 'USDC' } })
    expect(status).toBe(200)
    expect(json.testInvoice).toBe(true)
    expect(quoteCalls).toBe(0)
    expect(createdIntent).toMatchObject({
      appId: 'merchant_openrouter',
      orderId: id,
      type: 'exactIn',
      source: { chainId: '56', tokenSymbol: 'USDC', amount: '0.1' },
      // Unchanged by test mode: Base USDC to the funder/settlement wallet.
      destination: { chainId: '8453', receiverAddress: '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739', tokenSymbol: 'USDC' },
      metadata: { testMode: true },
    })
  })

  it('real orders carry no testMode tag', async () => {
    await post(handleCreateInvoice, { payment_id: 'paymentSession_native_test' })
    expect(createdIntent.metadata.testMode).toBeUndefined()
  })
})

describe('Arbitrum ETH native source (founder 2026-10-06)', () => {
  it('is offered only when ETH@42161 is open, with the zero token address', () => {
    expect(supportedSources(STABLE_SOURCES, parseNativeSources('ETH@8453'))['42161']).toEqual(['USDC', 'USDT'])
    expect(supportedSources(STABLE_SOURCES, parseNativeSources('ETH@8453,ETH@42161'))['42161']).toEqual(['USDC', 'USDT', 'ETH'])
    const arb = resolveSource({ chainId: '42161', tokenSymbol: 'ETH' }, parseNativeSources('ETH@42161'))
    expect(arb.resolved).toMatchObject({ chainId: '42161', tokenSymbol: 'ETH', tokenAddress: '0x0000000000000000000000000000000000000000' })
    expect(resolveSource({ chainId: '42161', tokenSymbol: 'ETH' }, parseNativeSources('ETH@8453')).error?.code).toBe('UNSUPPORTED_SOURCE')
  })
})
