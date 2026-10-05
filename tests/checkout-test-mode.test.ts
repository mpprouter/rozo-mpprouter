/**
 * Checkout test mode (ainative todos/20261005-checkout-test-mode.zh.md, founder
 * decisions 2026-10-05): a rozotest_ order is paid with real money and the
 * Rozo bridge payout runs for real; ONLY the merchant invoice payment is
 * skipped and the order is marked test_settled.
 *
 * Covers:
 *  - fund guard: a test id can never reach callAgentApiPayInvoice (throws,
 *    no fetch), in any case / encoding / contract-variant form
 *  - webhook: payin + payout events for a test order never touch the funder
 *    balance RPC, agentapi or any alert sink; they print an order line
 *  - settlement: test_settled counts as settled (isTest), anything else not
 *  - feedback: is_test rows are stored, never sent to Feishu, and the submit
 *    response carries {order_id, status, text}
 *  - create-invoice: test orders keep the standard settlement destination and
 *    carry metadata.testMode
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  callAgentApiPayInvoice,
  handleRozoWebhook,
  resolveMerchantSettlement,
  type MerchantSettlement,
} from '../src/routes/webhook'
import {
  TestInvoiceFundGuardError,
  containsTestPaymentId,
  signTestPaymentId,
  TEST_MERCHANT_NAME,
} from '../src/routes/native-sources'
import {
  FEEDBACK_PATH,
  feedbackTokenFor,
  handleCheckoutFeedback,
  drainCheckoutFeedbackNotifications,
} from '../src/routes/checkout-feedback'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

const TEST_SECRET = 'test-link-secret'
const WEBHOOK_SECRET = 'test-webhook-secret'
const RPID = '11111111-2222-4333-8444-555555555555'

afterEach(() => vi.restoreAllMocks())

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signedWebhook(evt: unknown): Promise<Request> {
  const body = JSON.stringify(evt)
  const ts = Date.now().toString()
  const sig = await hmacHex(WEBHOOK_SECRET, `${ts}.${body}`)
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook', {
    method: 'POST',
    headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig}`, 'content-type': 'application/json' },
    body,
  })
}

function kv() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

function webhookEnv() {
  return {
    MPP_STORE: kv(),
    ATOMIC_STORE: makeAtomicStoreMock(),
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: 'admin',
    BASE_RPC_URL: 'https://rpc.test/primary',
    DINGTALK_ACCESS_TOKEN: 'dt-test-token',
    FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_ALERT_CHAT_ID: 'c',
    ROZO_INTENTS_API_KEY: 'k',
  } as any
}

describe('fund guard', () => {
  it('detects test ids in every disguise', () => {
    for (const id of ['rozotest_10_abcdef_0123456789abcdef', 'ROZOTEST_10_x', 'rozotest_10_abcdef_0123456789abcdef__contract', 'rozotest%5F10']) {
      expect(containsTestPaymentId(id)).toBe(true)
    }
    for (const id of ['pl_01abcdefghjkmnpqrstvwxyz0', 'paymentSession_03155b8e', null, undefined, '']) {
      expect(containsTestPaymentId(id as any)).toBe(false)
    }
  })

  it('callAgentApiPayInvoice refuses a test id before any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef12')
    for (const v of [id, id.toUpperCase(), `${id}__contract`]) {
      await expect(callAgentApiPayInvoice(webhookEnv(), v)).rejects.toBeInstanceOf(TestInvoiceFundGuardError)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('webhook: test order', () => {
  it('payin then payout marks test_settled with no funder, Coinbase or alert traffic', async () => {
    const env = webhookEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef12')
    const base = { data: { id: RPID, orderId: id, source: { amount: '0.10' }, destination: { amount: '0.10' } } }

    const r1 = await handleRozoWebhook(await signedWebhook({ ...base, event_id: 'e1', type: 'payment_payin_completed' }), env)
    expect(await r1.json()).toMatchObject({ ok: true, test_invoice: true, status: 'payin_seen' })
    const r2 = await handleRozoWebhook(await signedWebhook({ ...base, event_id: 'e2', type: 'payment_payout_completed' }), env)
    expect(await r2.json()).toMatchObject({ ok: true, test_invoice: true, status: 'test_settled' })

    expect(fetchSpy).not.toHaveBeenCalled() // no balance RPC, no agentapi, no DingTalk/Feishu
    const rec = JSON.parse(env.MPP_STORE._store.get(`invoice-fulfillment:${id}`))
    expect(rec.status).toBe('test_settled')
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(`[test-order] order_id=${id} rozo_payment_id=${RPID} event=payment_payout_completed status=test_settled`)
  })

  it('a contract-variant test order is handled the same way', async () => {
    const env = webhookEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef13')
    const r = await handleRozoWebhook(await signedWebhook({ event_id: 'e3', type: 'payment_payout_completed', data: { id: RPID, orderId: `${id}__contract` } }), env)
    expect(await r.json()).toMatchObject({ test_invoice: true, status: 'test_settled' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('webhook: test order delivery ack to Rozo', () => {
  const enabledEnv = () => ({ ...webhookEnv(), ROZO_DELIVERED_REPORT_ENABLED: 'true' })

  it('payout reports delivered once (so the Rozo reconciliation alert stays quiet); payin does not', async () => {
    const env = enabledEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef14')
    const base = { data: { id: RPID, orderId: id, source: { amount: '0.10' }, destination: { amount: '0.10' } } }

    await handleRozoWebhook(await signedWebhook({ ...base, event_id: 'd1', type: 'payment_payin_completed' }), env)
    expect(fetchSpy).not.toHaveBeenCalled()

    const r = await handleRozoWebhook(await signedWebhook({ ...base, event_id: 'd2', type: 'payment_payout_completed' }), env)
    expect(await r.json()).toMatchObject({ test_invoice: true, status: 'test_settled' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toMatch(new RegExp(`/payments/${RPID}/delivered$`))
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k')
    const rec = JSON.parse(env.MPP_STORE._store.get(`invoice-fulfillment:${id}`))
    expect(rec.status).toBe('test_settled')
    expect(rec.deliveredReported).toBe(true)

    // A replayed payout is terminal: no second report.
    await handleRozoWebhook(await signedWebhook({ ...base, event_id: 'd3', type: 'payment_payout_completed' }), env)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('a failed report never alerts; it only records the attempt', async () => {
    const env = enabledEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef15')
    await handleRozoWebhook(await signedWebhook({ event_id: 'd4', type: 'payment_payout_completed', data: { id: RPID, orderId: id } }), env)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // the delivered POST only; no DingTalk/Feishu
    const rec = JSON.parse(env.MPP_STORE._store.get(`invoice-fulfillment:${id}`))
    expect(rec.status).toBe('test_settled')
    expect(rec.deliveredReported).toBeFalsy()
    expect(rec.deliveredReportAttempts).toBe(1)
  })
})

describe('resolveMerchantSettlement: test order', () => {
  const rozo = (orderId: string) => new Response(JSON.stringify({ id: RPID, status: 'payment_payout_completed', orderId }), { status: 200 })
  function env(rec: unknown) {
    return { ROZO_INTENTS_API_KEY: 'k', MPP_STORE: { get: vi.fn().mockResolvedValue(rec ? JSON.stringify(rec) : null) } } as unknown as Env
  }

  it('test_settled counts as settled and is flagged isTest; no Coinbase call', async () => {
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef12')
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(id))
    expect(await resolveMerchantSettlement(env({ status: 'test_settled' }), RPID)).toEqual({
      found: true, settled: true, status: 'test:test_settled', merchant: TEST_MERCHANT_NAME, isTest: true,
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a test order before payout is not settled', async () => {
    const id = await signTestPaymentId(TEST_SECRET, 10, 'abcdef12')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(id))
    expect(await resolveMerchantSettlement(env({ status: 'payin_seen' }), RPID)).toMatchObject({ settled: false, status: 'test:payin_seen', isTest: true })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(id))
    expect(await resolveMerchantSettlement(env(null), RPID)).toMatchObject({ settled: false, status: 'test:missing' })
  })

  it('a router record marked test_settled never settles a real Coinbase order', async () => {
    const PL = 'pl_01abcdefghjkmnpqrstvwxyz0'
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(rozo(PL)).mockResolvedValueOnce(new Response('x', { status: 404 }))
    expect(await resolveMerchantSettlement(env({ status: 'test_settled' }), RPID)).toMatchObject({ settled: false, status: 'router:test_settled' })
  })
})

describe('checkout feedback: test order', () => {
  function makeD1() {
    const sql = new DatabaseSync(':memory:')
    sql.exec(readFileSync(new URL('../migrations/0003_checkout_feedback.sql', import.meta.url), 'utf8'))
    sql.exec(readFileSync(new URL('../migrations/0004_checkout_feedback_is_test.sql', import.meta.url), 'utf8'))
    return {
      sql,
      db: {
        prepare(q: string) {
          let args: any[] = []
          return {
            bind(...a: any[]) { args = a; return this },
            async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } } },
            async first() { return (sql.prepare(q).get(...args) as any) ?? null },
            async all() { return { results: sql.prepare(q).all(...args) } },
          }
        },
      },
    }
  }
  const SECRET = 'fb-secret'
  const DAY = Date.UTC(2026, 9, 5, 3, 0, 0)
  const TEST_SETTLED: MerchantSettlement = { found: true, settled: true, status: 'test:test_settled', merchant: TEST_MERCHANT_NAME, isTest: true }
  const REAL_SETTLED: MerchantSettlement = { found: true, settled: true, status: 'coinbase_v3:PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED', merchant: 'OpenRouter, Inc' }
  const env = (db: any) => ({ COUPON_SECURITY_DB: db, CHECKOUT_FEEDBACK_TOKEN_SECRET: SECRET, FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_ALERT_CHAT_ID: 'c' }) as any

  async function submit(e: any, rpid: string, settlement: MerchantSettlement, send: any, ctx?: any) {
    const body = { rozo_payment_id: rpid, feedback_token: await feedbackTokenFor(SECRET, rpid), text: 'Claude Max' }
    const res = await handleCheckoutFeedback(new Request('https://x' + FEEDBACK_PATH, { method: 'POST', body: JSON.stringify(body) }), e, ctx, {
      now: () => DAY, resolveSettlement: async () => settlement, send,
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('stores is_test=1, never sends Feishu, returns and logs order id + status', async () => {
    const { db, sql } = makeD1()
    const send = vi.fn().mockResolvedValue(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const waits: Promise<unknown>[] = []
    const r = await submit(env(db), RPID, TEST_SETTLED, send, { waitUntil: (p: Promise<unknown>) => waits.push(p) })
    expect(r.status).toBe(200)
    expect(r.body.test_notification).toMatchObject({ order_id: RPID, status: 'test:test_settled' })
    expect(r.body.test_notification.text).toContain('Claude Max')
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(`[test-order] checkout-feedback order_id=${RPID} status=test:test_settled`)
    await Promise.all(waits)
    expect((await drainCheckoutFeedbackNotifications(env(db), { now: () => DAY, send })).sent).toBe(0)
    expect(send).not.toHaveBeenCalled()
    const row = sql.prepare('SELECT is_test, notification_status FROM checkout_feedback WHERE payment_id = ?').get(RPID) as any
    expect(row).toEqual({ is_test: 1, notification_status: 'abandoned' })

    // Repeat submit: same row, still printed, still no Feishu.
    const again = await submit(env(db), RPID, TEST_SETTLED, send)
    expect(again.body).toMatchObject({ duplicate: true, test_notification: { order_id: RPID } })
    expect(send).not.toHaveBeenCalled()
  })

  it('drain skips a test row even if it was left pending', async () => {
    const { db, sql } = makeD1()
    sql.prepare(`INSERT INTO checkout_feedback (feedback_id, payment_id, text, created_at, settlement_status, settlement_checked_at, is_test)
      VALUES ('fb_t', ?, 'x', ?, 'test:test_settled', ?, 1)`).run(RPID, DAY, DAY)
    const send = vi.fn().mockResolvedValue(true)
    expect((await drainCheckoutFeedbackNotifications(env(db), { now: () => DAY, send })).sent).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('real orders still queue and send to Feishu with is_test=0', async () => {
    const { db, sql } = makeD1()
    const send = vi.fn().mockResolvedValue(true)
    const r = await submit(env(db), RPID, REAL_SETTLED, send)
    expect(r.body.test_notification).toBeUndefined()
    expect((await drainCheckoutFeedbackNotifications(env(db), { now: () => DAY, send })).sent).toBe(1)
    expect((sql.prepare('SELECT is_test FROM checkout_feedback').get() as any).is_test).toBe(0)
  })
})
