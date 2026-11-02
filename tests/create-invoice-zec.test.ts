/**
 * Beta ZEC on Zcash (9133) through NEAR 1Click, behind ?beta=zec.
 *
 * Without the param ZEC is invisible on quote-invoice and rejected by
 * create-invoice. With it (and NATIVE_SOURCES_BETA listing ZEC@9133), the
 * quote shows 9133 plus sourceMeta, and create-invoice requires a refund
 * address and a merchant link that outlives the 1Click window, forwarding
 * both to rozo-intents-api (source.refundAddress,
 * metadata.merchant_link_expires_at).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ZEC_REFUND_DIGEST_KEY,
  checkZecLinkExpiry,
  handleCreateInvoice,
  refundAddressDigest,
  resolveRefundAddress,
  ZEC_CUSTODY_MIN_LINK_LIFE_MS,
  ZEC_MIN_LINK_LIFE_MS,
  zecMinLinkLifeMs,
  zecUpstreamError,
} from '../src/routes/create-invoice'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import { zecQuoteExpiredUnfunded } from '../src/routes/relink-guard'
import {
  ALL_NATIVE_SOURCES,
  STABLE_SOURCES,
  betaParamSymbols,
  nativeMaxUsdFor,
  parseNativeSources,
  parseZecRail,
  signTestPaymentId,
  sourceMeta,
  supportedSources,
  withBetaSources,
  zecShieldedAvailable,
  zecShieldedMaxUsd,
  zecShieldedRequested,
} from '../src/routes/native-sources'
import type { Env } from '../src/index'

const SECRET = 'test-link-secret'
const SESSION_ID = 'paymentSession_zec_test'
const T1 = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU'
const PROD_NATIVE = 'ETH@8453,ETH@1,BNB@56,SOL@900,ETH@42161,POL@137'

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
    NATIVE_SOURCES_BETA: 'ZEC@9133',
    ...extra,
  } as unknown as Env
}

let createdIntent: any = null
let createCalls = 0
let quoteAmount = '10.5'
/** Coinbase session expiresAt; null = lookup fails. */
let linkExpiresAt: string | null = null
/** Overrides the intents create answer. */
let createAnswer: (() => Response) | null = null
/** Row GET /payments/order/<app>/<SESSION_ID> returns (null = 404). */
let existingOrder: any = null
/** Row that order lookup returns only after a create was attempted (slot race). */
let raceWinner: any = null
/** What GET /payments/<existingOrder.id> returns after the create (null = the existing row itself). */
let paymentRowOverride: any = null

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

beforeEach(() => {
  createdIntent = null
  createCalls = 0
  quoteAmount = '10.5'
  linkExpiresAt = inMinutes(24 * 60)
  createAnswer = null
  existingOrder = null
  raceWinner = null
  paymentRowOverride = null
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
      return new Response(JSON.stringify({
        invoice: { amount: quoteAmount },
        merchant: 'OpenRouter, Inc',
        linkId: SESSION_ID,
      }), { status: 200 })
    }
    if (u.includes('/payments/order/')) {
      const row = u.endsWith(`/${SESSION_ID}`)
        ? existingOrder ?? (createCalls > 0 ? raceWinner : null)
        : null
      return row ? new Response(JSON.stringify(row), { status: 200 }) : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createCalls++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      if (createAnswer) return createAnswer()
      return new Response(JSON.stringify({
        id: 'rozo-pay-zec',
        provider: 'near',
        paymentLink: 'https://pay.rozo.ai/z',
        expiresAt: '2999-01-01T01:00:00.000Z',
        quoteExpiresAt: '2999-01-01T01:00:00.000Z',
        source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.08143000', receiverAddress: 't1DepositAddrXXXXXXXXXXXXXXXXXXXXX', fee: '0.00010000' },
      }), { status: 200 })
    }
    // GET /payments/<id> of the existing order: its full row (the post-create re-check reads it).
    if (u.includes('/payment-api') && existingOrder?.id && u.endsWith(`/payments/${existingOrder.id}`)) {
      return new Response(JSON.stringify(paymentRowOverride ?? existingOrder), { status: 200 })
    }
    if (u.includes('/payment-api')) return new Response(JSON.stringify({ status: 'payment_unpaid' }), { status: 200 })
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

const ZEC = { chainId: '9133', tokenSymbol: 'ZEC' }

describe('ZEC source table', () => {
  it('is not GA: NATIVE_SOURCES and the rozotest set never open it', () => {
    expect(ALL_NATIVE_SOURCES.has('ZEC@9133')).toBe(false)
    expect(parseNativeSources(`${PROD_NATIVE},ZEC@9133`).has('ZEC@9133')).toBe(false)
    expect(supportedSources(STABLE_SOURCES, parseNativeSources(PROD_NATIVE))['9133']).toBeUndefined()
  })

  it('opens only with ?beta=zec and a NATIVE_SOURCES_BETA entry', () => {
    const base = parseNativeSources(PROD_NATIVE)
    expect(withBetaSources(base, 'ZEC@9133', 'https://x/q').has('ZEC@9133')).toBe(false)
    expect(withBetaSources(base, 'ZEC@9133', 'https://x/q?beta=other').has('ZEC@9133')).toBe(false)
    expect(withBetaSources(base, '', 'https://x/q?beta=zec').has('ZEC@9133')).toBe(false)
    const open = withBetaSources(base, 'ZEC@9133', 'https://x/q?beta=ZEC')
    expect(open.has('ZEC@9133')).toBe(true)
    expect(open.has('ETH@8453')).toBe(true)
    expect(supportedSources(STABLE_SOURCES, open)['9133']).toEqual(['ZEC'])
    expect([...betaParamSymbols('https://x/q?beta=zec,foo')]).toEqual(['zec', 'foo'])
  })

  it('sourceMeta carries ZEC only when open, and nothing for GA coins', () => {
    expect(sourceMeta(parseNativeSources(PROD_NATIVE))).toEqual({})
    expect(sourceMeta(new Set(['ZEC@9133', 'ETH@8453']))).toEqual({
      'ZEC@9133': { eta_seconds: 480, refund_address_required: true, beta: true, address_single_use: true },
    })
  })

  it('caps ZEC at $3500 even if NATIVE_MAX_USD is higher', () => {
    expect(nativeMaxUsdFor('9133', '5000')).toBe(3500)
    expect(nativeMaxUsdFor('9133', '100')).toBe(100)
    expect(nativeMaxUsdFor('8453', '5000')).toBe(5000)
  })
})

describe('quote-invoice with ZEC', () => {
  it('hides 9133 without ?beta=zec', async () => {
    const { status, json } = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID })
    expect(status).toBe(200)
    expect(json.supportedSources['9133']).toBeUndefined()
    expect(json.sourceMeta).toEqual({})
    expect(json.supportedSources['8453']).toEqual(['USDC', 'ETH'])
  })

  it('shows 9133 and sourceMeta with ?beta=zec', async () => {
    const { status, json } = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { query: '?beta=zec' })
    expect(status).toBe(200)
    expect(json.supportedSources['9133']).toEqual(['ZEC'])
    expect(json.sourceMeta).toEqual({
      'ZEC@9133': { eta_seconds: 480, refund_address_required: true, beta: true, address_single_use: true },
    })
  })

  it('a rozotest_ quote opens every GA coin but ZEC only with ?beta=zec', async () => {
    const id = await signTestPaymentId(SECRET, 100, 'zecquote1')
    const plain = await post(handleQuoteInvoice as any, { payment_id: id })
    expect(plain.json.supportedSources['900']).toContain('SOL')
    expect(plain.json.supportedSources['9133']).toBeUndefined()
    const beta = await post(handleQuoteInvoice as any, { payment_id: id }, { query: '?beta=zec' })
    expect(beta.json.supportedSources['9133']).toEqual(['ZEC'])
    expect(beta.json.sourceMeta['ZEC@9133'].refund_address_required).toBe(true)
  })
})

