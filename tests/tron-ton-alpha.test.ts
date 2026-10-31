/**
 * TRON / TON fixed-address pay-in alpha proxy (src/routes/tron-ton-alpha.ts).
 *
 * The property that matters: every call for one Coinbase invoice sends the
 * SAME business order key and the SAME order facts upstream, whatever coin the
 * page asks for and whatever order id the caller tries to smuggle in, so a
 * coin switch and a switch back land on one order and return one amount.
 * The upstream fake below implements the PR #854 reuse rule (same order +
 * same option = original reservation) so the round trip is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALPHA_DESTINATION,
  buildAlphaUpstreamBody,
  findAlphaOption,
  handleTronTonAlphaCapability,
  handleTronTonAlphaOption,
  probeTronTonAlpha,
  resetTronTonAlphaCapabilityCache,
  tonRawToFriendly,
} from '../src/routes/tron-ton-alpha'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { checkCreateInvoiceGate } from '../src/routes/create-invoice-gate'
import { pendingPricingMatches } from '../src/routes/create-invoice'
import { resolveCheckoutPricing } from '../src/routes/checkout-web-pricing'
import { signTestPaymentId } from '../src/routes/native-sources'
import { alphaOrderMarkerKey, buildAlphaBusinessOrderBody } from '../src/routes/tron-ton-alpha-order'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const PL = 'pl_testTronTonAlpha01'
const SESSION = 'paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2'
const TRON_ADDR = 'TQ6sZ1jJcjC4Axq3dQ2h6YxSW5Znh5QGuf'
const TON_RAW = '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8'
const KEY = 'test-router-intents-key'

const TEST_SECRET = 'test-link-secret'

function freshKv() {
  const m = new Map<string, string>()
  return {
    map: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v) },
    delete: async (k: string) => { m.delete(k) },
  }
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: KEY,
    CHECKOUT_WEB_FEE_BPS: '100',
    ROZO_TEST_LINK_SECRET: TEST_SECRET,
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: freshKv(),
    ...extra,
  } as unknown as Env
}

// Intents payment-api fake for the business order (tron-ton-alpha-order.ts).
interface FakeIntents {
  lookups: string[]
  creates: any[]
  lookup?: (orderId: string) => Response | null
  create?: (body: any) => Response | null
}
let intents: FakeIntents

interface FakeUpstream {
  calls: Array<{ headers: Record<string, string>; body: any }>
  reply?: (body: any) => Response | null
}

let up: FakeUpstream
let legacyTonShape = false
let quoteLinkId = PL
let quoteStatus = 200
let linkExpiresAt: string | null = null
const firstQuote = '2026-10-27T10:00:00.000Z'

/** PR #854 allocate semantics, reduced to what the proxy can observe. */
function fakeAllocate(body: any): Response {
  const orders = (fakeAllocate as any).orders as Map<string, any>
  const k = `${body.merchantOrderId}`
  let o = orders.get(k)
  if (!o) {
    o = { facts: JSON.stringify([body.merchantOrderId, body.providerInvoiceKey, body.baseServiceUsd, body.existingAppFeeUsd, body.destination]), options: new Map() }
    orders.set(k, o)
  }
  const facts = JSON.stringify([body.merchantOrderId, body.providerInvoiceKey, body.baseServiceUsd, body.existingAppFeeUsd, body.destination])
  if (facts !== o.facts) return new Response(JSON.stringify({ error: 'order_conflict' }), { status: 409 })
  const optKey = `${body.network}:${body.token}`
  let opt = o.options.get(optKey)
  const reused = !!opt
  if (!opt) {
    const n = (fakeAllocate as any).seq++
    const gross = body.baseServiceUsd + body.existingAppFeeUsd + (body.network === 'ton' ? 0.1 : 1)
    opt = body.token === 'TRX'
      ? { expectedAmount: (Math.round(gross / 0.3 * 10) / 10 + n * 0.1).toFixed(1), gross }
      : { expectedAmount: (gross + n * 0.01).toFixed(2), gross: gross + n * 0.01 }
    opt.ref = body.network === 'ton' ? String(100000 + n) : null
    o.options.set(optKey, opt)
  }
  return new Response(JSON.stringify({
    orderId: body.merchantOrderId, alpha: true, reused, orderState: 'open', expired: false,
    chainId: body.network === 'ton' ? '1600' : '728126428', network: body.network, tokenSymbol: body.token,
    tokenIdentity: body.network === 'ton' ? '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe' : (body.token === 'TRX' ? 'native' : 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), tokenDecimals: 6, displayDecimals: body.token === 'TRX' ? 1 : 2,
    // Production (rozo-intents-api #854) sends the TON wallet form here and
    // the raw form in receivingAddressRaw; legacyTonShape sends raw here.
    receivingAddress: body.network === 'ton' ? (legacyTonShape ? TON_RAW : 'UQDA3cWalletFormNotRawxxxxxxxxxxxxxxxxxxxxxxxxx') : TRON_ADDR,
    ...(body.network === 'ton' && !legacyTonShape ? { receivingAddressRaw: TON_RAW } : {}),
    expectedAmount: opt.expectedAmount, expectedAmountAtomic: String(Math.round(Number(opt.expectedAmount) * 1e6)), paymentReference: opt.ref,
    grossUsd: opt.gross.toFixed(6), expiresAt: '2026-10-27T11:00:00.000Z', serverTime: firstQuote,
    notice: 'Alpha: payment is recorded and verified; top-up delivery is not automatic yet.',
  }), { status: 200 })
}

