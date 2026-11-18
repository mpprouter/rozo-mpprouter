/**
 * On-chain BTC (chain 9000, Beta test version, founder 2026-11-18) behind
 * ?beta=btc + NATIVE_SOURCES_BETA "BTC@9000".
 *
 * Invariants under test:
 *   I1 an on-chain BTC order never goes down the Lightning path, and a
 *      Lightning order never receives a bc1q (on-chain) address;
 *   I2 without BTC@9000 in NATIVE_SOURCES_BETA (or without ?beta=btc) every
 *      on-chain BTC entry refuses exactly like an unknown coin;
 *   I3 the router trusts only rozo-intents-api for amount, address and
 *      confirmation state, never the client;
 *   I4 test-period band $0.50 to $1.00 gross per invoice, code constants,
 *      config may only lower the cap;
 * plus replay and out-of-order cases (duplicate create, status before
 * create, query after expiry).
 */

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BTC_CODE_MESSAGES,
  BTC_ONCHAIN_MIN_LINK_LIFE_MS,
  btcRailViolation,
  btcUpstreamError,
  handleCreateInvoice,
  resolveSource,
} from '../src/routes/create-invoice'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import { btcQuoteExpiredUnfunded, custodyQuoteExpiredUnfunded, zecQuoteExpiredUnfunded } from '../src/routes/relink-guard'
import { isLive } from '../src/routes/existing-order'
import { handleInvoiceStatus, pickBtcCustodyStatus, pickRozoCallerSafe } from '../src/routes/webhook'
import {
  ALL_NATIVE_SOURCES,
  BTC_ONCHAIN_BETA_MAX_USD,
  BTC_ONCHAIN_BETA_MIN_USD,
  BTC_ONCHAIN_MAX_USD,
  BTC_ONCHAIN_MIN_USD,
  NATIVE_SOURCE_DEFS,
  btcOnchainMinUsd,
  btcOnchainRequiredConfirmations,
  nativeMaxUsdFor,
  parseBtcOnchainLimits,
  STABLE_SOURCES,
  btcOnchainMaxUsd,
  isBtcOnchain,
  isBtcP2wpkhAddress,
  nativeMinUsd,
  parseBetaNativeSources,
  parseNativeSources,
  signTestPaymentId,
  sourceMeta,
  supportedSources,
  withBetaSources,
} from '../src/routes/native-sources'
import type { Env } from '../src/index'

const SECRET = 'test-link-secret'
const SESSION_ID = 'paymentSession_btc_onchain_test'
const PROD_NATIVE = 'ETH@8453,ETH@1,BNB@56,SOL@900,ETH@42161,POL@137'
const BC1Q = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const LNBC = 'lnbc10u1p3xnhl2pp5' + 'q'.repeat(200)

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
    NATIVE_SOURCES: PROD_NATIVE,
    NATIVE_SOURCES_BETA: 'ZEC@9133,BTC@9000',
    ZEC_RAIL: 'custody',
    ...extra,
  } as unknown as Env
}

let createdIntent: any = null
let createdIntents: any[] = []
let createCalls = 0
let checkoutCalls = 0
let quoteAmount = '0.80'
let linkExpiresAt: string | null = null
let createAnswer: (() => Response) | null = null
let existingOrder: any = null
let raceWinner: any = null

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

const btcBlock = (payinState: string, receivedSat = '0', confirmations = 0, quoteExpiresAt = '2999-01-01T01:00:00.000Z') => ({
  rail: 'btc_custody', requiredConfirmations: 1, confirmations, requiredSat: '1200', receivedSat, payinState, quoteExpiresAt, txid: null,
})

const btcAnswer = (over: Record<string, any> = {}, srcOver: Record<string, any> = {}) => () => new Response(JSON.stringify({
  id: 'rozo-pay-btc',
  status: 'payment_unpaid',
  provider: 'rozo',
  paymentLink: 'https://pay.rozo.ai/b',
  expiresAt: '2999-01-01T01:00:00.000Z',
  quoteExpiresAt: '2999-01-01T01:00:00.000Z',
  source: { chainId: '9000', tokenSymbol: 'BTC', amount: '0.00001200', receiverAddress: BC1Q, btc: btcBlock('awaiting'), ...srcOver },
  ...over,
}), { status: 200 })

const lnAnswer = (srcOver: Record<string, any> = {}) => () => new Response(JSON.stringify({
  id: 'rozo-pay-ln',
  status: 'payment_unpaid',
  paymentLink: 'https://pay.rozo.ai/l',
  expiresAt: '2999-01-01T01:00:00.000Z',
  lnInvoice: LNBC,
  source: { chainId: 'lightning', tokenSymbol: 'BTC', amount: '0.00001200', ...srcOver },
}), { status: 200 })