describe('create-invoice with ZEC', () => {
  it('rejects ZEC without ?beta=zec as UNSUPPORTED_SOURCE', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    })
    expect(status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_SOURCE')
    expect(json.supported_sources['9133']).toBeUndefined()
    expect(createCalls).toBe(0)
  })

  it('rejects ZEC when NATIVE_SOURCES_BETA is empty, even with ?beta=zec', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { env: makeEnv({ NATIVE_SOURCES_BETA: '' }), query: '?beta=zec' })
    expect(status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_SOURCE')
  })

  it('creates an exactOut near order with refundAddress and merchant_link_expires_at', async () => {
    linkExpiresAt = inMinutes(120)
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: `  ${T1} `,
      client: 'web', pay_method: 'cashu', landing_param: 'via=zec',
    }, { query: '?beta=zec' })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.rozoPaymentId).toBe('rozo-pay-zec')
    expect(json.expiresAt).toBe('2999-01-01T01:00:00.000Z')
    expect(json.quoteExpiresAt).toBe('2999-01-01T01:00:00.000Z')
    expect(json.nativeAmount).toBe('0.08143000')
    expect(json.source).toMatchObject({ chainId: '9133', tokenSymbol: 'ZEC' })
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.source).toEqual({ chainId: '9133', tokenSymbol: 'ZEC', refundAddress: T1 })
    expect(createdIntent.destination).toMatchObject({ chainId: '8453', tokenSymbol: 'USDC', amount: json.callerPays })
    expect(createdIntent.metadata.merchant_link_expires_at).toBe(new Date(Date.parse(linkExpiresAt!)).toISOString())
    // metadata.client stays a string label; the #238 passthrough is intact.
    expect(createdIntent.metadata.client).toBe('web')
    expect(createdIntent.metadata.pay_method).toBe('cashu')
    expect(createdIntent.metadata.landing_param).toBe('via=zec')
    expect(createdIntent.provider).toBeUndefined()
    expect(createdIntent.gasDrop).toBeUndefined()
  })

  it('400 REFUND_ADDRESS_REQUIRED when refund_address is missing or empty, before any create', async () => {
    for (const refund of [undefined, '', '   ', 42]) {
      const { status, json } = await post(handleCreateInvoice, {
        payment_id: SESSION_ID, source: ZEC, ...(refund === undefined ? {} : { refund_address: refund }),
      }, { query: '?beta=zec' })
      expect(status).toBe(400)
      expect(json.code).toBe('REFUND_ADDRESS_REQUIRED')
    }
    expect(createCalls).toBe(0)
  })

  it('400 ZEC_SHIELDED_ADDRESS_NOT_SUPPORTED for a unified/sapling refund address', async () => {
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: 'u1abcdefghijklmnop',
    }, { query: '?beta=zec' })
    expect(status).toBe(400)
    expect(json.code).toBe('ZEC_SHIELDED_ADDRESS_NOT_SUPPORTED')
    expect(createCalls).toBe(0)
  })

  it('400 MERCHANT_LINK_EXPIRES_TOO_SOON when the link has under 75 minutes left', async () => {
    linkExpiresAt = inMinutes(70)
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(status).toBe(400)
    expect(json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
  })

  it('400 MERCHANT_LINK_EXPIRES_TOO_SOON when the link expiry is unknown', async () => {
    linkExpiresAt = null
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(status).toBe(400)
    expect(json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
  })

  it('a non-ZEC order still succeeds when the link expiry is unknown, and ignores refund_address', async () => {
    linkExpiresAt = null
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'ETH' }, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(status).toBe(200)
    expect(json.linkExpiresAt).toBeNull()
    expect(createdIntent.source).toEqual({ chainId: '8453', tokenSymbol: 'ETH' })
    expect(createdIntent.metadata.merchant_link_expires_at).toBeUndefined()
  })

  it('a rozotest_ ZEC order sends a synthetic link horizon (no external link)', async () => {
    const id = await signTestPaymentId(SECRET, 50, 'zectest1')
    const { status } = await post(handleCreateInvoice, {
      payment_id: id, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(status).toBe(200)
    const exp = Date.parse(createdIntent.metadata.merchant_link_expires_at)
    expect(exp).toBeGreaterThan(Date.now() + 23 * 3600_000)
    expect(createdIntent.metadata.testMode).toBe(true)
  })

  it('passes rozo-intents-api ZEC error codes through with their status', async () => {
    const cases: Array<[number, any, string]> = [
      [403, { error: { code: 'ZEC_NOT_ENABLED', message: 'ZEC is not enabled' }, data: { errorCode: 'ZEC_NOT_ENABLED' } }, 'ZEC_NOT_ENABLED'],
      [400, { error: { code: 'QUOTE_DRIFT', message: 'drift' }, data: { errorCode: 'QUOTE_DRIFT' } }, 'QUOTE_DRIFT'],
      [400, { error: { code: 'amountTooHigh', message: 'too high' }, data: { errorCode: 'EXCEEDS_LIMIT' } }, 'EXCEEDS_LIMIT'],
      [400, { error: { code: 'MERCHANT_LINK_EXPIRES_TOO_SOON', message: 'soon' } }, 'MERCHANT_LINK_EXPIRES_TOO_SOON'],
    ]
    for (const [code, body, expected] of cases) {
      createAnswer = () => new Response(JSON.stringify(body), { status: code })
      const { status, json } = await post(handleCreateInvoice, {
        payment_id: SESSION_ID, source: ZEC, refund_address: T1,
      }, { query: '?beta=zec' })
      expect(status).toBe(code)
      expect(json.code).toBe(expected)
    }
  })

  it('an unknown upstream 400 on a ZEC create stays a 502', async () => {
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'providerError', message: 'x' } }), { status: 400 })
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(status).toBe(502)
    expect(json.code).toBe('INTENTS_API_FAILED')
  })

  it('non-ZEC creates keep the generic 502 even for a ZEC-looking upstream code', async () => {
    createAnswer = () => new Response(JSON.stringify({ data: { errorCode: 'EXCEEDS_LIMIT' } }), { status: 400 })
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'ETH' },
    })
    expect(status).toBe(502)
    expect(json.code).toBe('INTENTS_API_FAILED')
  })
})

