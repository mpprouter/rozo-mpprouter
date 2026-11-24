/**
 * Create-failure alert (routes/create-failure-alert.ts): system-side order
 * creation failures alert Rozo Ops once per (route, reason, chain, token) per
 * 30 minutes; user-caused refusals never alert; the customer response is never
 * changed or delayed.
 *
 * Regression for 2026-11-24: Lightning orders under $200 were refused at
 * creation for ~4.5h (payment-api 400 invalidRequest "payout address is fixed
 * server-side", relayed as 502 INTENTS_API_FAILED) with no alert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import {
  amountBand,
  classifyCreateFailure,
  createFailureAlertText,
  maskId,
  reportCreateFailure,
  scheduleCreateFailureAlert,
} from '../src/routes/create-failure-alert'
import { redactForAlert } from '../src/utils/alert-redaction'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const TODAY_UPSTREAM_400 = JSON.stringify({
  error: { code: 'invalidRequest', message: 'payout address is fixed server-side' },
})

function intentsFailed(upstreamStatus: number, hint: string) {
  return {
    error: `Rozo intents API returned ${upstreamStatus}.`,
    code: 'INTENTS_API_FAILED',
    stage: 'create_http_error',
    upstream_status: upstreamStatus,
    message: `Rozo intents API returned ${upstreamStatus}.`,
    hint,
    link_id_detected: 'paymentSession_abcdef1234567890',
  }
}

describe('classifyCreateFailure', () => {
  const cases: Array<[string, number, unknown, boolean, Record<string, unknown>?]> = [
    // System side: alert.
    ['today: intents 400 invalidRequest relayed as 502', 502, intentsFailed(400, TODAY_UPSTREAM_400), true],
    ['intents 5xx', 502, intentsFailed(500, '{"error":{"code":"databaseError","message":"x"}}'), true],
    ['intents unreachable / timeout', 502, { code: 'INTENTS_API_FAILED', stage: 'create_unreachable', upstream_status: null }, true],
    ['intents non-JSON', 502, { code: 'INTENTS_API_FAILED', stage: 'create_non_json', upstream_status: 200 }, true],
    ['order lookup failed', 502, { code: 'INTENTS_API_FAILED', stage: 'order_lookup', upstream_status: 503 }, true],
    ['intents destinationTierUnavailable', 502, intentsFailed(400, '{"error":{"code":"destinationTierUnavailable","message":"m"}}'), true],
    ['funder tier wallet not configured (503)', 503, { code: 'FUNDER_TIER_REFUSED', hint: 'tier_address_missing' }, true],
    ['tier receiver mismatch', 503, { code: 'FUNDER_TIER_RECEIVER_MISMATCH' }, true],
    ['server misconfigured', 500, { code: 'SERVER_MISCONFIGURED' }, true],
    ['quote upstream failed', 502, { code: 'QUOTE_FETCH_FAILED' }, true],
    ['BTC reserve failed', 503, { code: 'BTC_RESERVE_FAILED' }, true],
    ['ZEC monitor stale', 503, { code: 'ZEC_MONITOR_STALE' }, true],
    ['Stripe seed failed', 503, { ok: false, code: 'SEED_FAILED' }, true],
    ['bitrefill rejected invalidRequest', 400, { ok: false, error: 'INTENTS_API_REJECTED', upstream_code: 'invalidRequest', upstream_message: 'payout address is fixed server-side' }, true],
    ['unknown code (fail towards alerting)', 409, { code: 'SOMETHING_NEW' }, true],
    ['5xx without a code', 502, { ok: false, provider: 'stripe_crypto', error: 'Unparseable invoice amount.' }, true],
    ['Stripe codeless 502 relaying intents invalidRequest', 502, { ok: false, provider: 'stripe_crypto', error: 'Rozo intents API returned 400.', hint: TODAY_UPSTREAM_400 }, true],
    ['Stripe codeless 502 relaying intents amountTooLow', 502, { ok: false, provider: 'stripe_crypto', error: 'Rozo intents API returned 400.', hint: '{"error":{"code":"amountTooLow","message":"m"}}' }, false],
    ['Stripe codeless 502 relaying intents amountTooHigh', 502, { ok: false, provider: 'stripe_crypto', error: 'Rozo intents API returned 400.', hint: '{"error":{"code":"amountTooHigh","message":"m"}}' }, false],
    ['unknown upstream code in a relayed 4xx', 502, intentsFailed(422, '{"error":{"code":"brandNew"}}'), true],
    ['truncated upstream hint still read', 502, intentsFailed(400, '{"error":{"code":"invalidRequest","message":"payout address is fix'), true],
    ['alpha upstream failed', 502, { ok: false, code: 'ALPHA_UPSTREAM_FAILED' }, true, { detail: 'business_order_funder_tier' }],
    ['alpha budget never configured', 503, { ok: false, code: 'ALPHA_CAPACITY' }, true, { detail: 'option_503_increment_budget_unset' }],
    ['alpha price unavailable', 503, { ok: false, code: 'ALPHA_PRICE_UNAVAILABLE' }, true],
    // User side or deliberate state: no alert.
    ['expired link', 409, { code: 'LINK_USED_OR_EXPIRED' }, false],
    ['already paid', 409, { code: 'PAYMENT_ALREADY_PAID' }, false],
    ['over the order cap (tier 400)', 400, { code: 'FUNDER_TIER_REFUSED', hint: 'over_order_cap' }, false],
    ['ZEC over cap', 400, { code: 'EXCEEDS_LIMIT' }, false],
    ['BTC below minimum', 400, { code: 'BTC_AMOUNT_TOO_LOW' }, false],
    ['intents amountTooLow', 502, intentsFailed(400, '{"error":{"code":"amountTooLow","message":"below minimum"}}'), false],
    ['bitrefill amount out of range', 400, { ok: false, error: 'AMOUNT_OUT_OF_RANGE' }, false],
    ['bitrefill rejected invalidAmount', 400, { ok: false, error: 'INTENTS_API_REJECTED', upstream_code: 'invalidAmount' }, false],
    ['unsupported coin', 400, { code: 'UNSUPPORTED_SOURCE' }, false],
    ['router rate limit', 429, { code: 'RATE_LIMITED' }, false],
    ['relayed upstream rate limit', 429, { error: { code: 'rate_limited' } }, false],
    ['blocked address', 400, { ok: false, error: 'BLOCKED_ADDRESS' }, false],
    ['reused source mismatch', 409, { code: 'REUSED_SOURCE_MISMATCH' }, false],
    ['unsupported merchant link', 422, { code: 'LINK_NOT_PAYABLE' }, false],
    ['link not found', 404, { code: 'LINK_NOT_FOUND' }, false],
    ['order already active (nested code)', 409, { ok: false, error: { code: 'ORDER_ALREADY_ACTIVE', message: 'm' } }, false],
    ['intake paused by operator', 503, { code: 'CHECKOUT_INTAKE_PAUSED' }, false],
    ['global breaker (alerts itself)', 503, { code: 'SERVICE_UNAVAILABLE' }, false],
    ['ZEC switched off', 403, { code: 'ZEC_NOT_ENABLED' }, false],
    ['alpha daily budget full', 503, { ok: false, code: 'ALPHA_CAPACITY' }, false, { detail: 'option_503_daily_budget_exhausted' }],
    ['alpha amount too high', 422, { ok: false, code: 'ALPHA_AMOUNT_TOO_HIGH' }, false],
    ['wrong method, no code', 405, { error: 'Method not allowed' }, false],
    ['ineligible Stripe invoice, no code', 422, { ok: false, provider: 'stripe_crypto', error: 'not payable' }, false],
    ['success', 200, { ok: true }, false],
  ]
  for (const [name, status, body, alert, note] of cases) {
    it(`${alert ? 'alerts' : 'does not alert'}: ${name}`, () => {
      expect(classifyCreateFailure(status, body, note ?? {}).alert).toBe(alert)
    })
  }

  it('names the upstream status and code for today\'s incident', () => {
    const v = classifyCreateFailure(502, intentsFailed(400, TODAY_UPSTREAM_400))
    expect(v.reason).toBe('INTENTS_API_FAILED:create_http_error:400:invalidRequest')
    expect(v.upstreamCode).toBe('invalidRequest')
  })
})

describe('only listed values are shown or keyed', () => {
  it('an unknown upstream string (could be a coupon code) is shown as otherUpstreamCode', () => {
    const v = classifyCreateFailure(502, intentsFailed(400, '{"error":"ABCD1234"}'))
    expect(v.alert).toBe(true)
    expect(v.upstreamCode).toBe('otherUpstreamCode')
    expect(v.reason).not.toContain('ABCD1234')
    const text = createFailureAlertText('create-invoice', 502, v, {}, null)
    expect(text).not.toContain('ABCD1234')
  })

  it('an unknown router code alerts as OTHER_CODE', () => {
    const v = classifyCreateFailure(409, { code: 'WXYZ9876' })
    expect(v.alert).toBe(true)
    expect(v.reason).toBe('OTHER_CODE')
  })

  it('an unlisted alpha detail is shown as other_detail', () => {
    const v = classifyCreateFailure(502, { code: 'ALPHA_UPSTREAM_FAILED' }, { detail: 'option_502_COUPON42' })
    expect(v.reason).toBe('ALPHA_UPSTREAM_FAILED:other_detail')
  })
})

describe('alert text', () => {
  it('carries route, chain, token, band, statuses and a masked id; no URL or address', () => {
    const v = classifyCreateFailure(502, intentsFailed(400, JSON.stringify({
      error: { code: 'invalidRequest', message: 'coupon ABCD1234 to TTestOnlyFakeTronAddr000000000000 via https://pay.example/secret refused' },
    })))
    const text = redactForAlert(createFailureAlertText(
      'create-invoice', 502, v,
      { chainId: 'lightning', tokenSymbol: 'BTC', invoiceAtomic: 125_000_000n, provider: 'coinbase' },
      'paymentSession_abcdef1234567890',
      new Date('2026-11-24T10:00:00Z'),
    ))
    expect(text.split('\n')[0]).toBe('[MPP Router] 🚨 Order creation failing: create-invoice lightning/BTC (INTENTS_API_FAILED:create_http_error:400:invalidRequest)')
    expect(text).toContain('amount band $50 to $200')
    expect(text).toContain('Customer got HTTP 502')
    expect(text).toContain('Upstream: HTTP 400, code invalidRequest')
    expect(text).toContain('Invoice: paymentS...7890')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('abcdef1234567890')
    // No upstream free text at all: no coupon code, no TRON address.
    expect(text).not.toContain('ABCD1234')
    expect(text).not.toContain('TTestOnlyFake')
  })

  it('amount bands and id masking', () => {
    expect(amountBand(undefined)).toBe('unknown')
    expect(amountBand(10_000_000n)).toBe('under $50')
    expect(amountBand(199_990_000n)).toBe('$50 to $200')
    expect(amountBand(200_000_000n)).toBe('$200 to $1,000')
    expect(amountBand(9_000_000_000n)).toBe('$5,000 or more')
    expect(maskId('https://payments.coinbase.com/x')).toBe('none')
    expect(maskId(null)).toBe('none')
  })
})

// ── End to end through handleCreateInvoice ───────────────────────────────────

const LARK_ENV = {
  LARK_APP_ID: 'cli_test',
  LARK_APP_SECRET: 'lark-secret',
  LARK_OPS_CHAT_ID: 'oc_ops',
  LARK_FOUNDER_CHAT_ID: 'oc_founder',
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
    ...LARK_ENV,
    ...extra,
  } as unknown as Env
}

let larkMessages: Array<{ chat: string; text: string }>
let larkFails: boolean
let createResponse: () => Response

beforeEach(() => {
  larkMessages = []
  larkFails = false
  createResponse = () => new Response(TODAY_UPSTREAM_400, { status: 400 })
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/tenant_access_token/')) {
      if (larkFails) throw new Error('lark down')
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't' }), { status: 200 })
    }
    if (u.includes('/im/v1/messages')) {
      const body = JSON.parse(init.body)
      larkMessages.push({ chat: body.receive_id, text: JSON.parse(body.content).text })
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({ invoice: { amount: '25.00' }, merchant: 'OpenRouter, Inc', linkId: 'paymentSession_cfa_test_0001' }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    if (u.includes('/payment-api') && init?.method === 'POST') return createResponse()
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

function createReq(source: unknown) {
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ payment_id: 'paymentSession_cfa_test_0001', source }),
  })
}

function makeCtx() {
  const pending: Promise<unknown>[] = []
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), pending, drain: () => Promise.all(pending) }
}

const LIGHTNING = { chainId: 'lightning', tokenSymbol: 'BTC' }

describe('create-invoice end to end', () => {
  it('today\'s incident: one ops alert, response unchanged, sent after the response via waitUntil', async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    const res = await handleCreateInvoice(createReq(LIGHTNING), env, ctx as any)
    // The alert runs in waitUntil: nothing was sent when the response returned.
    expect(ctx.pending.length).toBe(1)
    expect(larkMessages.length).toBe(0)
    expect(res.status).toBe(502)
    const body: any = await res.json()
    expect(body.code).toBe('INTENTS_API_FAILED')
    expect(body.upstream_status).toBe(400)
    await ctx.drain()
    expect(larkMessages.length).toBe(1)
    expect(larkMessages[0].chat).toBe('oc_ops')
    expect(larkMessages[0].text).toContain('Order creation failing: create-invoice lightning/BTC')
    expect(larkMessages[0].text).toContain('amount band under $50')
    expect(larkMessages[0].text).toContain('Upstream: HTTP 400, code invalidRequest')
    // Upstream free text never reaches the alert.
    expect(larkMessages[0].text).not.toContain('payout address is fixed')
  })

  it('dedupes per reason, chain and token within 30 minutes', async () => {
    const env = makeEnv()
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx()
      await handleCreateInvoice(createReq(LIGHTNING), env, ctx as any)
      await ctx.drain()
    }
    expect(larkMessages.length).toBe(1)
    // Another chain on the same reason is its own path.
    const ctx = makeCtx()
    await handleCreateInvoice(createReq({ chainId: '8453', tokenSymbol: 'USDC' }), env, ctx as any)
    await ctx.drain()
    expect(larkMessages.length).toBe(2)
    expect(larkMessages[1].text).toContain('8453/USDC')
  })

  it('re-alerts after the window', async () => {
    const env = makeEnv()
    const t0 = Date.parse('2026-11-24T10:00:00Z')
    const res = () => new Response(JSON.stringify(intentsFailed(400, TODAY_UPSTREAM_400)), { status: 502 })
    const note = { chainId: 'lightning', tokenSymbol: 'BTC' }
    await reportCreateFailure(env, 'create-invoice', res(), note, t0)
    await reportCreateFailure(env, 'create-invoice', res(), note, t0 + 29 * 60_000)
    expect(larkMessages.length).toBe(1)
    await reportCreateFailure(env, 'create-invoice', res(), note, t0 + 31 * 60_000)
    expect(larkMessages.length).toBe(2)
  })

  it('a failed delivery shortens the window to 10 minutes', async () => {
    const env = makeEnv()
    const t0 = Date.parse('2026-11-24T10:00:00Z')
    const res = () => new Response(JSON.stringify(intentsFailed(400, TODAY_UPSTREAM_400)), { status: 502 })
    const note = { chainId: 'lightning', tokenSymbol: 'BTC' }
    larkFails = true
    await reportCreateFailure(env, 'create-invoice', res(), note, t0)
    larkFails = false
    await reportCreateFailure(env, 'create-invoice', res(), note, t0 + 5 * 60_000)
    expect(larkMessages.length).toBe(0)
    await reportCreateFailure(env, 'create-invoice', res(), note, t0 + 11 * 60_000)
    expect(larkMessages.length).toBe(1)
  })

  it('user-caused refusal (link used) never alerts', async () => {
    createResponse = () => new Response('{"error":{"code":"orderIdConflict"}}', { status: 409 })
    const env = makeEnv()
    const ctx = makeCtx()
    const res = await handleCreateInvoice(createReq(LIGHTNING), env, ctx as any)
    expect(res.status).toBe(409)
    await ctx.drain()
    expect(larkMessages.length).toBe(0)
  })

  it('a success schedules nothing', async () => {
    createResponse = () => new Response(
      JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z', source: { chainId: '8453', tokenSymbol: 'USDC' } }),
      { status: 200 },
    )
    const env = makeEnv()
    const ctx = makeCtx()
    const res = await handleCreateInvoice(createReq({ chainId: '8453', tokenSymbol: 'USDC' }), env, ctx as any)
    expect(res.status).toBe(200)
    await ctx.drain()
    expect(larkMessages.length).toBe(0)
  })

  it('an alert failure (store and Lark down) never breaks the create response', async () => {
    // Only the alert's own DO instance is down; the create path's DOs work.
    const real = makeAtomicStoreMock()
    const env = makeEnv({
      ATOMIC_STORE: {
        idFromName: (name: string) => {
          if (name === 'create-failure-alerts') throw new Error('do down')
          return real.idFromName(name)
        },
        get: (id: unknown) => real.get(id as any),
      },
    })
    larkFails = true
    const ctx = makeCtx()
    const res = await handleCreateInvoice(createReq(LIGHTNING), env, ctx as any)
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).code).toBe('INTENTS_API_FAILED')
    await expect(ctx.drain()).resolves.toBeDefined()
    expect(larkMessages.length).toBe(0)
  })

  it('no alert sink configured: nothing scheduled', () => {
    const env = makeEnv({ LARK_APP_ID: undefined, LARK_OPS_CHAT_ID: undefined })
    const ctx = makeCtx()
    scheduleCreateFailureAlert(env, ctx, 'create-invoice', new Response('{"code":"SERVER_MISCONFIGURED"}', { status: 500 }), {})
    expect(ctx.pending.length).toBe(0)
  })

  it('the customer still reads the full body after scheduling', async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    const res = new Response(JSON.stringify({ code: 'SERVER_MISCONFIGURED', message: 'm' }), { status: 500 })
    scheduleCreateFailureAlert(env, ctx, 'tron-ton-alpha', res, { chainId: 'tron', tokenSymbol: 'USDT' })
    expect(await res.json()).toEqual({ code: 'SERVER_MISCONFIGURED', message: 'm' })
    await ctx.drain()
    expect(larkMessages.length).toBe(1)
    expect(larkMessages[0].text).toContain('tron-ton-alpha tron/USDT')
  })
})