beforeEach(() => {
  resetTronTonAlphaCapabilityCache()
  ;(fakeAllocate as any).orders = new Map()
  ;(fakeAllocate as any).seq = 0
  up = { calls: [] }
  legacyTonShape = false
  intents = { lookups: [], creates: [] }
  quoteLinkId = PL
  quoteStatus = 200
  linkExpiresAt = null
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/functions/v1/tron-ton-alpha')) {
      const body = JSON.parse(init?.body ?? '{}')
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v)
      up.calls.push({ headers, body })
      const custom = up.reply?.(body)
      if (custom) return custom
      if (!body.network) return new Response(JSON.stringify({ error: 'unsupported_asset' }), { status: 400 })
      return fakeAllocate(body)
    }
    if (u.includes('/functions/v1/payment-api/payments/order/')) {
      const orderId = decodeURIComponent(u.split('/').pop()!)
      intents.lookups.push(orderId)
      const custom = intents.lookup?.(orderId)
      if (custom) return custom
      return new Response(JSON.stringify({ error: { code: 'paymentNotFound', message: 'Payment not found' } }), { status: 404 })
    }
    if (u === 'https://intentapiv4.rozo.ai/functions/v1/payment-api/' && init?.method === 'POST') {
      const body = JSON.parse(init.body)
      intents.creates.push(body)
      const custom = intents.create?.(body)
      if (custom) return custom
      return new Response(JSON.stringify({ id: 'b0000000-0000-4000-8000-000000000001', status: 'payment_unpaid' }), { status: 201 })
    }
    if (u.includes('/quote-invoice')) {
      if (quoteStatus !== 200) return new Response('payment session is not payable: PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED', { status: quoteStatus })
      return new Response(JSON.stringify({ invoice: { amount: '20.00' }, merchant: 'OpenRouter, Inc', linkId: quoteLinkId }), { status: 200 })
    }
    if (u.includes('payments.coinbase.com/next-api/')) {
      return linkExpiresAt
        ? new Response(JSON.stringify({ paymentSessionId: SESSION, status: 'PAYMENT_SESSION_STATUS_CREATED', amount: '20', asset: 'usdc', expiresAt: linkExpiresAt, customerDisplay: { merchantName: 'OpenRouter, Inc' }, target: { paymentTargetWallet: { address: '0x4C3f2E391498e2590bd327a7A1CAA68Dd42c4647', network: 'PAYMENT_TARGET_NETWORK_BASE' } } }), { status: 200 })
        : new Response('{}', { status: 404 })
    }
    throw new Error('unexpected fetch ' + u)
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

function optionReq(body: Record<string, unknown>) {
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/tron-ton-alpha/option', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify(body),
  })
}