const T1_OTHER = 't1XXSamplePayerRefundOtherAddr0000'

/** An unpaid order shaped like a GET of the intent a fresh ZEC create sent. */
function rowFrom(intent: any, overrides: Record<string, unknown> = {}) {
  return {
    id: 'rozo-pay-existing',
    status: 'payment_unpaid',
    paymentLink: 'https://pay.rozo.ai/existing',
    expiresAt: '2999-01-01T01:00:00.000Z',
    source: { chainId: intent.source.chainId, tokenSymbol: intent.source.tokenSymbol, amount: '0.08143000' },
    destination: { ...intent.destination },
    metadata: { ...intent.metadata },
    ...overrides,
  }
}

/** Fresh ZEC create with `refund`, returning the intent body it sent. */
async function freshZecIntent(refund = T1) {
  const { status } = await post(handleCreateInvoice, {
    payment_id: SESSION_ID, source: ZEC, refund_address: refund,
  }, { query: '?beta=zec' })
  expect(status).toBe(200)
  const intent = createdIntent
  createCalls = 0
  createdIntent = null
  return intent
}

describe('ZEC order reuse checks the bound refund address', () => {
  it('a fresh ZEC create records the refund address digest in metadata', async () => {
    const intent = await freshZecIntent()
    expect(intent.metadata[ZEC_REFUND_DIGEST_KEY]).toBe(await refundAddressDigest(T1))
    expect(JSON.stringify(intent.metadata)).not.toContain(T1)
  })

  it('same refund address: reuses the existing order', async () => {
    existingOrder = rowFrom(await freshZecIntent())
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: ` ${T1} `,
    }, { query: '?beta=zec' })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.rozoPaymentId).toBe('rozo-pay-existing')
    expect(createCalls).toBe(0)
  })

  it('different refund address: 409 REFUND_ADDRESS_MISMATCH with expiresAt, no payable order', async () => {
    existingOrder = rowFrom(await freshZecIntent())
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1_OTHER,
    }, { query: '?beta=zec' })
    expect(status).toBe(409)
    expect(json.ok).toBe(false)
    expect(json.code).toBe('REFUND_ADDRESS_MISMATCH')
    expect(json.error.code).toBe('REFUND_ADDRESS_MISMATCH')
    expect(json.expiresAt).toBe('2999-01-01T01:00:00.000Z')
    expect(json.message).toContain('2999-01-01T01:00:00.000Z')
    expect(json.message).toContain('cannot be changed')
    expect(json.paymentLink).toBeUndefined()
    expect(json.rozoPaymentId).toBe('rozo-pay-existing')
    expect(createCalls).toBe(0)
  })

  it('unknown bound refund address (order created before the digest existed): 409', async () => {
    const intent = await freshZecIntent()
    delete intent.metadata[ZEC_REFUND_DIGEST_KEY]
    existingOrder = rowFrom(intent)
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(status).toBe(409)
    expect(json.code).toBe('REFUND_ADDRESS_MISMATCH')
    expect(json.message).toContain('cannot be verified')
    expect(json.paymentLink).toBeUndefined()
  })

  it('a plain metadata.internal.zec_refund_address, when present, is compared directly', async () => {
    const intent = await freshZecIntent()
    delete intent.metadata[ZEC_REFUND_DIGEST_KEY]
    existingOrder = rowFrom(intent)
    existingOrder.metadata.internal = { zec_refund_address: T1 }
    const same = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(same.status).toBe(200)
    expect(same.json.reused).toBe(true)
    const other = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1_OTHER,
    }, { query: '?beta=zec' })
    expect(other.status).toBe(409)
    expect(other.json.code).toBe('REFUND_ADDRESS_MISMATCH')
  })

  it('create-conflict reuse path: same address reuses the winner, different address gets 409', async () => {
    const intent = await freshZecIntent()
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'orderIdConflict' } }), { status: 409 })

    raceWinner = rowFrom(intent, { id: 'rozo-pay-winner' })
    const same = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(same.status).toBe(200)
    expect(same.json.reused).toBe(true)
    expect(same.json.rozoPaymentId).toBe('rozo-pay-winner')

    createCalls = 0
    const other = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1_OTHER,
    }, { query: '?beta=zec' })
    expect(other.status).toBe(409)
    expect(other.json.code).toBe('REFUND_ADDRESS_MISMATCH')
    expect(other.json.rozoPaymentId).toBe('rozo-pay-winner')
    expect(other.json.expiresAt).toBe('2999-01-01T01:00:00.000Z')

    createCalls = 0
    const unknownWinner = rowFrom(intent, { id: 'rozo-pay-winner' })
    delete (unknownWinner.metadata as any)[ZEC_REFUND_DIGEST_KEY]
    raceWinner = unknownWinner
    const unknown = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { query: '?beta=zec' })
    expect(unknown.status).toBe(409)
    expect(unknown.json.code).toBe('REFUND_ADDRESS_MISMATCH')
  })

  it('non-ZEC orders are unaffected: an existing ETH order is reused without any refund check', async () => {
    const { status } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'ETH' },
    })
    expect(status).toBe(200)
    const intent = createdIntent
    expect(intent.metadata[ZEC_REFUND_DIGEST_KEY]).toBeUndefined()
    createCalls = 0
    existingOrder = rowFrom(intent, {
      source: { chainId: '8453', tokenSymbol: 'ETH', amount: '0.003' },
    })
    const reuse = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'ETH' }, refund_address: T1_OTHER,
    })
    expect(reuse.status).toBe(200)
    expect(reuse.json.reused).toBe(true)
    expect(reuse.json.rozoPaymentId).toBe('rozo-pay-existing')
    expect(createCalls).toBe(0)
  })
})

describe('ZEC helpers', () => {
  it('resolveRefundAddress', () => {
    expect(resolveRefundAddress(T1)).toEqual({ ok: true, address: T1 })
    expect(resolveRefundAddress('zs1abc')).toMatchObject({ ok: false, code: 'ZEC_SHIELDED_ADDRESS_NOT_SUPPORTED' })
    expect(resolveRefundAddress('t1<script>')).toMatchObject({ ok: false, code: 'REFUND_ADDRESS_REQUIRED' })
    expect(resolveRefundAddress('t'.repeat(129))).toMatchObject({ ok: false, code: 'REFUND_ADDRESS_REQUIRED' })
  })

  it('checkZecLinkExpiry boundary at 75 minutes', () => {
    const now = Date.parse('2026-10-10T00:00:00.000Z')
    expect(checkZecLinkExpiry('2026-10-10T01:15:00.000Z', now)).toEqual({ ok: true, iso: '2026-10-10T01:15:00.000Z' })
    expect(checkZecLinkExpiry('2026-10-10T01:14:59.000Z', now).ok).toBe(false)
    expect(checkZecLinkExpiry(null, now).ok).toBe(false)
    expect(checkZecLinkExpiry('garbage', now).ok).toBe(false)
  })

  it('zecUpstreamError ignores 5xx and unknown codes', () => {
    expect(zecUpstreamError(500, JSON.stringify({ data: { errorCode: 'ZEC_NOT_ENABLED' } }))).toBeNull()
    expect(zecUpstreamError(400, 'not json')).toBeNull()
    expect(zecUpstreamError(400, JSON.stringify({ error: { code: 'invalidRequest' } }))).toBeNull()
  })
})