beforeEach(() => {
  createdIntent = null
  createdIntents = []
  createCalls = 0
  checkoutCalls = 0
  quoteAmount = '0.80'
  linkExpiresAt = inMinutes(24 * 60)
  createAnswer = null
  existingOrder = null
  raceWinner = null
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('payments.coinbase.com/next-api/')) {
      if (!linkExpiresAt) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({
        paymentSessionId: SESSION_ID,
        status: 'PAYMENT_SESSION_STATUS_CREATED',
        amount: quoteAmount,
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
      return new Response(JSON.stringify({ invoice: { amount: quoteAmount }, merchant: 'OpenRouter, Inc', linkId: SESSION_ID }), { status: 200 })
    }
    if (u.includes('/payments/order/')) {
      const row = u.endsWith(`/${SESSION_ID}`) ? existingOrder ?? (createCalls > 0 ? raceWinner : null) : null
      return row
        ? new Response(JSON.stringify(row), { status: 200 })
        : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    if (u.includes('/checkout') && init?.method === 'POST') {
      checkoutCalls++
      return new Response('{"error":{"code":"invalidRequest"}}', { status: 400 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createCalls++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      createdIntents.push(createdIntent)
      if (createAnswer) return createAnswer()
      return btcAnswer()()
    }
    if (u.includes('/payment-api') && existingOrder?.id && u.endsWith(`/payments/${existingOrder.id}`)) {
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

const BTC = { chainId: '9000', tokenSymbol: 'BTC' }
const LN = { chainId: 'lightning', tokenSymbol: 'BTC' }

describe('on-chain BTC source table', () => {
  it('is not GA: NATIVE_SOURCES and the rozotest set never open it', () => {
    expect(ALL_NATIVE_SOURCES.has('BTC@9000')).toBe(false)
    expect(parseNativeSources(`${PROD_NATIVE},BTC@9000`).has('BTC@9000')).toBe(false)
    expect(supportedSources(STABLE_SOURCES, parseNativeSources(PROD_NATIVE))['9000']).toBeUndefined()
  })

  it('I2: opens only with ?beta=btc AND a NATIVE_SOURCES_BETA entry; ?beta=btc never opens ZEC and vice versa', () => {
    const base = parseNativeSources(PROD_NATIVE)
    expect(withBetaSources(base, 'ZEC@9133,BTC@9000', 'https://x/q').has('BTC@9000')).toBe(false)
    expect(withBetaSources(base, 'ZEC@9133', 'https://x/q?beta=btc').has('BTC@9000')).toBe(false)
    expect(withBetaSources(base, '', 'https://x/q?beta=btc').has('BTC@9000')).toBe(false)
    expect(withBetaSources(base, 'ZEC@9133,BTC@9000', 'https://x/q?beta=zec').has('BTC@9000')).toBe(false)
    const open = withBetaSources(base, 'ZEC@9133,BTC@9000', 'https://x/q?beta=BTC')
    expect(open.has('BTC@9000')).toBe(true)
    expect(open.has('ZEC@9133')).toBe(false)
    expect(parseBetaNativeSources('BTC@9000,BTC@lightning,BTC@1').size).toBe(1)
    expect(supportedSources(STABLE_SOURCES, open)['9000']).toEqual(['BTC'])
  })

  it('isBtcOnchain is chain-bound: Lightning BTC is never on-chain BTC', () => {
    expect(isBtcOnchain('9000', 'btc')).toBe(true)
    expect(isBtcOnchain('lightning', 'BTC')).toBe(false)
    expect(isBtcOnchain('9000', 'ZEC')).toBe(false)
    expect(isBtcOnchain(9000, 'BTC')).toBe(true)
    expect(isBtcP2wpkhAddress(BC1Q)).toBe(true)
    expect(isBtcP2wpkhAddress(BC1Q.toUpperCase())).toBe(false)
    expect(isBtcP2wpkhAddress('bc1p' + BC1Q.slice(4))).toBe(false)
    expect(isBtcP2wpkhAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false)
    expect(isBtcP2wpkhAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(false)
  })

  it('I4: btcOnchainMaxUsd may only lower the $1 ceiling', () => {
    expect(BTC_ONCHAIN_MIN_USD).toBe(0.5)
    expect(BTC_ONCHAIN_MAX_USD).toBe(1)
    expect(btcOnchainMaxUsd(undefined)).toBe(1)
    expect(btcOnchainMaxUsd('0.8')).toBe(0.8)
    expect(btcOnchainMaxUsd('5')).toBe(1)
    expect(btcOnchainMaxUsd('1')).toBe(1)
    expect(btcOnchainMaxUsd('0')).toBe(1)
    expect(btcOnchainMaxUsd('-1')).toBe(1)
    expect(btcOnchainMaxUsd('abc')).toBe(1)
  })

  it('sourceMeta: BTC carries 1 confirmation and the band; ZEC custody meta unchanged; nativeMinUsd 0.5', () => {
    const meta = sourceMeta(new Set(['BTC@9000', 'ZEC@9133']), 'custody', false, '0.9')
    expect(meta['BTC@9000']).toEqual({
      refund_address_required: false, beta: true, address_single_use: true,
      required_confirmations: 1, min_usd: 0.5, max_usd: 0.9,
    })
    expect(meta['ZEC@9133']).toEqual({
      refund_address_required: false, beta: true, address_single_use: true, confirmations: { under110: 1, from110: 2, from3200: 3 },
    })
    expect(sourceMeta(new Set(['BTC@9000']), 'custody', true)['BTC@9000']).not.toHaveProperty('shieldedAvailable')
    expect(nativeMinUsd(new Set(['BTC@9000']))).toEqual({ '9000': { BTC: 0.5 } })
    expect(nativeMinUsd(parseNativeSources(PROD_NATIVE))['9000']).toBeUndefined()
  })
})

describe('quote-invoice with on-chain BTC', () => {
  it('hides 9000 without ?beta=btc (Lightning and other coins untouched)', async () => {
    const plain = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID })
    const beta = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { query: '?beta=btc' })
    expect(plain.status).toBe(200)
    expect(plain.json.supportedSources['9000']).toBeUndefined()
    expect(plain.json.sourceMeta).toEqual({})
    expect(beta.json.supportedSources['9000']).toEqual(['BTC'])
    expect(beta.json.sourceMeta['BTC@9000'].required_confirmations).toBe(1)
    expect(beta.json.nativeMinUsd['9000']).toEqual({ BTC: 0.5 })
    // Everything except the BTC additions is identical with and without the param.
    const strip = (j: any) => {
      const sup = { ...j.supportedSources }; delete sup['9000']
      const min = { ...j.nativeMinUsd }; delete min['9000']
      return { sup, min, callerPays: j.callerPays, title: j.title }
    }
    expect(strip(beta.json)).toEqual(strip(plain.json))
  })

  it('a rozotest_ quote opens BTC only with ?beta=btc', async () => {
    const id = await signTestPaymentId(SECRET, 80, 'btcquote1')
    const plain = await post(handleQuoteInvoice as any, { payment_id: id })
    expect(plain.json.supportedSources['9000']).toBeUndefined()
    const beta = await post(handleQuoteInvoice as any, { payment_id: id }, { query: '?beta=btc' })
    expect(beta.json.supportedSources['9000']).toEqual(['BTC'])
  })

  it('NATIVE_SOURCES_BETA without BTC@9000: hidden even with ?beta=btc', async () => {
    const r = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: makeEnv({ NATIVE_SOURCES_BETA: 'ZEC@9133' }), query: '?beta=btc' })
    expect(r.json.supportedSources['9000']).toBeUndefined()
    expect(r.json.sourceMeta['BTC@9000']).toBeUndefined()
  })
})

describe('create-invoice: I2 closed on-chain BTC refuses like an unknown coin', () => {
  const unknownMessage = (chain: string) => `chainId ${chain} is not supported as a source. See "supported" for valid (chainId, tokenSymbol) pairs.`

  it('resolveSource: closed BTC@9000 gives the unknown-chain refusal', () => {
    const closed = resolveSource(BTC, parseNativeSources(PROD_NATIVE))
    const unknown = resolveSource({ chainId: '9001', tokenSymbol: 'BTC' }, parseNativeSources(PROD_NATIVE))
    expect(closed.error?.code).toBe('UNSUPPORTED_SOURCE')
    expect(closed.error?.message).toBe(unknownMessage('9000'))
    expect(unknown.error?.message).toBe(unknownMessage('9001'))
    expect(closed.error?.supported).toEqual(unknown.error?.supported)
  })

  for (const [label, env, query] of [
    ['no ?beta=btc', makeEnv(), ''],
    ['NATIVE_SOURCES_BETA without BTC', makeEnv({ NATIVE_SOURCES_BETA: 'ZEC@9133' }), '?beta=btc'],
    ['NATIVE_SOURCES_BETA empty', makeEnv({ NATIVE_SOURCES_BETA: '' }), '?beta=btc'],
    ['only ?beta=zec', makeEnv(), '?beta=zec'],
  ] as const) {
    it(`${label}: 400 UNSUPPORTED_SOURCE, same body shape as an unknown chain, no upstream create`, async () => {
      const closed = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env, query })
      const unknown = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: { chainId: '9001', tokenSymbol: 'BTC' } }, { env, query })
      expect(closed.status).toBe(400)
      expect(closed.json.code).toBe('UNSUPPORTED_SOURCE')
      expect(closed.json.message).toBe(unknownMessage('9000'))
      expect(closed.json.supported_sources).toEqual(unknown.json.supported_sources)
      expect(closed.json.supported_sources['9000']).toBeUndefined()
      expect(Object.keys(closed.json).sort()).toEqual(Object.keys(unknown.json).sort())
      expect(createCalls).toBe(0)
    })
  }
})