describe('tron-ton-alpha capability', () => {
  it('is on only when the upstream probe answers unsupported_asset, and never allocates', async () => {
    const r = await handleTronTonAlphaCapability(new Request('https://x/cap'), makeEnv())
    const j: any = await r.json()
    expect(j.enabled).toBe(true)
    expect(j.options.map((o: any) => `${o.network}:${o.token}:${o.displayDecimals}`)).toEqual(['tron:USDT:2', 'tron:TRX:1', 'ton:USDT:2'])
    expect(up.calls).toHaveLength(1)
    expect(up.calls[0].body).toEqual({})
    expect(up.calls[0].headers['x-api-key']).toBe(KEY)
  })

  it.each([
    ['alpha_disabled', 403],
    ['app_not_allowed', 403],
    ['not_found', 404],
  ])('is off when upstream answers %s', async (error, status) => {
    up.reply = () => new Response(JSON.stringify({ error }), { status })
    expect(await probeTronTonAlpha(makeEnv())).toBe(false)
  })

  it('is off when upstream is unreachable, and caches the answer', async () => {
    up.reply = () => { throw new Error('down') }
    expect(await probeTronTonAlpha(makeEnv())).toBe(false)
    up.reply = undefined
    expect(await probeTronTonAlpha(makeEnv())).toBe(false)
    expect(up.calls).toHaveLength(1)
  })
})

describe('tron-ton-alpha option: one order per Coinbase invoice', () => {
  it('sends the invoice id as the order key on every coin and returns the same amount when switching back', async () => {
    const env = makeEnv()
    const a: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)).json()
    const b: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'ton', token: 'USDT' }), env)).json()
    const c: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'TRX' }), env)).json()
    const back: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)).json()

    expect(a.ok && b.ok && c.ok && back.ok).toBe(true)
    expect(back.reused).toBe(true)
    expect(back.expectedAmount).toBe(a.expectedAmount)
    expect(back.expiresAt).toBe(a.expiresAt)
    expect(b.paymentReference).toMatch(/^\d{6}$/)
    expect(a.paymentReference).toBeNull()

    const optionCalls = up.calls.filter((c) => c.body.network)
    expect(optionCalls).toHaveLength(4)
    for (const call of optionCalls) {
      expect(call.headers['x-api-key']).toBe(KEY)
      expect(call.body.merchantOrderId).toBe(PL)
      expect(call.body.providerInvoiceKey).toBe(PL)
      expect(call.body.baseServiceUsd).toBe(20)
      expect(call.body.existingAppFeeUsd).toBe(0.2)
      expect(call.body.destination).toEqual(ALPHA_DESTINATION)
    }
  })

  it('ignores any order id the caller sends', async () => {
    await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT', merchantOrderId: 'evil', orderId: 'evil', providerInvoiceKey: 'evil' }), makeEnv())
    const call = up.calls.find((c) => c.body.network)!
    expect(call.body.merchantOrderId).toBe(PL)
    expect(call.body.providerInvoiceKey).toBe(PL)
  })

  it('accepts v3 payment sessions (full URL) and keys them by the session id', async () => {
    quoteLinkId = SESSION
    const r: any = await (await handleTronTonAlphaOption(optionReq({ url: `https://payments.coinbase.com/payment-sessions/${SESSION}`, network: 'ton', token: 'USDT' }), makeEnv())).json()
    expect(r.ok).toBe(true)
    expect(r.linkId).toBe(SESSION)
    expect(up.calls.find((c) => c.body.network)!.body.merchantOrderId).toBe(SESSION)
  })

  it('builds byte-identical order facts for every coin', () => {
    const tron = buildAlphaUpstreamBody(PL, 20_000_000n, 200_000n, findAlphaOption('tron', 'USDT')!)
    const ton = buildAlphaUpstreamBody(PL, 20_000_000n, 200_000n, findAlphaOption('ton', 'USDT')!)
    const strip = ({ network: _n, token: _t, ...facts }: any) => facts
    expect(JSON.stringify(strip(tron))).toBe(JSON.stringify(strip(ton)))
  })

  it('returns fee lines that add up to the total, and the TON address in wallet form', async () => {
    const r: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'ton', token: 'USDT' }), makeEnv())).json()
    expect(r.fees).toEqual({ invoiceUsd: '20.00', serviceFeeUsd: '0.20', feeBps: 100, networkFeeUsd: '0.10', totalUsd: '20.30' })
    expect(r.receivingAddress).toBe(TON_RAW)
    expect(r.receivingAddressDisplay).toBe('UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI')
    expect(r.expectedAmountAtomic).toBe('20300000')
    expect(r.tokenIdentityDisplay).toBe('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs')
  })
})

