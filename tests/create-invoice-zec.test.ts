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
  zecUpstreamError,
} from '../src/routes/create-invoice'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import {
  ALL_NATIVE_SOURCES,
  STABLE_SOURCES,
  betaParamSymbols,
  nativeMaxUsdFor,
  parseNativeSources,
  signTestPaymentId,
  sourceMeta,
  supportedSources,
  withBetaSources,
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
/** Coinbase session expiresAt; null = lookup fails. */
let linkExpiresAt: string | null = null
/** Overrides the intents create answer. */
let createAnswer: (() => Response) | null = null
/** Row GET /payments/order/<app>/<SESSION_ID> returns (null = 404). */
let existingOrder: any = null
/** Row that order lookup returns only after a create was attempted (slot race). */
let raceWinner: any = null

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

beforeEach(() => {
  createdIntent = null
  createCalls = 0
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
        amount: '10.5',
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
        invoice: { amount: '10.5' },
        merchant: 'OpenRouter, Inc',
        linkId: SESSION_ID,
      }), { status: 200 })
    }
    if (u.includes('/payments/order/')) {
      const row = u.endsWith(`/${SESSION_ID}`)
        ? existingOrder ?? (createCalls > 0 ? raceWinner : null)
        : null
      return row ? new Response(JSON.stringify(row), { status: 200 }) : new Response('not found', { status: 404 })
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

  it('caps ZEC at $2000 even if NATIVE_MAX_USD is higher', () => {
    expect(nativeMaxUsdFor('9133', '5000')).toBe(2000)
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