describe('create-invoice: on-chain BTC order', () => {
  it('creates an exactOut order with only chainId + tokenSymbol upstream (I1, I3)', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID,
      // Client-sent amount, address, confirmation state and refund address must all be ignored.
      source: { ...BTC, amount: '9.99', tokenAddress: 'bc1qattacker', receiverAddress: 'bc1qattacker', confirmations: 6 },
      refund_address: 'bc1qrefund',
      amount: '100',
    }, { query: '?beta=btc' })
    expect(status).toBe(200)
    expect(createCalls).toBe(1)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.source).toEqual({ chainId: '9000', tokenSymbol: 'BTC' })
    expect(createdIntent.destination.amount).toBe(json.callerPays)
    expect(createdIntent.destination.chainId).toBe('8453')
    expect(createdIntent.destination.tokenSymbol).toBe('USDC')
    expect(createdIntent.metadata.merchant_link_expires_at).toBe(new Date(Date.parse(linkExpiresAt as string)).toISOString())
    expect(createdIntent.metadata).not.toHaveProperty('zec_refund_address_sha256')
    expect(createdIntent.metadata).not.toHaveProperty('zec_refund_address_none')
    expect(JSON.stringify(createdIntent)).not.toContain('attacker')
    expect(JSON.stringify(createdIntent)).not.toContain('bc1qrefund')
    expect(json.source).toEqual({ chainId: '9000', tokenSymbol: 'BTC', tokenAddress: '' })
    expect(json.nativeAmount).toBe('0.00001200')
    expect(json.raw.source.receiverAddress).toBe(BC1Q)
    expect(json.raw.lnInvoice).toBeUndefined()
  })

  it('I4: $1.01 gross is refused with the native cap error; $1.00 passes', async () => {
    quoteAmount = '1.01'
    const over = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(over.status).toBe(400)
    expect(over.json.code).toBe('UNSUPPORTED_SOURCE')
    expect(over.json.message).toBe('Native coin payment is limited to $1 per invoice. Pay with USDC/USDT instead.')
    expect(createCalls).toBe(0)
    quoteAmount = '1.00'
    const at = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(at.status).toBe(200)
  })

  it('I4: below $0.50 gross is refused; $0.50 passes', async () => {
    quoteAmount = '0.49'
    const under = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(under.status).toBe(400)
    expect(under.json.code).toBe('UNSUPPORTED_SOURCE')
    expect(under.json.message).toContain('at least $0.5')
    expect(createCalls).toBe(0)
    quoteAmount = '0.50'
    const at = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(at.status).toBe(200)
  })

  it('I4: BTC_ONCHAIN_MAX_USD lowers the cap but never raises it; NATIVE_MAX_USD cannot raise it either', async () => {
    quoteAmount = '0.90'
    const lowered = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: makeEnv({ BTC_ONCHAIN_MAX_USD: '0.8' }), query: '?beta=btc' })
    expect(lowered.status).toBe(400)
    expect(lowered.json.message).toContain('$0.8 per invoice')
    quoteAmount = '1.50'
    for (const extra of [{ BTC_ONCHAIN_MAX_USD: '5' }, { NATIVE_MAX_USD: '5000' }]) {
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: makeEnv(extra), query: '?beta=btc' })
      expect(r.status).toBe(400)
      expect(r.json.message).toContain('$1 per invoice')
    }
    expect(createCalls).toBe(0)
  })

  it('a link that expires within the BTC horizon, or an unknown expiry, is refused before any create', async () => {
    linkExpiresAt = new Date(Date.now() + BTC_ONCHAIN_MIN_LINK_LIFE_MS - 60_000).toISOString()
    const short = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(short.status).toBe(400)
    expect(short.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(short.json.message).toContain('on-chain BTC')
    linkExpiresAt = null
    const unknown = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(unknown.status).toBe(400)
    expect(unknown.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
  })

  it('a rozotest_ BTC order uses the synthetic link horizon and is marked testMode', async () => {
    const id = await signTestPaymentId(SECRET, 80, 'btccreate1')
    linkExpiresAt = null
    const r = await post(handleCreateInvoice, { payment_id: id, source: BTC }, { query: '?beta=btc' })
    expect(r.status).toBe(200)
    expect(createdIntent.metadata.testMode).toBe(true)
    expect(createdIntent.metadata.merchant_link_expires_at).toBeTruthy()
  })

  it('passes rozo-intents-api #1110 BTC refusal codes (data.errorCode) through with their status', async () => {
    // Real shape (shared/cors.ts errorResponse): { error: { code: <generic>, message }, data: { errorCode, ... } }.
    for (const [status, generic, code] of [
      [403, 'BTC_NOT_ENABLED', 'BTC_NOT_ENABLED'], [403, 'BTC_APP_NOT_ALLOWED', 'BTC_APP_NOT_ALLOWED'],
      [400, 'amountTooLow', 'BTC_AMOUNT_TOO_LOW'], [400, 'amountTooHigh', 'BTC_AMOUNT_TOO_HIGH'],
      [503, 'BTC_CAPACITY_BUSY', 'BTC_CAPACITY_BUSY'], [503, 'BTC_PAUSED', 'BTC_PAUSED'],
      [503, 'BTC_MONITOR_STALE', 'BTC_MONITOR_STALE'], [503, 'BTC_UNAVAILABLE', 'BTC_UNAVAILABLE'],
      [503, 'BTC_RESERVE_FAILED', 'BTC_RESERVE_FAILED'], [400, 'BTC_LINK_TOO_SOON', 'BTC_LINK_TOO_SOON'],
      [400, 'invalidRequest', 'BTC_REQUIRES_EXACT_OUT'], [400, 'invalidRequest', 'BTC_DESTINATION_UNSUPPORTED'],
    ] as const) {
      createAnswer = () => new Response(JSON.stringify({ error: { code: generic, message: 'upstream text' }, data: { errorCode: code }, requestId: 'r' }), { status })
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
      expect(r.status).toBe(status)
      expect(r.json.code).toBe(code)
      expect(r.json.message).not.toBe('upstream text')
    }
  })

  it('btcUpstreamError ignores other 5xx and unknown codes; a BTC-looking code on a Lightning create is not passed', async () => {
    expect(btcUpstreamError(500, '{"error":{"code":"BTC_PAUSED"}}')).toBeNull()
    expect(btcUpstreamError(400, '{"error":{"code":"SOMETHING_ELSE"}}')).toBeNull()
    expect(btcUpstreamError(400, 'not json')).toBeNull()
    expect(btcUpstreamError(400, '{"data":{"errorCode":"BTC_AMOUNT_TOO_LOW"},"error":{"code":"amountTooLow"}}')?.code).toBe('BTC_AMOUNT_TOO_LOW')
    createAnswer = () => new Response('{"error":{"code":"BTC_PAUSED"}}', { status: 503 })
    const ln = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: LN }, { query: '?beta=btc' })
    expect(ln.json.code).not.toBe('BTC_PAUSED')
  })
})