describe('ZEC_RAIL=custody (Rozo self-custody rail)', () => {
  const custodyEnv = () => makeEnv({ ZEC_RAIL: 'custody' })
  const CUSTODY_META = {
    refund_address_required: false,
    beta: true,
    address_single_use: true,
    confirmations: { under110: 1, from110: 2 },
  }

  it('parseZecRail defaults to near for anything but an exact custody', () => {
    expect(parseZecRail(undefined)).toBe('near')
    expect(parseZecRail('')).toBe('near')
    expect(parseZecRail('near')).toBe('near')
    expect(parseZecRail('custodial')).toBe('near')
    expect(parseZecRail(' Custody ')).toBe('custody')
  })

  it('near (default) keeps sourceMeta and the cap byte-for-byte', () => {
    const open = new Set(['ZEC@9133'])
    expect(sourceMeta(open, 'near')).toEqual(sourceMeta(open))
    expect(JSON.stringify(sourceMeta(open, 'near'))).toBe(
      '{"ZEC@9133":{"eta_seconds":480,"refund_address_required":true,"beta":true,"address_single_use":true}}',
    )
    expect(nativeMaxUsdFor('9133', undefined, 'near')).toBe(3500)
    expect(zecMinLinkLifeMs('near')).toBe(ZEC_MIN_LINK_LIFE_MS)
  })

  it('custody sourceMeta: no eta, single-use address, 1/2 confirmation tiers', () => {
    expect(sourceMeta(new Set(['ZEC@9133', 'ETH@8453']), 'custody')).toEqual({ 'ZEC@9133': CUSTODY_META })
    expect('eta_seconds' in sourceMeta(new Set(['ZEC@9133']), 'custody')['ZEC@9133']).toBe(false)
    // GA coins never gain metadata from the rail switch.
    expect(sourceMeta(parseNativeSources(PROD_NATIVE), 'custody')).toEqual({})
  })

  it('custody caps ZEC below $3500 and leaves other coins alone', () => {
    expect(nativeMaxUsdFor('9133', undefined, 'custody')).toBe(3499.99)
    expect(nativeMaxUsdFor('9133', '5000', 'custody')).toBe(3499.99)
    expect(nativeMaxUsdFor('9133', '100', 'custody')).toBe(100)
    expect(nativeMaxUsdFor('8453', '5000', 'custody')).toBe(5000)
  })

  // Boundary at the ZEC caps through create-invoice: callerPays > cap is rejected.
  it.each([
    ['near', '3499.99', 200],
    ['near', '3500', 200],
    ['near', '3500.01', 400],
    ['custody', '3499.98', 200],
    ['custody', '3499.99', 200],
    ['custody', '3500', 400],
  ] as const)('ZEC %s rail: callerPays %s -> %i', async (rail, amount, expected) => {
    quoteAmount = amount
    const env = makeEnv({ ZEC_RAIL: rail })
    const { status, json } = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { env, query: '?beta=zec' })
    expect(status).toBe(expected)
    if (expected === 400) {
      expect(json.code).toBe('UNSUPPORTED_SOURCE')
      expect(createCalls).toBe(0)
    } else {
      expect(Number(json.callerPays)).toBe(Number(amount))
      expect(createCalls).toBe(1)
    }
  })

  it('custody link margin = 30 min lock + 10 min margin + 2 x 75 s', () => {
    expect(ZEC_CUSTODY_MIN_LINK_LIFE_MS).toBe(42.5 * 60_000)
    expect(zecMinLinkLifeMs('custody')).toBe(ZEC_CUSTODY_MIN_LINK_LIFE_MS)
    const now = Date.parse('2026-10-10T00:00:00.000Z')
    expect(checkZecLinkExpiry('2026-10-10T00:42:30.000Z', now, ZEC_CUSTODY_MIN_LINK_LIFE_MS).ok).toBe(true)
    const short = checkZecLinkExpiry('2026-10-10T00:42:29.000Z', now, ZEC_CUSTODY_MIN_LINK_LIFE_MS)
    expect(short.ok).toBe(false)
    expect((short as any).message).toContain('43 minutes')
    expect(checkZecLinkExpiry(null, now, ZEC_CUSTODY_MIN_LINK_LIFE_MS).ok).toBe(false)
  })

  it('quote-invoice shows the custody sourceMeta with ?beta=zec', async () => {
    const { json } = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: custodyEnv(), query: '?beta=zec' })
    expect(json.sourceMeta).toEqual({ 'ZEC@9133': CUSTODY_META })
    const plain = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: custodyEnv() })
    expect(plain.json.sourceMeta).toEqual({})
  })

  it('create accepts a 50 min link on custody that near refuses', async () => {
    linkExpiresAt = inMinutes(50)
    const near = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { query: '?beta=zec' })
    expect(near.status).toBe(400)
    expect(near.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
    const custody = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { env: custodyEnv(), query: '?beta=zec' })
    expect(custody.status).toBe(200)
    expect(createdIntent.source.refundAddress).toBe(T1)
  })

  it('custody still refuses a 40 min link (30 min lock since 2026-10-15)', async () => {
    linkExpiresAt = inMinutes(40)
    const short = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { env: custodyEnv(), query: '?beta=zec' })
    expect(short.status).toBe(400)
    expect(short.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
  })

  it('custody: refund address optional (none forwarded, no digest); near still requires it', async () => {
    linkExpiresAt = inMinutes(120)
    for (const body of [{}, { refund_address: '' }, { refund_address: '   ' }]) {
      createCalls = 0
      createdIntent = null
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, ...body }, { env: custodyEnv(), query: '?beta=zec' })
      expect(r.status).toBe(200)
      expect(createCalls).toBe(1)
      expect('refundAddress' in createdIntent.source).toBe(false)
      expect(createdIntent.metadata[ZEC_REFUND_DIGEST_KEY]).toBeUndefined()
      expect(createdIntent.metadata.zec_refund_address_none).toBe(true)
    }
    // A provided non-string value is not "absent": it is refused.
    const odd = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: 12345 }, { env: custodyEnv(), query: '?beta=zec' })
    expect(odd.status).toBe(400)
    expect(odd.json.code).toBe('REFUND_ADDRESS_REQUIRED')
    createCalls = 0
    const near = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { query: '?beta=zec' })
    expect(near.status).toBe(400)
    expect(near.json.code).toBe('REFUND_ADDRESS_REQUIRED')
    expect(createCalls).toBe(0)
  })

  it('custody: a provided refund address is still checked and forwarded', async () => {
    linkExpiresAt = inMinutes(120)
    const shielded = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: 'zs1abcdef' }, { env: custodyEnv(), query: '?beta=zec' })
    expect(shielded.status).toBe(400)
    expect(shielded.json.code).toBe('ZEC_SHIELDED_ADDRESS_NOT_SUPPORTED')
    const junk = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: 't1 bad!' }, { env: custodyEnv(), query: '?beta=zec' })
    expect(junk.status).toBe(400)
    expect(junk.json.code).toBe('REFUND_ADDRESS_REQUIRED')
    expect(createCalls).toBe(0)
    const ok = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { env: custodyEnv(), query: '?beta=zec' })
    expect(ok.status).toBe(200)
    expect(createdIntent.source.refundAddress).toBe(T1)
    expect(createdIntent.metadata[ZEC_REFUND_DIGEST_KEY]).toBe(await refundAddressDigest(T1))
    expect(createdIntent.metadata.zec_refund_address_none).toBeUndefined()
  })

  it('custody reuse: an order created without a refund address is reused; a bound one is still checked', async () => {
    linkExpiresAt = inMinutes(120)
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: '?beta=zec' })
    existingOrder = rowFrom(createdIntent)
    createCalls = 0
    for (const body of [{}, { refund_address: T1 }]) {
      const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, ...body }, { env: custodyEnv(), query: '?beta=zec' })
      expect(r.status).toBe(200)
      expect(r.json.reused).toBe(true)
    }
    expect(createCalls).toBe(0)
    // Near rail: the same unbound order cannot be verified, so it is not handed out.
    const near = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { query: '?beta=zec' })
    expect(near.status).toBe(409)
    expect(near.json.code).toBe('REFUND_ADDRESS_MISMATCH')
    // Without the marker an unbound order (e.g. an older near order whose
    // digest is missing) is still "cannot be verified" on custody too.
    const unmarked = rowFrom(createdIntent)
    delete (unmarked.metadata as any).zec_refund_address_none
    existingOrder = unmarked
    const unverified = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: '?beta=zec' })
    expect(unverified.status).toBe(409)
    expect(unverified.json.code).toBe('REFUND_ADDRESS_MISMATCH')
    // A custody order that did bind an address keeps the mismatch check.
    existingOrder = null
    existingOrder = rowFrom(await freshZecIntent())
    const other = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1_OTHER }, { env: custodyEnv(), query: '?beta=zec' })
    expect(other.status).toBe(409)
    expect(other.json.code).toBe('REFUND_ADDRESS_MISMATCH')
  })

  it('passes the custody refusal codes through with clear router messages', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [409, 'ZEC_DAILY_CAP_REACHED', /today's limit/],
      [409, 'ZEC_CAPACITY_BUSY', /at capacity/],
      [503, 'ZEC_PAUSED', /paused/],
      [503, 'ZEC_MONITOR_STALE', /catching up/],
      [429, 'ZEC_CAPACITY_BUSY', /at capacity/],
    ]
    for (const [code, errorCode, msg] of cases) {
      createAnswer = () => new Response(
        JSON.stringify({ error: { code: errorCode, message: 'internal detail e=1180.2' }, data: { errorCode } }),
        { status: code },
      )
      const { status, json } = await post(handleCreateInvoice, {
        payment_id: SESSION_ID, source: ZEC, refund_address: T1,
      }, { env: custodyEnv(), query: '?beta=zec' })
      expect(status).toBe(code)
      expect(json.code).toBe(errorCode)
      expect(json.message).toMatch(msg)
      expect(json.message).not.toContain('1180')
    }
  })

  it('zecUpstreamError: custody codes on 4xx/503, never on other 5xx', () => {
    const body = JSON.stringify({ data: { errorCode: 'ZEC_PAUSED' } })
    expect(zecUpstreamError(503, body)?.code).toBe('ZEC_PAUSED')
    expect(zecUpstreamError(409, body)?.code).toBe('ZEC_PAUSED')
    expect(zecUpstreamError(500, body)).toBeNull()
    expect(zecUpstreamError(502, body)).toBeNull()
    // ZEC_NOT_ENABLED keeps the upstream wording, with a fallback when absent.
    expect(zecUpstreamError(403, JSON.stringify({ data: { errorCode: 'ZEC_NOT_ENABLED' } }))?.message).toMatch(/not available/)
  })

  it('a 409 orderIdConflict is not mistaken for a custody refusal', async () => {
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'orderIdConflict' } }), { status: 409 })
    const { status, json } = await post(handleCreateInvoice, {
      payment_id: SESSION_ID, source: ZEC, refund_address: T1,
    }, { env: custodyEnv(), query: '?beta=zec' })
    expect(status).toBe(409)
    expect(json.code).toBe('LINK_USED_OR_EXPIRED')
  })
})