describe('tron-ton-alpha option: rate limit', () => {
  it('status re-reads use their own counters and never spend the create-invoice budget (codex P2)', async () => {
    const env = makeEnv({ CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR: '2', CREATE_INVOICE_IP_LIMIT_PER_HOUR: '2' } as Partial<Env>)
    for (let i = 0; i < 4; i++) {
      expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)).status).toBe(200)
    }
    const ci = await checkCreateInvoiceGate(optionReq({}), env)
    expect(ci.ok).toBe(true)
  })
})

describe('tron-ton-alpha option: refusals', () => {
  it('rejects unknown coins and Stripe links before any upstream call', async () => {
    const bad = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDC' }), makeEnv())
    expect(bad.status).toBe(400)
    const stripe = await handleTronTonAlphaOption(optionReq({ url: 'https://crypto.stripe.com/pay/CDMTestBlob_ABC123xyz', network: 'tron', token: 'USDT' }), makeEnv())
    expect(stripe.status).toBe(400)
    expect(((await stripe.json()) as any).code).toBe('UNSUPPORTED_INVOICE')
    expect(up.calls).toHaveLength(0)
  })

  it('maps upstream refusals to codes and never echoes the link or logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const [error, status, code] of [
      ['alpha_disabled', 403, 'ALPHA_UNAVAILABLE'],
      ['order_conflict', 409, 'ALPHA_ORDER_CONFLICT'],
      ['order_expired', 410, 'ALPHA_ORDER_EXPIRED'],
      ['daily_budget_exhausted', 422, 'ALPHA_CAPACITY'],
      ['price_unavailable', 503, 'ALPHA_PRICE_UNAVAILABLE'],
      ['something_new', 500, 'ALPHA_UPSTREAM_FAILED'],
    ] as const) {
      up.reply = () => new Response(JSON.stringify({ error }), { status })
      const r = await handleTronTonAlphaOption(optionReq({ url: `https://payments.coinbase.com/payment-links/${PL}`, network: 'tron', token: 'USDT' }), makeEnv())
      const text = await r.text()
      expect(JSON.parse(text).code).toBe(code)
      expect(text).not.toContain(PL)
    }
    for (const args of warn.mock.calls) expect(JSON.stringify(args)).not.toContain(PL)
  })

  it('says already paid when the Coinbase invoice is captured', async () => {
    quoteStatus = 409
    const r = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), makeEnv())
    expect(r.status).toBe(409)
    expect(((await r.json()) as any).code).toBe('PAYMENT_ALREADY_PAID')
  })

  it('rejects a TRX amount that is not one decimal', async () => {
    up.reply = (body) => body.network ? new Response(JSON.stringify({ alpha: true, network: 'tron', tokenSymbol: 'TRX', receivingAddress: TRON_ADDR, expectedAmount: '61.50', expectedAmountAtomic: '61500000', paymentReference: null, expiresAt: '2026-10-27T11:00:00.000Z', grossUsd: '21.2' }), { status: 200 }) : null
    const r = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'TRX' }), makeEnv())
    expect(r.status).toBe(502)
  })

  it('never shows instructions on a link that dies before the order deadline, not even on a retry', async () => {
    quoteLinkId = SESSION
    linkExpiresAt = '2026-10-27T10:30:00.000Z' // before the fake's 11:00 deadline
    const first = await handleTronTonAlphaOption(optionReq({ payment_id: SESSION, network: 'tron', token: 'USDT' }), makeEnv())
    expect(first.status).toBe(422)
    expect(((await first.json()) as any).code).toBe('LINK_EXPIRES_TOO_SOON')
    const again = await handleTronTonAlphaOption(optionReq({ payment_id: SESSION, network: 'tron', token: 'USDT' }), makeEnv())
    expect(again.status).toBe(422) // reused upstream, still refused here
    expect(JSON.stringify(await again.json())).not.toContain('TQ6s')
    linkExpiresAt = '2026-10-27T12:00:00.000Z' // after the deadline: shown
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: SESSION, network: 'tron', token: 'USDT' }), makeEnv())).status).toBe(200)
  })
})