describe('I1: the BTC rail invariant on what rozo-intents-api returns', () => {
  const cases: Array<[string, () => Response]> = [
    ['a BOLT11 on an on-chain order', btcAnswer({ lnInvoice: LNBC })],
    ['a non-bc1q address', btcAnswer({}, { receiverAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' })],
    ['a taproot address', btcAnswer({}, { receiverAddress: 'bc1p' + BC1Q.slice(4) })],
    ['the lightning chain', btcAnswer({}, { chainId: 'lightning' })],
    ['an amount with 9 decimals', btcAnswer({}, { amount: '0.000012001' })],
    ['a zero amount', btcAnswer({}, { amount: '0' })],
  ]
  for (const [label, answer] of cases) {
    it(`on-chain create answered with ${label}: 502 btc_rail_mismatch, no payable instructions`, async () => {
      createAnswer = answer
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
      expect(r.status).toBe(502)
      expect(r.json.code).toBe('INTENTS_API_FAILED')
      expect(r.json.stage).toBe('btc_rail_mismatch')
      expect(JSON.stringify(r.json)).not.toContain('lnbc')
      expect(r.json.raw).toBeUndefined()
    })
  }

  it('a blank address (no instructions, upstream not safely payable) passes through as blank', async () => {
    for (const blank of [null, '']) {
      createAnswer = btcAnswer({}, { receiverAddress: blank })
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
      expect(r.status).toBe(200)
      expect(r.json.raw.source.receiverAddress).toBe(blank)
    }
  })

  it('Lightning create: body unchanged by ?beta=btc and never on chain 9000', async () => {
    createAnswer = lnAnswer()
    const plain = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: LN })
    const plainBody = createdIntents[0]
    existingOrder = null
    const beta = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: LN }, { query: '?beta=btc' })
    const betaBody = createdIntents[1]
    expect(plain.status).toBe(200)
    expect(beta.status).toBe(200)
    expect(plainBody.source).toEqual({ chainId: 'lightning', tokenSymbol: 'BTC' })
    const norm = (b: any) => ({ ...b, orderId: 'x', metadata: { ...b.metadata, attribution: undefined } })
    expect(norm(betaBody)).toEqual(norm(plainBody))
    expect(beta.json.raw.lnInvoice).toBe(LNBC)
    expect(beta.json.source.chainId).toBe('lightning')
  })

  it('Lightning create answered with an on-chain bc1q address (or chain 9000): 502, never handed out', async () => {
    for (const over of [{ receiverAddress: BC1Q }, { chainId: '9000' }, { receiverAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }]) {
      createAnswer = lnAnswer(over)
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: LN }, { query: '?beta=btc' })
      expect(r.status).toBe(502)
      expect(r.json.stage).toBe('btc_rail_mismatch')
      expect(JSON.stringify(r.json)).not.toContain(BC1Q)
    }
  })

  it('btcRailViolation: neither rail = null; good rows = null', () => {
    expect(btcRailViolation({ chainId: '8453' }, { source: { chainId: '8453', receiverAddress: '0xabc' } })).toBeNull()
    expect(btcRailViolation({ chainId: '9000' }, {})).toBe('btc_onchain_row_without_source')
    expect(btcRailViolation({ chainId: '9000' }, { status: 'payment_unpaid', source: { chainId: '9000', tokenSymbol: 'BTC', amount: '0.00001200', receiverAddress: BC1Q } })).toBeNull()
    expect(btcRailViolation({ chainId: 'lightning' }, { lnInvoice: LNBC, source: { chainId: 'lightning', tokenSymbol: 'BTC' } })).toBeNull()
  })
})