// ── Shielded ZEC pay-in (stage 2, 2026-11-02) ──────────────────────────────
//
// `source.shielded=true` on the custody rail with `?beta=zec,zec_shielded`
// asks rozo-intents-api for a shielded-balance order (a pool Unified Address
// and a ZIP-321 paymentUri). The flag is a mode, not a coin: the coin still
// needs ?beta=zec. A shielded order has no refund path and its own cap.
describe('shielded ZEC pay-in (source.shielded, ?beta=zec_shielded)', () => {
  const custodyEnv = (extra: Record<string, string> = {}) => makeEnv({ ZEC_RAIL: 'custody', ...extra })
  const BOTH = '?beta=zec,zec_shielded'
  const UA = 'u1' + 'q'.repeat(140)
  const URI = `zcash:${UA}?amount=0.00413867&memo=MjU4NjQzMmM`
  const SHIELDED = { ...ZEC, shielded: true }
  /** Upstream answer for a shielded order. */
  const shieldedCreate = () => new Response(JSON.stringify({
    id: 'rozo-pay-shield',
    provider: 'rozo',
    paymentLink: 'https://pay.rozo.ai/s',
    expiresAt: '2999-01-01T01:00:00.000Z',
    quoteExpiresAt: '2999-01-01T01:00:00.000Z',
    source: {
      chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: UA, paymentUri: URI,
      zec: { rail: 'zec_custody', receive: 'shielded', requiredConfirmations: 1, confirmations: 0, requiredZat: '413867', receivedZat: '0', payinState: 'awaiting', quoteExpiresAt: '2999-01-01T01:00:00.000Z' },
    },
  }), { status: 200 })
  const transparentCreate = () => new Response(JSON.stringify({
    id: 'rozo-pay-t',
    provider: 'rozo',
    paymentLink: 'https://pay.rozo.ai/t',
    expiresAt: '2999-01-01T01:00:00.000Z',
    quoteExpiresAt: '2999-01-01T01:00:00.000Z',
    source: {
      chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: T1, paymentUri: 'zcash:leaked-should-not-echo',
      zec: { rail: 'zec_custody', receive: 'transparent', requiredConfirmations: 1, confirmations: 0, requiredZat: '413867', receivedZat: '0', payinState: 'awaiting', quoteExpiresAt: '2999-01-01T01:00:00.000Z' },
    },
  }), { status: 200 })

  beforeEach(() => { linkExpiresAt = inMinutes(120) })

  it('the mode flag is parsed from ?beta= and needs ZEC open + custody rail', () => {
    expect(zecShieldedRequested('https://x/?beta=zec_shielded')).toBe(true)
    expect(zecShieldedRequested('https://x/?beta=zec,ZEC_SHIELDED')).toBe(true)
    expect(zecShieldedRequested('https://x/?beta=zec')).toBe(false)
    const open = withBetaSources(parseNativeSources(PROD_NATIVE), 'ZEC@9133', 'https://x/?beta=zec,zec_shielded')
    expect(zecShieldedAvailable(open, 'custody', 'https://x/?beta=zec,zec_shielded')).toBe(true)
    expect(zecShieldedAvailable(open, 'near', 'https://x/?beta=zec,zec_shielded')).toBe(false)
    expect(zecShieldedAvailable(open, 'custody', 'https://x/?beta=zec')).toBe(false)
    expect(zecShieldedAvailable(parseNativeSources(PROD_NATIVE), 'custody', 'https://x/?beta=zec,zec_shielded')).toBe(false)
    expect(zecShieldedMaxUsd(undefined)).toBe(1200)
    expect(zecShieldedMaxUsd('50')).toBe(50)
    expect(zecShieldedMaxUsd('-1')).toBe(1200)
  })

  it('sourceMeta marks shieldedAvailable only on custody with the flag', () => {
    const open = withBetaSources(parseNativeSources(PROD_NATIVE), 'ZEC@9133', 'https://x/?beta=zec')
    expect(sourceMeta(open, 'custody', true)['ZEC@9133'].shieldedAvailable).toBe(true)
    expect(sourceMeta(open, 'custody', false)['ZEC@9133']).not.toHaveProperty('shieldedAvailable')
    expect(sourceMeta(open, 'near', true)['ZEC@9133']).not.toHaveProperty('shieldedAvailable')
  })

  it('quote-invoice shows shieldedAvailable with ?beta=zec,zec_shielded on custody only', async () => {
    const both = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: custodyEnv(), query: BOTH })
    expect(both.json.sourceMeta['ZEC@9133'].shieldedAvailable).toBe(true)
    const coinOnly = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: custodyEnv(), query: '?beta=zec' })
    expect(coinOnly.json.sourceMeta['ZEC@9133']).not.toHaveProperty('shieldedAvailable')
    const flagOnly = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { env: custodyEnv(), query: '?beta=zec_shielded' })
    expect(flagOnly.json.sourceMeta).toEqual({})
    const near = await post(handleQuoteInvoice as any, { payment_id: SESSION_ID }, { query: BOTH })
    expect(near.json.sourceMeta['ZEC@9133']).not.toHaveProperty('shieldedAvailable')
  })

  it('creates a shielded order: source.shielded passed through, no refund fields, receive + paymentUri echoed', async () => {
    createAnswer = shieldedCreate
    const { status, json } = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(status).toBe(200)
    expect(createCalls).toBe(1)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.source).toEqual({ chainId: '9133', tokenSymbol: 'ZEC', shielded: true })
    expect(createdIntent.metadata.zec_refund_address_none).toBeUndefined()
    expect(createdIntent.metadata[ZEC_REFUND_DIGEST_KEY]).toBeUndefined()
    expect(json.source).toEqual({ chainId: '9133', tokenSymbol: 'ZEC', tokenAddress: '', zec: { receive: 'shielded' }, paymentUri: URI })
    expect(json.raw.source.zec.receive).toBe('shielded')
    expect(json.raw.source.paymentUri).toBe(URI)
    expect(json.raw.source.receiverAddress).toBe(UA)
  })

  it('a transparent order echoes receive=transparent and never a paymentUri', async () => {
    createAnswer = transparentCreate
    const { status, json } = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(status).toBe(200)
    expect('shielded' in createdIntent.source).toBe(false)
    expect(json.source.zec).toEqual({ receive: 'transparent' })
    expect(json.source).not.toHaveProperty('paymentUri')
    // upstream without the field (older rows): nothing invented
    createAnswer = null
    const plain = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(plain.json.source).not.toHaveProperty('zec')
  })

  it('shielded without the mode flag, or on the near rail, is refused before any create', async () => {
    for (const [env, query] of [[custodyEnv(), '?beta=zec'], [makeEnv(), BOTH], [custodyEnv(), '?beta=zec_shielded']] as const) {
      createCalls = 0
      const { status, json } = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env, query })
      expect(status).toBe(400)
      expect(['ZEC_SHIELDED_NOT_ENABLED', 'UNSUPPORTED_SOURCE']).toContain(json.code)
      expect(createCalls).toBe(0)
    }
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: '?beta=zec' })
    expect(r.json.code).toBe('ZEC_SHIELDED_NOT_ENABLED')
    const bad = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: { ...ZEC, shielded: 'yes' } }, { env: custodyEnv(), query: BOTH })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('INVALID_SOURCE')
  })

  it('a shielded order keeps the merchant link expiry rule and forwards merchant_link_expires_at', async () => {
    linkExpiresAt = inMinutes(40)
    const short = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(short.status).toBe(400)
    expect(short.json.code).toBe('MERCHANT_LINK_EXPIRES_TOO_SOON')
    expect(createCalls).toBe(0)
    linkExpiresAt = inMinutes(120)
    createAnswer = shieldedCreate
    const ok = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(ok.status).toBe(200)
    expect(typeof createdIntent.metadata.merchant_link_expires_at).toBe('string')
  })

  it('upstream ZEC refusals pass through with their status for a shielded create too', async () => {
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'ZEC_CAPACITY_BUSY', message: 'Shielded ZEC payins are temporarily unavailable.' }, data: { errorCode: 'ZEC_CAPACITY_BUSY', reason: 'monitor_missing' } }), { status: 503 })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('ZEC_CAPACITY_BUSY')
  })

  it('a refund address with a shielded order is refused; shielded on a non-ZEC coin is ignored with a warning', async () => {
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED, refund_address: T1 }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('ZEC_SHIELDED_REFUND_ADDRESS_NOT_APPLICABLE')
    expect(createCalls).toBe(0)
    const eth = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: { chainId: '8453', tokenSymbol: 'ETH', shielded: true } }, { env: custodyEnv(), query: BOTH })
    expect(eth.status).toBe(200)
    expect('shielded' in createdIntent.source).toBe(false)
    expect(eth.json.warnings.join(' ')).toContain('source.shielded was ignored')
  })

  it.each([
    ['1200', undefined, 200],
    ['1200.01', undefined, 400],
    ['50', '50', 200],
    ['50.01', '50', 400],
  ] as const)('shielded cap: callerPays %s with ZEC_SHIELDED_MAX_USD=%s -> %i', async (amount, cap, expected) => {
    quoteAmount = amount
    createAnswer = shieldedCreate
    const env = custodyEnv(cap ? { ZEC_SHIELDED_MAX_USD: cap } : {})
    const { status, json } = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env, query: BOTH })
    expect(status).toBe(expected)
    if (expected === 400) {
      expect(json.code).toBe('UNSUPPORTED_SOURCE')
      expect(json.message).toContain('Shielded ZEC')
      expect(createCalls).toBe(0)
    }
  })

  it('the shielded cap does not touch transparent custody orders', async () => {
    quoteAmount = '1500'
    const { status } = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(status).toBe(200)
  })

  it('reuse: an existing order of the other pay-in mode is reported, never switched or re-created', async () => {
    const shieldedRow = {
      ...rowFrom({ source: ZEC, destination: { chainId: '8453', amount: '10.5' }, metadata: { source: 'mpprouter-create-invoice', feeBps: 100, pricingVersion: 'v1' } }),
      provider: 'rozo',
      quoteExpiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: UA, paymentUri: URI, zec: { rail: 'zec_custody', receive: 'shielded' } },
    }
    // Pricing metadata must match the live pricing; copy it from a fresh create.
    createAnswer = shieldedCreate
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    shieldedRow.metadata = { ...createdIntent.metadata }
    shieldedRow.destination = { ...createdIntent.destination }
    createCalls = 0
    // transparent request against the shielded row
    existingOrder = shieldedRow
    const t = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(t.status).toBe(200)
    expect(t.json.reused).toBe(true)
    expect(t.json.sourceMismatch).toBe(true)
    expect(t.json.sourceMismatchCode).toBe('ZEC_RECEIVE_MODE_MISMATCH')
    expect(t.json.source).toEqual({ chainId: '9133', tokenSymbol: 'ZEC', zec: { receive: 'shielded' }, paymentUri: URI })
    // raw is the intents row, untouched: the checkout reads raw.source.zec.receive / raw.source.paymentUri on refresh
    expect(t.json.raw.source.zec.receive).toBe('shielded')
    expect(t.json.raw.source.paymentUri).toBe(URI)
    expect(t.json.warnings.join(' ')).toContain('pay-in mode')
    expect(createCalls).toBe(0)
    // shielded request against the same shielded row: plain reuse
    const s = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(s.status).toBe(200)
    expect(s.json.reused).toBe(true)
    expect(s.json.sourceMismatch).toBeUndefined()
    expect(createCalls).toBe(0)
    // shielded request against a transparent row (no receive field = transparent)
    existingOrder = { ...shieldedRow, source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: T1 }, metadata: { ...shieldedRow.metadata, zec_refund_address_none: true } }
    const x = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(x.status).toBe(200)
    expect(x.json.reused).toBe(true)
    expect(x.json.sourceMismatch).toBe(true)
    // the older row carries no receive field upstream: nothing is invented
    expect(x.json.source).toEqual({ chainId: '9133', tokenSymbol: 'ZEC' })
    expect(createCalls).toBe(0)
  })

  it('an existing transparent order above the shielded cap is reported as a mode mismatch, not a cap error', async () => {
    quoteAmount = '1500'
    createAnswer = transparentCreate
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    const row = { ...rowFrom(createdIntent), provider: 'rozo', quoteExpiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.1', receiverAddress: T1, zec: { rail: 'zec_custody', receive: 'transparent' } } }
    createCalls = 0
    existingOrder = row
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(true)
    expect(r.json.sourceMismatchCode).toBe('ZEC_RECEIVE_MODE_MISMATCH')
    expect(createCalls).toBe(0)
  })

  it('race winner of the other pay-in mode is reported with sourceMismatch', async () => {
    createAnswer = transparentCreate
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    raceWinner = { id: 'rozo-pay-winner', status: 'payment_unpaid', paymentLink: 'https://pay.rozo.ai/w', expiresAt: '2999-01-01T01:00:00.000Z',
      provider: 'rozo', quoteExpiresAt: '2999-01-01T01:00:00.000Z',
      source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: T1, zec: { rail: 'zec_custody', receive: 'transparent' } },
      destination: { ...createdIntent.destination }, metadata: { ...createdIntent.metadata } }
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'orderIdConflict' } }), { status: 409 })
    createCalls = 0
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(true)
    expect(r.json.rozoPaymentId).toBe('rozo-pay-winner')
    expect(r.json.sourceMismatch).toBe(true)
    expect(r.json.sourceMismatchCode).toBe('ZEC_RECEIVE_MODE_MISMATCH')
    expect(r.json.warnings.join(' ')).toContain('pay-in mode')
    expect(r.json.source.zec).toEqual({ receive: 'transparent' })
    // the other way round: a shielded winner (no refund binding) vs a transparent request
    createAnswer = shieldedCreate
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    raceWinner = { ...raceWinner, source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: UA, paymentUri: URI, zec: { rail: 'zec_custody', receive: 'shielded' } },
      destination: { ...createdIntent.destination }, metadata: { ...createdIntent.metadata } }
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'orderIdConflict' } }), { status: 409 })
    const t = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC, refund_address: T1 }, { env: custodyEnv(), query: BOTH })
    expect(t.status).toBe(200)
    expect(t.json.reused).toBe(true)
    expect(t.json.sourceMismatchCode).toBe('ZEC_RECEIVE_MODE_MISMATCH')
    expect(t.json.source).toEqual({ chainId: '9133', tokenSymbol: 'ZEC', zec: { receive: 'shielded' }, paymentUri: URI })
  })
})