describe('tron-ton-alpha option: atomic amount', () => {
  it('refuses an answer whose atomic amount does not match the displayed one', async () => {
    const okRes = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), makeEnv())
    expect(okRes.status).toBe(200)
    up.reply = (body) => body.network ? new Response(JSON.stringify({ alpha: true, network: 'tron', tokenSymbol: 'USDT', receivingAddress: TRON_ADDR, receivingAddressDisplay: TRON_ADDR, expectedAmount: '21.20', expectedAmountAtomic: '21210000', paymentReference: null, expiresAt: '2026-10-27T11:00:00.000Z', grossUsd: '21.2' }), { status: 200 }) : null
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), makeEnv())).status).toBe(502)
  })
})

describe('tonRawToFriendly', () => {
  // Vectors from @ton/core 0.59.0 Address.toString({ bounceable, urlSafe: true }).
  it.each([
    ['0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8', 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI', 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'],
    ['-1:3333333333333333333333333333333333333333333333333333333333333333', 'Uf8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMxYA', 'Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF'],
    ['0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe', 'UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'],
  ])('%s', (raw, nonBounce, bounce) => {
    expect(tonRawToFriendly(raw)).toBe(nonBounce)
    expect(tonRawToFriendly(raw, true)).toBe(bounce)
  })
  it('rejects anything else', () => {
    expect(tonRawToFriendly('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N')).toBeNull()
    expect(tonRawToFriendly('0:zz')).toBeNull()
  })
})

describe('tron-ton-alpha option: the invoice business order (delivery gap, 2026-10-28)', () => {
  const ok = (r: Response) => r.json().then((j: any) => ({ status: r.status, j }))

  it('creates the merchant_openrouter order once, keyed by the invoice id, before showing instructions', async () => {
    const env = makeEnv()
    const a = await ok(await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env))
    expect(a.status).toBe(200)
    expect(intents.lookups).toEqual([PL])
    expect(intents.creates).toHaveLength(1)
    const body = intents.creates[0]
    expect(body.appId).toBe('merchant_openrouter')
    expect(body.orderId).toBe(PL)
    expect(body.type).toBe('exactIn')
    expect(body.source).toMatchObject({ chainId: '8453', tokenSymbol: 'USDC', amount: '20.2' })
    expect(body.destination).toMatchObject({ chainId: '8453', tokenSymbol: 'USDC', receiverAddress: ALPHA_DESTINATION.receiverAddress })
    // settle.ts compares metadata.original with the alpha base amount
    expect(body.metadata.original).toBe('20')
    expect(body.metadata.coinbasePaymentLinkId).toBe(PL)
    expect(body.metadata.testMode).toBeUndefined()
    // coin switches and status polls never create or look up again
    await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'ton', token: 'USDT' }), env)
    await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)
    expect(intents.lookups).toHaveLength(1)
    expect(intents.creates).toHaveLength(1)
  })

  it('creates an order the main checkout reuses (same price tuple as create-invoice)', () => {
    const pricing = resolveCheckoutPricing(20_000_000n, 'OpenRouter, Inc', '100')
    const body: any = buildAlphaBusinessOrderBody({ invoiceKey: PL, merchant: 'OpenRouter, Inc', pricing, test: false })
    const asRow = { source: { chainId: '8453', tokenSymbol: 'USDC', amount: body.source.amount }, metadata: body.metadata }
    expect(pendingPricingMatches(asRow, pricing)).toBe(true)
  })

  it('leaves an existing order alone', async () => {
    intents.lookup = () => new Response(JSON.stringify({ id: 'x', status: 'payment_unpaid' }), { status: 200 })
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), makeEnv())).status).toBe(200)
    expect(intents.creates).toHaveLength(0)
  })

  it('after an orderIdConflict, shows instructions only once the winning order is re-read (codex P1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    intents.create = () => new Response(JSON.stringify({ error: { code: 'orderIdConflict' } }), { status: 409 })
    // the concurrent create rolled back: still missing on the re-read
    const env = makeEnv()
    const lost = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)
    expect(lost.status).toBe(502)
    expect(await (env.MPP_STORE as any).get(alphaOrderMarkerKey(PL))).toBeNull()
    // the concurrent create committed: found on the re-read
    let n = 0
    intents.lookup = () => (n++ % 2 === 1 ? new Response(JSON.stringify({ id: 'x', status: 'payment_unpaid' }), { status: 200 }) : null)
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)).status).toBe(200)
    expect(await (env.MPP_STORE as any).get(alphaOrderMarkerKey(PL))).toBe('1')
  })

  it.each([
    ['lookup fails', () => { intents.lookup = () => new Response('boom', { status: 500 }) }],
    ['a non-intents 404', () => { intents.lookup = () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 }) }],
    ['create fails', () => { intents.create = () => new Response('{}', { status: 500 }) }],
  ])('fails closed when the %s: no address shown, and the next read retries', async (_n, arrange) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    arrange()
    const env = makeEnv()
    const r = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)
    expect(r.status).toBe(502)
    expect(await r.text()).not.toContain('TQ6s')
    intents.lookup = undefined
    intents.create = undefined
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)).status).toBe(200)
  })

  it('does not create an order when the alpha refuses or the link dies first', async () => {
    up.reply = (body) => body.network ? new Response(JSON.stringify({ error: 'alpha_disabled' }), { status: 403 }) : null
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), makeEnv())).status).toBe(404)
    up.reply = undefined
    quoteLinkId = SESSION
    linkExpiresAt = '2026-10-27T10:30:00.000Z'
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: SESSION, network: 'tron', token: 'USDT' }), makeEnv())).status).toBe(422)
    expect(intents.creates).toHaveLength(0)
  })
})