describe('replay and out-of-order', () => {
  async function liveBtcRow(extra: Record<string, unknown> = {}, srcOver: Record<string, unknown> = {}) {
    existingOrder = null
    createAnswer = null
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    const intent = createdIntent
    createCalls = 0
    createdIntent = null
    createdIntents = []
    return {
      id: 'rozo-pay-btc', status: 'payment_unpaid', paymentLink: 'https://pay.rozo.ai/b', provider: 'rozo',
      expiresAt: '2999-01-01T01:00:00.000Z', quoteExpiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '9000', tokenSymbol: 'BTC', amount: '0.00001200', receiverAddress: BC1Q, btc: btcBlock('awaiting'), ...srcOver },
      destination: { ...intent.destination },
      metadata: { ...intent.metadata },
      ...extra,
    }
  }

  it('duplicate create request: the second call reuses the same order, no second upstream create', async () => {
    existingOrder = await liveBtcRow()
    const again = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(again.status).toBe(200)
    expect(again.json.reused).toBe(true)
    expect(again.json.rozoPaymentId).toBe('rozo-pay-btc')
    expect(again.json.raw.source.receiverAddress).toBe(BC1Q)
    expect(createCalls).toBe(0)
  })

  it('reused row that breaks the rail invariant is never handed out', async () => {
    existingOrder = await liveBtcRow({ lnInvoice: LNBC })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(r.status).toBe(502)
    expect(r.json.stage).toBe('btc_rail_mismatch')
  })

  it('existing on-chain BTC order + Lightning request: not rotated, reported as a mismatch (no /checkout call, no BOLT11)', async () => {
    existingOrder = await liveBtcRow()
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: LN }, { query: '?beta=btc' })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(true)
    expect(r.json.sourceMismatch).toBe(true)
    expect(r.json.source.chainId).toBe('9000')
    expect(r.json.raw.lnInvoice).toBeUndefined()
    expect(checkoutCalls).toBe(0)
    expect(createCalls).toBe(0)
  })

  it('existing Lightning order + on-chain BTC request: not rotated, the BOLT11 order is not turned into a bc1q one', async () => {
    const lnRow = await (async () => {
      const base = await liveBtcRow()
      return { ...base, id: 'rozo-pay-ln', lnInvoice: LNBC, source: { chainId: 'lightning', tokenSymbol: 'BTC', amount: '0.00001200' } }
    })()
    existingOrder = lnRow
    // Production has LIGHTNING_ROTATE_OUT_ENABLED=true: the on-chain BTC rule must refuse on its own.
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: makeEnv({ LIGHTNING_ROTATE_OUT_ENABLED: 'true' }), query: '?beta=btc' })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(true)
    expect(r.json.sourceMismatch).toBe(true)
    expect(r.json.source.chainId).toBe('lightning')
    expect(JSON.stringify(r.json)).not.toContain(BC1Q)
    expect(checkoutCalls).toBe(0)
  })

  it('race winner of another coin: 409 ORDER_CREATE_CONFLICT, never a silent hand-over', async () => {
    const base = await liveBtcRow()
    raceWinner = { ...base, id: 'rozo-pay-usdc', source: { chainId: '8453', tokenSymbol: 'USDC', amount: base.destination.amount, receiverAddress: '0x' + '1'.repeat(40) } }
    createAnswer = () => new Response('{"error":{"code":"orderIdConflict"}}', { status: 409 })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('ORDER_CREATE_CONFLICT')
  })

  it('race winner on the same rail is reused', async () => {
    raceWinner = await liveBtcRow()
    createAnswer = () => new Response('{"error":{"code":"orderIdConflict"}}', { status: 409 })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(true)
    expect(r.json.rozoPaymentId).toBe('rozo-pay-btc')
  })

  it('status query before any order exists: no address, no paid claim', async () => {
    const res = await handleInvoiceStatus(
      new Request('https://mpp.test/invoice-status?rozo_payment_id=4b9fefce-fc50-4fd1-8983-6698b8501331'),
      { ...makeEnv(), ATOMIC_STORE: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('{"value":null,"version":0}') }) } } as unknown as Env,
    )
    const text = await res.text()
    expect(text).not.toContain('bc1q')
    expect(text).not.toMatch(/"paid"\s*:\s*true/)
    expect(pickRozoCallerSafe(null)).toBeNull()
  })

  it('quote expired unfunded: predicate is BTC-only and chain-bound; query after expiry says not live', () => {
    const base = { status: 'payment_unpaid', source: { chainId: '9000', tokenSymbol: 'BTC', btc: btcBlock('expired', '0', 0, '2000-01-01T00:00:00.000Z') } }
    expect(btcQuoteExpiredUnfunded(base)).toBe(true)
    expect(custodyQuoteExpiredUnfunded(base)).toBe(true)
    expect(zecQuoteExpiredUnfunded(base)).toBe(false)
    expect(isLive({ ...base, expiresAt: '2999-01-01T00:00:00.000Z' })).toBe(false)
    expect(btcQuoteExpiredUnfunded({ ...base, source: { ...base.source, chainId: 'lightning' } })).toBe(false)
    expect(btcQuoteExpiredUnfunded({ ...base, source: { ...base.source, btc: btcBlock('expired', '1200', 0, '2000-01-01T00:00:00.000Z') } })).toBe(false)
    expect(btcQuoteExpiredUnfunded({ ...base, source: { ...base.source, btc: btcBlock('expired', '0', 0) } })).toBe(false) // future quote
    for (const st of ['awaiting', 'seen', 'manual_review', 'underpaid', 'late_review', 'reorged', 'eligible']) {
      expect(btcQuoteExpiredUnfunded({ ...base, source: { ...base.source, btc: btcBlock(st, '0', 0, '2000-01-01T00:00:00.000Z') } })).toBe(false)
    }
    expect(btcQuoteExpiredUnfunded({ ...base, source: { ...base.source, txHash: 'ab'.repeat(32) } })).toBe(false)
    expect(btcQuoteExpiredUnfunded({ ...base, status: 'payment_payin_completed' })).toBe(false)
  })

  it('expired unfunded BTC order is replaced by a fresh order; expired with funds seen is reused, never replaced', async () => {
    existingOrder = await liveBtcRow({ quoteExpiresAt: '2000-01-01T00:00:00.000Z' }, { btc: btcBlock('expired', '0', 0, '2000-01-01T00:00:00.000Z') })
    const fresh = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(fresh.status).toBe(200)
    expect(fresh.json.reused).toBe(false)
    expect(fresh.json.replacesExpiredPaymentIds).toEqual(['rozo-pay-btc'])
    expect(createCalls).toBe(1)

    existingOrder = await liveBtcRow({ quoteExpiresAt: '2000-01-01T00:00:00.000Z' }, { btc: btcBlock('expired', '1200', 0, '2000-01-01T00:00:00.000Z') })
    const held = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    expect(held.status).toBe(200)
    expect(held.json.reused).toBe(true)
    expect(createCalls).toBe(0)
  })
})