// ── Quote-expired unfunded ZEC custody order is replaceable (2026-11-02) ────
//
// Incident: payment 22291f1a (transparent ZEC custody, quote expired 02:38Z,
// receivedZat 0, still payment_unpaid upstream until its 14:38Z link window)
// blocked a shielded create on the same link for 12 hours as a pay-in mode
// mismatch. Such an order is not live: a fresh order (either mode) replaces
// it in the next slot. Funds seen, or any other payinState, still blocks.
describe('quote-expired unfunded ZEC custody order', () => {
  const custodyEnv = () => makeEnv({ ZEC_RAIL: 'custody' })
  const BOTH = '?beta=zec,zec_shielded'
  const UA = 'u1' + 'q'.repeat(140)
  const URI = `zcash:${UA}?amount=0.00413867&memo=MjU4NjQzMmM`
  const SHIELDED = { ...ZEC, shielded: true }
  const zecBlock = (receive: 'shielded' | 'transparent', payinState: string, receivedZat = '0') => ({
    rail: 'zec_custody', receive, requiredConfirmations: 1, confirmations: 0, requiredZat: '413867', receivedZat, payinState,
    quoteExpiresAt: '2000-01-01T00:00:00.000Z',
  })
  const answer = (receive: 'shielded' | 'transparent') => () => new Response(JSON.stringify({
    id: `rozo-pay-new-${receive}`, provider: 'rozo', paymentLink: 'https://pay.rozo.ai/n', expiresAt: '2999-01-01T01:00:00.000Z',
    quoteExpiresAt: '2999-01-01T01:00:00.000Z',
    source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: receive === 'shielded' ? UA : T1,
      ...(receive === 'shielded' ? { paymentUri: URI } : {}), zec: { ...zecBlock(receive, 'awaiting'), quoteExpiresAt: '2999-01-01T01:00:00.000Z' } },
  }), { status: 200 })

  /** An existing order of `receive` mode on the base slot, priced like a fresh create of that mode. */
  async function existingRow(receive: 'shielded' | 'transparent', payinState: string, receivedZat = '0', extra: Record<string, unknown> = {}) {
    existingOrder = null
    raceWinner = null
    createAnswer = answer(receive)
    await post(handleCreateInvoice, { payment_id: SESSION_ID, source: receive === 'shielded' ? SHIELDED : ZEC }, { env: custodyEnv(), query: BOTH })
    const intent = createdIntent
    createCalls = 0
    createdIntent = null
    return {
      id: 'rozo-pay-old', status: 'payment_unpaid', paymentLink: 'https://pay.rozo.ai/old', provider: 'rozo',
      expiresAt: '2999-01-01T01:00:00.000Z', quoteExpiresAt: '2000-01-01T00:00:00.000Z',
      source: { chainId: '9133', tokenSymbol: 'ZEC', amount: '0.00413867', receiverAddress: receive === 'shielded' ? UA : T1,
        ...(receive === 'shielded' ? { paymentUri: URI } : {}), zec: zecBlock(receive, payinState, receivedZat) },
      destination: { ...intent.destination },
      metadata: { ...intent.metadata },
      ...extra,
    }
  }

  beforeEach(() => { linkExpiresAt = inMinutes(120) })

  it('predicate: only payment_unpaid + zec_custody + payinState expired + receivedZat 0 + no funding evidence', () => {
    const base = { status: 'payment_unpaid', source: { chainId: '9133', tokenSymbol: 'ZEC', zec: zecBlock('transparent', 'expired') } }
    expect(zecQuoteExpiredUnfunded(base)).toBe(true)
    expect(zecQuoteExpiredUnfunded({ ...base, status: 'payment_payin_completed' })).toBe(false)
    expect(zecQuoteExpiredUnfunded({ ...base, source: { ...base.source, zec: zecBlock('transparent', 'expired', '1') } })).toBe(false)
    for (const st of ['awaiting', 'seen', 'confirming', 'underpaid', 'late_review', 'reorged', 'eligible']) {
      expect(zecQuoteExpiredUnfunded({ ...base, source: { ...base.source, zec: zecBlock('transparent', st) } })).toBe(false)
    }
    expect(zecQuoteExpiredUnfunded({ ...base, source: { ...base.source, txHash: 'ab'.repeat(32) } })).toBe(false)
    expect(zecQuoteExpiredUnfunded({ ...base, source: { ...base.source, zec: { ...zecBlock('transparent', 'expired'), rail: 'near' } } })).toBe(false)
    expect(zecQuoteExpiredUnfunded({ status: 'payment_unpaid', source: { chainId: '9133', tokenSymbol: 'ZEC' } })).toBe(false)
  })

  it('transparent order expired unfunded: a shielded create gets a fresh order in the next slot', async () => {
    existingOrder = await existingRow('transparent', 'expired')
    createAnswer = answer('shielded')
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(false)
    expect(r.json.sourceMismatch).toBeUndefined()
    expect(r.json.rozoPaymentId).toBe('rozo-pay-new-shielded')
    expect(r.json.replacesExpiredPaymentIds).toEqual(['rozo-pay-old'])
    expect(createCalls).toBe(1)
    expect(createdIntent.orderId).toMatch(new RegExp(`^${SESSION_ID}__retry\\d+$`))
    expect(createdIntent.source.shielded).toBe(true)
  })

  it('shielded order expired unfunded: a transparent create gets a fresh order', async () => {
    existingOrder = await existingRow('shielded', 'expired')
    createAnswer = answer('transparent')
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(false)
    expect(r.json.rozoPaymentId).toBe('rozo-pay-new-transparent')
    expect(createCalls).toBe(1)
    expect('shielded' in createdIntent.source).toBe(false)
  })

  it('same mode, quote expired unfunded: a fresh order too (the old quote is dead)', async () => {
    existingOrder = await existingRow('transparent', 'expired')
    createAnswer = answer('transparent')
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(false)
    expect(createCalls).toBe(1)
  })

  it('expired with funds seen still blocks: reused and reported, never replaced', async () => {
    existingOrder = await existingRow('transparent', 'expired', '1000')
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(200)
    expect(r.json.reused).toBe(true)
    expect(r.json.sourceMismatchCode).toBe('ZEC_RECEIVE_MODE_MISMATCH')
    expect(createCalls).toBe(0)
    // funding evidence elsewhere on the row (receivedZat still '0') blocks as well
    existingOrder = await existingRow('transparent', 'expired', '0', {})
    existingOrder.source.txHash = 'ab'.repeat(32)
    const t = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(t.json.reused).toBe(true)
    expect(createCalls).toBe(0)
  })

  it('awaiting (quote still open) still reuses; a seen payment still blocks', async () => {
    existingOrder = await existingRow('transparent', 'awaiting')
    const same = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(same.status).toBe(200)
    expect(same.json.reused).toBe(true)
    expect(same.json.sourceMismatch).toBeUndefined()
    const other = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(other.json.reused).toBe(true)
    expect(other.json.sourceMismatchCode).toBe('ZEC_RECEIVE_MODE_MISMATCH')
    existingOrder = await existingRow('shielded', 'seen')
    const seen = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(seen.json.reused).toBe(true)
    expect(createCalls).toBe(0)
  })

  it('the replaced order revived mid-request (funds seen on re-read): 409, the new order is not handed out', async () => {
    existingOrder = await existingRow('transparent', 'expired')
    paymentRowOverride = { ...existingOrder, source: { ...existingOrder.source, zec: zecBlock('transparent', 'expired', '5000') } }
    createAnswer = answer('shielded')
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: SHIELDED }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(r.json.rozoPaymentId).toBe('rozo-pay-old')
  })

  it('a quote-expired unfunded race winner is not handed back', async () => {
    const winner = await existingRow('transparent', 'expired')
    raceWinner = { ...winner, id: 'rozo-pay-winner' }
    createAnswer = () => new Response(JSON.stringify({ error: { code: 'orderIdConflict' } }), { status: 409 })
    const r = await post(handleCreateInvoice, { payment_id: SESSION_ID, source: ZEC }, { env: custodyEnv(), query: BOTH })
    expect(r.status).toBe(409)
    expect(r.json.reused).toBeUndefined()
    expect(r.json.rozoPaymentId).not.toBe('rozo-pay-winner')
  })
})