describe('tron-ton-alpha option: internal rozotest_ invoices', () => {
  it('accepts a signed test id: amount from the id, no Coinbase quote or expiry, test order marked', async () => {
    const id = await signTestPaymentId(TEST_SECRET, 100, 'abcdef12')
    const env = makeEnv()
    const r: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: id, network: 'ton', token: 'USDT' }), env)).json()
    expect(r.ok).toBe(true)
    expect(r.linkId).toBe(id)
    expect(r.linkExpiresAt).toBeNull()
    const call = up.calls.find((c) => c.body.network)!
    expect(call.body.merchantOrderId).toBe(id)
    expect(call.body.baseServiceUsd).toBe(1)
    expect(intents.creates[0].orderId).toBe(id)
    expect(intents.creates[0].metadata.testMode).toBe(true)
    const fetched = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(typeof c[0] === 'string' ? c[0] : c[0].url))
    expect(fetched.some((u: string) => u.includes('/quote-invoice') || u.includes('payments.coinbase.com'))).toBe(false)
  })

  it('rejects an unsigned or tampered test id before any upstream call', async () => {
    const id = await signTestPaymentId(TEST_SECRET, 100, 'abcdef12')
    const tampered = id.replace('rozotest_100_', 'rozotest_900_')
    for (const bad of [tampered, 'rozotest_100_abcdef12_0000000000000000']) {
      const r = await handleTronTonAlphaOption(optionReq({ payment_id: bad, network: 'tron', token: 'TRX' }), makeEnv())
      expect(r.status).toBe(400)
    }
    const noSecret = await handleTronTonAlphaOption(optionReq({ payment_id: id, network: 'tron', token: 'TRX' }), makeEnv({ ROZO_TEST_LINK_SECRET: undefined } as Partial<Env>))
    expect(noSecret.status).toBe(400)
    expect(up.calls).toHaveLength(0)
    expect(intents.creates).toHaveLength(0)
  })
})


describe('tron-ton-alpha option: TON address forms from upstream', () => {
  it('reads receivingAddressRaw (production shape) and still accepts a raw receivingAddress', async () => {
    for (const legacy of [false, true]) {
      legacyTonShape = legacy
      const r: any = await (await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'ton', token: 'USDT' }), makeEnv())).json()
      expect(r.ok).toBe(true)
      expect(r.receivingAddress).toBe(TON_RAW)
      expect(r.receivingAddressDisplay).toBe('UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI')
    }
  })
})