describe('invoice-status relays the on-chain BTC custody block (I3: from rozo-intents-api only)', () => {
  const ROW = {
    id: 'p1', status: 'payment_unpaid', provider: 'rozo', quoteExpiresAt: '2026-11-18T10:10:00.000Z',
    source: { chainId: '9000', tokenSymbol: 'BTC', receiverAddress: BC1Q, amount: '0.00001200', btc: { ...btcBlock('seen', '1200', 0), extra: 'dropped' } },
  }

  it('passes a well-formed block, drops extra keys, never relays a BOLT11 on an on-chain row', () => {
    const out: any = pickRozoCallerSafe({ ...ROW, lnInvoice: LNBC })
    expect(out.source.btc).toEqual(btcBlock('seen', '1200', 0))
    expect(out.lnInvoice).toBeUndefined()
    expect(out.source.receiverAddress).toBe(BC1Q)
  })

  it('drops a malformed block entirely', () => {
    const b = btcBlock('seen', '1200', 0)
    for (const bad of [{ rail: 'zec_custody' }, { requiredConfirmations: 2 }, { confirmations: -1 }, { requiredSat: 1200 }, { receivedSat: 'x' }, { payinState: 'paid' }, { payinState: 'confirming' }, { quoteExpiresAt: 'soon' }]) {
      expect(pickBtcCustodyStatus({ ...b, ...bad }, ROW.source)).toBeNull()
    }
  })

  it('#1110 shape: txid relayed (or nulled when malformed, block kept); manual_review accepted', () => {
    const TX = 'ab'.repeat(32)
    const withTx: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, btc: { ...btcBlock('eligible', '1200', 1), txid: TX } } })
    expect(withTx.source.btc.txid).toBe(TX)
    const badTx: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, btc: { ...btcBlock('eligible', '1200', 1), txid: 'nothex' } } })
    expect(badTx.source.btc).toBeDefined()
    expect(badTx.source.btc.txid).toBeNull()
    const noTx: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, btc: (({ txid: _t, ...rest }) => rest)(btcBlock('seen', '1200')) } })
    expect(noTx.source.btc.txid).toBeNull()
    const mr: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, btc: btcBlock('manual_review', '1200') } })
    expect(mr.source.btc.payinState).toBe('manual_review')
  })

  it('never on a Lightning row or a ZEC row, even when a btc block is present', () => {
    const ln: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, chainId: 'lightning' } })
    expect(ln.source.btc).toBeUndefined()
    const zec: any = pickRozoCallerSafe({ ...ROW, source: { ...ROW.source, chainId: '9133', tokenSymbol: 'ZEC' } })
    expect(zec.source.btc).toBeUndefined()
  })

  it('a ZEC custody row is unchanged (no btc key)', () => {
    const out: any = pickRozoCallerSafe({ ...ROW, source: { chainId: '9133', tokenSymbol: 'ZEC', receiverAddress: 't1X', amount: '0.1' } })
    expect(out.source).not.toHaveProperty('btc')
  })
})

