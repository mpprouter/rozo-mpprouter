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

const PL = 'pl_testTronTonAlpha01'
const SESSION = 'paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2'
const TRON_ADDR = 'TQ6sZ1jJcjC4Axq3dQ2h6YxSW5Znh5QGuf'
const TON_RAW = '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8'
const KEY = 'test-router-intents-key'

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: KEY,
    CHECKOUT_WEB_FEE_BPS: '100',
    ATOMIC_STORE: makeAtomicStoreMock(),
    ...extra,
  } as unknown as Env
}

interface FakeUpstream {
  calls: Array<{ headers: Record<string, string>; body: any }>
  reply?: (body: any) => Response | null
}

let up: FakeUpstream
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
    receivingAddress: body.network === 'ton' ? TON_RAW : TRON_ADDR,
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