// Founder 2026-10-31: every checkout order keeps its original payment link in
// checkout_payment_links, alpha rails included (gap: TON order 998a11ea had none).
function makeLinksD1(opts: { fail?: () => boolean } = {}) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(new URL('../migrations/0005_checkout_payment_links.sql', import.meta.url), 'utf8'))
  const db: any = {
    prepare(q: string) {
      let args: any[] = []
      return {
        bind(...a: any[]) { args = a; return this },
        async run() {
          if (opts.fail?.()) throw new Error('D1_ERROR: network connection lost')
          sql.prepare(q).run(...args)
          return { success: true }
        },
        async first() { return (sql.prepare(q).get(...args) as any) ?? null },
      }
    },
  }
  const rows = () => sql.prepare('SELECT rozo_payment_id, provider, order_ref, url FROM checkout_payment_links').all() as any[]
  return { db, rows }
}

describe('tron-ton-alpha option: original payment link stored (2026-10-31)', () => {
  const CREATED_ID = 'b0000000-0000-4000-8000-000000000001'
  const EXISTING_ID = 'c0000000-0000-4000-8000-000000000002'

  it('a created order stores its rebuilt Coinbase link once, keyed by the Rozo payment id; never in the response', async () => {
    quoteLinkId = SESSION
    const { db, rows } = makeLinksD1()
    const env = makeEnv({ COUPON_SECURITY_DB: db } as Partial<Env>)
    const r = await handleTronTonAlphaOption(optionReq({ payment_id: SESSION, network: 'ton', token: 'USDT' }), env)
    expect(r.status).toBe(200)
    expect(await r.text()).not.toContain('payments.coinbase.com')
    expect(rows()).toEqual([{ rozo_payment_id: CREATED_ID, provider: 'coinbase', order_ref: SESSION, url: `https://payments.coinbase.com/payment-sessions/${SESSION}` }])
    // the intents order metadata never carries the url
    expect(JSON.stringify(intents.creates[0])).not.toContain('payments.coinbase.com')
    // coin switch: cached, no second write or lookup
    await handleTronTonAlphaOption(optionReq({ payment_id: SESSION, network: 'tron', token: 'USDT' }), env)
    expect(intents.lookups).toHaveLength(1)
    expect(rows()).toHaveLength(1)
  })

  it('an order that already exists (main checkout or pre-deploy alpha) gets its row from the lookup', async () => {
    intents.lookup = () => new Response(JSON.stringify({ id: EXISTING_ID, status: 'payment_unpaid' }), { status: 200 })
    const { db, rows } = makeLinksD1()
    const r = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), makeEnv({ COUPON_SECURITY_DB: db } as Partial<Env>))
    expect(r.status).toBe(200)
    expect(intents.creates).toHaveLength(0)
    expect(rows()).toEqual([{ rozo_payment_id: EXISTING_ID, provider: 'coinbase', order_ref: PL, url: `https://payments.coinbase.com/payment-links/${PL}` }])
  })

  it('a D1 failure never fails the option or logs the link; the next poll repairs the row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failing = true
    const { db, rows } = makeLinksD1({ fail: () => failing })
    const env = makeEnv({ COUPON_SECURITY_DB: db } as Partial<Env>)
    const first = await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)
    expect(first.status).toBe(200)
    expect(rows()).toHaveLength(0)
    expect(await (env.MPP_STORE as any).get(alphaOrderMarkerKey(PL))).toBeNull()
    for (const call of warn.mock.calls) expect(call.join(' ')).not.toContain(PL)
    failing = false
    intents.lookup = () => new Response(JSON.stringify({ id: CREATED_ID, status: 'payment_unpaid' }), { status: 200 })
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: PL, network: 'tron', token: 'USDT' }), env)).status).toBe(200)
    expect(intents.creates).toHaveLength(1)
    expect(rows()).toHaveLength(1)
    expect(await (env.MPP_STORE as any).get(alphaOrderMarkerKey(PL))).toBe('1')
  })

  it('a rozotest_ id has no Coinbase link: no row, order still cached', async () => {
    const id = await signTestPaymentId(TEST_SECRET, 100, 'abcdef12')
    const { db, rows } = makeLinksD1()
    const env = makeEnv({ COUPON_SECURITY_DB: db } as Partial<Env>)
    expect((await handleTronTonAlphaOption(optionReq({ payment_id: id, network: 'ton', token: 'USDT' }), env)).status).toBe(200)
    expect(rows()).toHaveLength(0)
    expect(await (env.MPP_STORE as any).get(alphaOrderMarkerKey(id))).toBe('1')
  })
})