describe('reuse path honours the on-chain BTC switch (BTC@9000 in NATIVE_SOURCES_BETA)', () => {
  const ON = () => makeEnv()
  const OFF = () => makeEnv({ NATIVE_SOURCES_BETA: 'ZEC@9133' })
  const USDC = { chainId: '8453', tokenSymbol: 'USDC' }

  async function liveRow(srcOver: Record<string, unknown> = {}, id = 'rozo-pay-btc') {
    existingOrder = null
    createAnswer = null
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
    const intent = createdIntent
    createCalls = 0
    checkoutCalls = 0
    createdIntent = null
    createdIntents = []
    return {
      id, status: 'payment_unpaid', paymentLink: 'https://pay.rozo.ai/b', provider: 'rozo',
      expiresAt: '2999-01-01T01:00:00.000Z', quoteExpiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '9000', tokenSymbol: 'BTC', amount: '0.00001200', receiverAddress: BC1Q, btc: btcBlock('awaiting'), ...srcOver },
      destination: { ...intent.destination },
      metadata: { ...intent.metadata },
    }
  }

  function expectNoInstructions(json: any) {
    const text = JSON.stringify(json)
    expect(text).not.toContain(BC1Q)
    expect(text).not.toContain('pay.rozo.ai/b')
    expect(text).not.toContain('0.00001200')
    expect(json.raw).toBeUndefined()
    expect(json.paymentLink).toBeUndefined()
    expect(json.source).toBeUndefined()
  }

  it('switch off: a live BTC order is refused with 409 BTC_NOT_ENABLED and no address, for any requested coin', async () => {
    existingOrder = await liveRow()
    for (const [source, query] of [[USDC, ''], [USDC, '?beta=btc'], [LN, ''], [undefined, '']] as const) {
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, ...(source ? { source } : {}) }, { env: OFF(), query })
      expect(r.status).toBe(409)
      expect(r.json.ok).toBe(false)
      expect(r.json.code).toBe('BTC_NOT_ENABLED')
      expect(r.json.error.code).toBe('BTC_NOT_ENABLED')
      expect(r.json.rozoPaymentId).toBe('rozo-pay-btc')
      expectNoInstructions(r.json)
    }
    expect(createCalls).toBe(0)
    expect(checkoutCalls).toBe(0)
  })

  it('switch off: a BTC request is refused before reuse (400 UNSUPPORTED_SOURCE), still no address', async () => {
    existingOrder = await liveRow()
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: OFF(), query: '?beta=btc' })
    expect(r.status).toBe(400)
    expect(r.json.error?.code ?? r.json.code).toBe('UNSUPPORTED_SOURCE')
    expect(JSON.stringify(r.json)).not.toContain(BC1Q)
    expect(createCalls).toBe(0)
  })

  it('switch off: a BTC order with funds already seen is also refused without instructions', async () => {
    existingOrder = await liveRow({ btc: btcBlock('seen', '1200', 0) })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: OFF() })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('BTC_NOT_ENABLED')
    expectNoInstructions(r.json)
  })

  it('switch on: reuse unchanged (BTC request gets the address; other coin gets the mismatch view)', async () => {
    existingOrder = await liveRow()
    const same = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: ON(), query: '?beta=btc' })
    expect(same.status).toBe(200)
    expect(same.json.reused).toBe(true)
    expect(same.json.raw.source.receiverAddress).toBe(BC1Q)
    const other = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: ON() })
    expect(other.status).toBe(200)
    expect(other.json.reused).toBe(true)
    expect(other.json.sourceMismatch).toBe(true)
    expect(other.json.source.chainId).toBe('9000')
    expect(createCalls).toBe(0)
  })

  it('non-BTC live order: reuse unchanged with the switch off', async () => {
    const base = await liveRow()
    const usdcAddr = '0x' + '1'.repeat(40)
    existingOrder = { ...base, id: 'rozo-pay-usdc', source: { chainId: '8453', tokenSymbol: 'USDC', amount: base.destination.amount, receiverAddress: usdcAddr } }
    const off = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: OFF() })
    const on = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: ON() })
    expect(off.status).toBe(200)
    expect(off.json.reused).toBe(true)
    expect(off.json.raw.source.receiverAddress).toBe(usdcAddr)
    expect(off.json).toEqual(on.json)
    expect(createCalls).toBe(0)
  })

  it('replay: the same request twice with the switch off gives the same 409 body', async () => {
    existingOrder = await liveRow()
    const a = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: OFF() })
    const b = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: OFF() })
    expect(a.status).toBe(409)
    expect(b.status).toBe(409)
    expect(b.json).toEqual(a.json)
    expect(createCalls).toBe(0)
  })

  it('switch on -> off between two requests: the second no longer hands out the address', async () => {
    existingOrder = await liveRow()
    const before = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: ON(), query: '?beta=btc' })
    expect(before.status).toBe(200)
    expect(before.json.raw.source.receiverAddress).toBe(BC1Q)
    const after = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: OFF(), query: '?beta=btc' })
    expect(after.status).toBe(409)
    expect(after.json.code).toBe('BTC_NOT_ENABLED')
    expect(after.json.rozoPaymentId).toBe(before.json.rozoPaymentId)
    expectNoInstructions(after.json)
    expect(createCalls).toBe(0)
  })

  it('switch off -> on (rollback) between two requests: the same order and address come back, no new order', async () => {
    existingOrder = await liveRow()
    const off = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: USDC }, { env: OFF() })
    expect(off.status).toBe(409)
    const on = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: ON(), query: '?beta=btc' })
    expect(on.status).toBe(200)
    expect(on.json.reused).toBe(true)
    expect(on.json.rozoPaymentId).toBe('rozo-pay-btc')
    expect(on.json.raw.source.receiverAddress).toBe(BC1Q)
    expect(createCalls).toBe(0)
  })
})

describe('PR-3 Beta constants: present, but the live band stays test_only until BTC_ONCHAIN_LIMITS is exactly "beta"', () => {
  const BETA = (extra: Record<string, string> = {}) => makeEnv({ BTC_ONCHAIN_LIMITS: 'beta', ...extra })

  it('constants match rozo-intents-api #1117 (BETA-BTC-MIN 10, BETA-ORDER-CAP 1,200); test_only constants unchanged', () => {
    expect([BTC_ONCHAIN_BETA_MIN_USD, BTC_ONCHAIN_BETA_MAX_USD]).toEqual([10, 1200])
    expect([BTC_ONCHAIN_MIN_USD, BTC_ONCHAIN_MAX_USD]).toEqual([0.5, 1])
    expect(NATIVE_SOURCE_DEFS['9000'].maxUsd).toBe(1200)
  })

  it('mode parse is fail closed: only the exact string "beta" selects beta', () => {
    expect(parseBtcOnchainLimits('beta')).toBe('beta')
    for (const raw of [undefined, '', 'Beta', 'BETA', ' beta', 'beta ', 'test_only', 'on', 'true', '1', 'off']) {
      expect(parseBtcOnchainLimits(raw as string | undefined)).toBe('test_only')
    }
  })

  it('effective band by mode; BTC_ONCHAIN_MAX_USD only lowers in both modes; default arguments are test_only', () => {
    expect(btcOnchainMinUsd()).toBe(0.5)
    expect(btcOnchainMinUsd('beta')).toBe(10)
    expect(btcOnchainMaxUsd(undefined)).toBe(1)
    expect(btcOnchainMaxUsd('1200')).toBe(1)
    expect(btcOnchainMaxUsd(undefined, 'beta')).toBe(1200)
    expect(btcOnchainMaxUsd('500', 'beta')).toBe(500)
    for (const raw of ['5000', '1200', '0', '-1', 'abc']) expect(btcOnchainMaxUsd(raw, 'beta')).toBe(1200)
    // The def ceiling alone never decides the cap: the create path takes min(nativeCap, btcOnchainMaxUsd).
    expect(Math.min(nativeMaxUsdFor('9000', undefined), btcOnchainMaxUsd(undefined))).toBe(1)
    expect(Math.min(nativeMaxUsdFor('9000', '5000'), btcOnchainMaxUsd(undefined))).toBe(1)
  })

  it('confirmation tiers (BETA-BTC-FRONT-CONF): <=100: 1, <600: 2, else 3; unreadable: 3; test_only always 1', () => {
    expect([0, 10, 100, 100.000001, 599.99, 600, 1200].map((v) => btcOnchainRequiredConfirmations('beta', v))).toEqual([1, 1, 1, 2, 2, 3, 3])
    expect(btcOnchainRequiredConfirmations('beta', Number.NaN)).toBe(3)
    expect(btcOnchainRequiredConfirmations('beta', -1)).toBe(3)
    expect([0.5, 1, 600, 1200].map((v) => btcOnchainRequiredConfirmations('test_only', v))).toEqual([1, 1, 1, 1])
  })

  it('wrangler.toml does not set BTC_ONCHAIN_LIMITS, so deploying this change keeps test_only', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    expect(toml.split('\n').some((l) => /^\s*BTC_ONCHAIN_LIMITS\s*=/.test(l))).toBe(false)
    expect(toml.split('\n').some((l) => /^\s*BTC_ONCHAIN_MAX_USD\s*=/.test(l))).toBe(false)
  })

  it('live env (no BTC_ONCHAIN_LIMITS): $1.01 still refused, $1.00 and $0.50 pass, $10 / $1,200 refused, no upstream create', async () => {
    for (const [amount, ok] of [['1.01', false], ['10.00', false], ['1200.00', false], ['1.00', true], ['0.50', true], ['0.49', false]] as const) {
      createCalls = 0
      quoteAmount = amount
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { query: '?beta=btc' })
      expect([amount, r.status]).toEqual([amount, ok ? 200 : 400])
      expect(createCalls).toBe(ok ? 1 : 0)
    }
    // A broken mode value behaves exactly like unset.
    quoteAmount = '10.00'
    createCalls = 0
    const typo = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: makeEnv({ BTC_ONCHAIN_LIMITS: 'Beta' }), query: '?beta=btc' })
    expect(typo.status).toBe(400)
    expect(typo.json.message).toBe('Native coin payment is limited to $1 per invoice. Pay with USDC/USDT instead.')
    expect(createCalls).toBe(0)
  })

  it('beta mode: $9.99 refused (min $10), $10 and $1,200 pass, $1,200.01 refused, var lowers only, NATIVE_MAX_USD cannot raise', async () => {
    for (const [amount, ok, msg] of [
      ['9.99', false, 'at least $10 per invoice'], ['10.00', true, ''], ['1200.00', true, ''], ['1200.01', false, '$1200 per invoice'],
    ] as const) {
      createCalls = 0
      quoteAmount = amount
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA(), query: '?beta=btc' })
      expect([amount, r.status]).toEqual([amount, ok ? 200 : 400])
      if (!ok) expect(r.json.message).toContain(msg)
      expect(createCalls).toBe(ok ? 1 : 0)
    }
    createCalls = 0
    quoteAmount = '600.00'
    const lowered = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA({ BTC_ONCHAIN_MAX_USD: '500' }), query: '?beta=btc' })
    expect(lowered.status).toBe(400)
    expect(lowered.json.message).toContain('$500 per invoice')
    quoteAmount = '1500.00'
    for (const extra of [{ BTC_ONCHAIN_MAX_USD: '5000' }, { NATIVE_MAX_USD: '5000' }]) {
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA(extra), query: '?beta=btc' })
      expect(r.status).toBe(400)
      expect(r.json.message).toContain('$1200 per invoice')
    }
    expect(createCalls).toBe(0)
  })

  it('beta mode never opens BTC by itself: without BTC@9000 in NATIVE_SOURCES_BETA or without ?beta=btc it is still an unknown coin', async () => {
    quoteAmount = '50.00'
    const noBeta = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA() })
    const noSwitch = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA({ NATIVE_SOURCES_BETA: 'ZEC@9133' }), query: '?beta=btc' })
    expect([noBeta.status, noSwitch.status]).toEqual([400, 400])
    expect(createCalls).toBe(0)
  })

  it('quote-invoice: live env shows the test_only band; beta env shows the beta band and tiers', async () => {
    const live = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { query: '?beta=btc' })
    expect(live.json.sourceMeta['BTC@9000']).toEqual({
      refund_address_required: false, beta: true, address_single_use: true, required_confirmations: 1, min_usd: 0.5, max_usd: 1,
    })
    expect(live.json.nativeMinUsd['9000']).toEqual({ BTC: 0.5 })
    const beta = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: BETA(), query: '?beta=btc' })
    expect(beta.json.sourceMeta['BTC@9000']).toMatchObject({ required_confirmations: 3, min_usd: 10, max_usd: 1200 })
    expect(beta.json.sourceMeta['BTC@9000'].confirmation_tiers.map((t: any) => t.confirmations)).toEqual([1, 2, 3])
    expect(beta.json.nativeMinUsd['9000']).toEqual({ BTC: 10 })
    // ZEC meta is untouched by the BTC mode.
    expect(beta.json.sourceMeta['ZEC@9133']).toEqual(live.json.sourceMeta['ZEC@9133'])
  })

  it('#1117 refusals: daily_cap -> BTC_CAPACITY_BUSY (503), loss_breaker -> BTC_PAUSED (503), passed through with router copy', async () => {
    quoteAmount = '50.00'
    for (const [reason, code] of [['daily_cap', 'BTC_CAPACITY_BUSY'], ['loss_breaker', 'BTC_PAUSED']] as const) {
      createAnswer = () => new Response(JSON.stringify({
        error: { code, message: 'BTC payins are paused. Please pay with USDC/USDT.' }, data: { errorCode: code, reason }, requestId: 'r',
      }), { status: 503 })
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA(), query: '?beta=btc' })
      expect([reason, r.status, r.json.code]).toEqual([reason, 503, code])
      expect(r.json.message).toBe(BTC_CODE_MESSAGES[code])
    }
    // The amount-too-low copy carries no number (it differs by mode on both sides).
    expect(BTC_CODE_MESSAGES.BTC_AMOUNT_TOO_LOW).not.toMatch(/\$\d/)
  })

  it('replay: the same beta create twice reuses the first order (one upstream create)', async () => {
    quoteAmount = '50.00'
    const first = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA(), query: '?beta=btc' })
    expect(first.status).toBe(200)
    expect(createCalls).toBe(1)
    const intent = createdIntent
    existingOrder = {
      id: 'rozo-pay-btc', status: 'payment_unpaid', paymentLink: 'https://pay.rozo.ai/b', provider: 'rozo',
      expiresAt: '2999-01-01T01:00:00.000Z', quoteExpiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '9000', tokenSymbol: 'BTC', amount: '0.00060000', receiverAddress: BC1Q, btc: btcBlock('awaiting') },
      destination: { ...intent.destination },
      metadata: { ...intent.metadata },
    }
    const second = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: BTC }, { env: BETA(), query: '?beta=btc' })
    expect(second.status).toBe(200)
    expect(second.json.reused).toBe(true)
    expect(createCalls).toBe(1)
  })
})
