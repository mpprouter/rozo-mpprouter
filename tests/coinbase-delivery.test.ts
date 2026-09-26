/**
 * Coinbase fulfillment: capture-truth, execution gate, cron sweep, delivery
 * report, guarded saves, and removal of the shared reservation counter.
 *
 * Plan: ainative todos/20260926-openrouter-delivery-status.md (M1–M5).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  handleRozoWebhook,
  payInvoiceCaptured,
  saveRecordGuarded,
  type FulfillmentRecord,
} from '../src/routes/webhook'
import { sweepCoinbaseFulfillments } from '../src/routes/coinbase-sweep'
import { acquireCoinbaseExecGate, readCoinbaseExecGate } from '../src/routes/coinbase-exec-gate'
import { handleCoinbaseExecGateClear, coinbaseExecGateClearLogKey } from '../src/routes/coinbase-exec-gate-admin'
import { casRead } from '../src/routes/stripe-atomic'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

// ── helpers (same shape as webhook-alerts.test.ts) ─────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret'
const PL = 'pl_testDelivery1'
const ROZO_ID = '11111111-2222-3333-4444-555555555555'
const KEY = `invoice-fulfillment:${PL}`

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signedWebhookRequest(evt: unknown): Promise<Request> {
  const body = JSON.stringify(evt)
  const ts = Date.now().toString()
  const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${ts}.${body}`)
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook', {
    method: 'POST',
    headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig}`, 'content-type': 'application/json' },
    body,
  })
}

function makeKvMock() {
  const store = new Map<string, string>()
  const touched: string[] = []
  return {
    _store: store,
    _touched: touched,
    get: async (k: string) => {
      touched.push(k)
      return store.get(k) ?? null
    },
    put: async (k: string, v: string, _opts?: unknown) => {
      touched.push(k)
      store.set(k, v)
    },
    delete: async (k: string) => {
      touched.push(k)
      store.delete(k)
    },
    list: async (opts: { prefix?: string; cursor?: string }) => {
      const keys = [...store.keys()]
        .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
        .sort()
        .map((name) => ({ name }))
      return { keys, list_complete: true, cursor: undefined }
    },
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKvMock()
  const env = {
    MPP_STORE: kv,
    ATOMIC_STORE: makeAtomicStoreMock(),
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    BASE_RPC_URL: 'https://rpc.test/primary',
    DINGTALK_ACCESS_TOKEN: 'dt-test-token',
    ROZO_INTENTS_API_KEY: 'test-rozo-key',
    ROZO_DELIVERED_REPORT_ENABLED: 'true',
    ...overrides,
  }
  return { env: env as unknown as Env, kv }
}

const CAPTURED_BODY = {
  success: true,
  mode: 'admin',
  coinbase: {
    success: true,
    protocolVersion: 'v3',
    session: { id: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' },
    captured: true,
  },
}
// Real live shape seen 2026-09-26: HTTP 200 but not captured.
const PENDING_BODY = {
  success: false,
  mode: 'admin',
  coinbase: {
    success: false,
    protocolVersion: 'v3',
    session: { id: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_PENDING' },
    captured: false,
  },
}

interface Upstream {
  balanceAtomic: bigint
  payStatus: number
  payBody: unknown
  // Held pay-invoice responses (lets two events overlap inside `paying`).
  payGate?: Promise<void>
  // Coinbase public read: v1 link object, or null → HTTP 500.
  coinbase: Record<string, unknown> | null
  rozo: Record<string, unknown> | null
  deliveredStatus: number
}

function stubFetch(cfg: Partial<Upstream> = {}) {
  const up: Upstream = {
    balanceAtomic: 10_000_000n,
    payStatus: 200,
    payBody: CAPTURED_BODY,
    coinbase: { id: PL, status: 'ACTIVE', usageCount: 0, maxUsage: 1, preApprovalExpiry: String(Math.floor(Date.now() / 1000) + 86400) },
    rozo: null,
    deliveredStatus: 200,
    ...cfg,
  }
  const calls = { pay: 0, coinbase: 0, rozoGet: 0, delivered: [] as Array<{ url: string; body: any; key: string | null }>, dingtalk: [] as string[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        calls.dingtalk.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.includes('agentapi.rozo.ai/pay-invoice')) {
        calls.pay++
        if (up.payGate) await up.payGate
        return new Response(JSON.stringify(up.payBody), { status: up.payStatus })
      }
      if (url.includes('payments.coinbase.com/next-api/')) {
        calls.coinbase++
        if (!up.coinbase) return new Response('down', { status: 500 })
        return Response.json(up.coinbase)
      }
      if (url.includes('intentapiv4.rozo.ai') && url.endsWith('/delivered')) {
        const headers = new Headers(init?.headers)
        calls.delivered.push({ url, body: JSON.parse(String(init?.body)), key: headers.get('X-API-Key') })
        return new Response('{}', { status: up.deliveredStatus })
      }
      if (url.includes('intentapiv4.rozo.ai')) {
        calls.rozoGet++
        if (!up.rozo) return new Response('nf', { status: 404 })
        return Response.json(up.rozo)
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + up.balanceAtomic.toString(16) })
    }),
  )
  return { up, calls }
}

let seq = 0
function payoutEvent(type = 'payment_payout_completed') {
  return {
    event_id: `evt-delivery-${++seq}`,
    type,
    timestamp: new Date().toISOString(),
    data: {
      id: ROZO_ID,
      orderId: PL,
      status: 'payment_completed',
      source: { amount: '1.00', chainId: '8453', txHash: null },
      destination: { amount: '1.00', chainId: '8453', txHash: '0xdeadbeef' },
    },
  }
}

function readRec(kv: ReturnType<typeof makeKvMock>, key = KEY): FulfillmentRecord {
  return JSON.parse(kv._store.get(key)!)
}

function seedRec(kv: ReturnType<typeof makeKvMock>, rec: Partial<FulfillmentRecord>, plId = PL) {
  const full: FulfillmentRecord = {
    status: 'payin_seen',
    pl_id: plId,
    rozoPaymentId: ROZO_ID,
    invoiceAmountAtomic: '1000000',
    funderBalanceAtomic: null,
    paidAt: null,
    payingAt: null,
    coinbaseResult: null,
    failureReason: null,
    webhookEventIds: [],
    events: [],
    ...rec,
  }
  kv._store.set(`invoice-fulfillment:${plId}`, JSON.stringify(full))
}

const MIN = 60 * 1000
const ago = (m: number) => new Date(Date.now() - m * MIN).toISOString()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── M2: capture truth ───────────────────────────────────────────────────────

describe('payInvoiceCaptured', () => {
  it('reads captured / session status / v1 usage, not the HTTP status', () => {
    expect(payInvoiceCaptured(CAPTURED_BODY)).toBe(true)
    expect(payInvoiceCaptured(PENDING_BODY)).toBe(false)
    expect(payInvoiceCaptured({ coinbase: { session: { status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' } } })).toBe(true)
    expect(payInvoiceCaptured({ coinbase: { protocolVersion: 'v1', link: { usageCount: 1, maxUsage: 1 }, captured: false } })).toBe(true)
    expect(payInvoiceCaptured({ ok: true })).toBe(false)
    expect(payInvoiceCaptured(null)).toBe(false)
  })
})

describe('webhook Coinbase settlement (M1/M2/M5)', () => {
  it('2xx + captured → paid, payingAt set, delivery reported to Rozo on 200', async () => {
    const { calls } = stubFetch()
    const { env, kv } = makeEnv()
    const waitUntil = vi.fn()
    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env, { waitUntil } as any)
    expect(res.status).toBe(200)
    // M1: the settlement promise is registered with waitUntil.
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.payingAt).toBeTruthy()
    expect(calls.pay).toBe(1)
    expect(calls.delivered).toHaveLength(1)
    expect(calls.delivered[0].url).toBe(
      `https://intentapiv4.rozo.ai/functions/v1/payment-api/payments/${ROZO_ID}/delivered`,
    )
    expect(calls.delivered[0].body).toEqual({ reference: PL })
    expect(calls.delivered[0].key).toBe('test-rozo-key')
    expect(rec.deliveredReported).toBe(true)
  })

  it('2xx + CAPTURE_PENDING → capture_pending; a later payout event never calls pay-invoice again', async () => {
    const { calls } = stubFetch({ payBody: PENDING_BODY })
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(readRec(kv).status).toBe('capture_pending')
    expect(calls.pay).toBe(1)
    expect(calls.delivered).toHaveLength(0)

    const res2 = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(((await res2.json()) as any).alreadyTerminal).toBe('capture_pending')
    expect(calls.pay).toBe(1)
  })

  it('exec gate: two concurrent payout events for the same link → pay-invoice called once', async () => {
    let release!: () => void
    const payGate = new Promise<void>((r) => (release = r))
    const { calls } = stubFetch({ payGate })
    const { env, kv } = makeEnv()
    // Model KV eventual consistency: until pay-invoice answers, reads of the
    // record see nothing, so neither request sees the other's `paying`.
    let stale = true
    const realGet = kv.get
    kv.get = async (k: string) => (stale && k === KEY ? null : realGet(k))
    const p1 = handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    const p2 = handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    // Let both requests run up to (and one of them into) pay-invoice.
    await new Promise((r) => setTimeout(r, 20))
    stale = false
    release()
    const bodies = (await Promise.all([p1, p2])).map((r) => r.json())
    const out = (await Promise.all(bodies)) as any[]
    expect(calls.pay).toBe(1)
    // Both events read the record before either wrote `paying` (KV is not
    // atomic), so the loser is stopped by the exec gate, not the KV status.
    expect(out.filter((b) => b.exec_gate_held)).toHaveLength(1)
    expect(readRec(kv).status).toBe('paid')
  })

  it('exec gate: a later event after a lost KV update (record back to payin_seen) does not pay again', async () => {
    const { calls } = stubFetch()
    const { env, kv } = makeEnv()
    const first = payoutEvent()
    await handleRozoWebhook(await signedWebhookRequest(first), env)
    expect(calls.pay).toBe(1)
    // Simulate KV non-atomicity: the record is rolled back by a stale writer.
    seedRec(kv, { status: 'payin_seen' })
    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(((await res.json()) as any).exec_gate_held).toBe(true)
    expect(calls.pay).toBe(1)
    expect(readRec(kv).events.some((e) => e.kind === 'exec_gate_held')).toBe(true)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toBe(first.event_id)
  })

  it('balance check uses the real funder balance only (no reservation counter)', async () => {
    const { calls } = stubFetch({ balanceAtomic: 1_000_000n })
    const { env, kv } = makeEnv()
    // A stale value in the old counter key must not block the payment.
    kv._store.set('funder-reserved-atomic', '165980000')
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(calls.pay).toBe(1)
    expect(readRec(kv).status).toBe('paid')
  })
})

// ── saveRecordGuarded ───────────────────────────────────────────────────────

describe('saveRecordGuarded', () => {
  it('never downgrades paid; merges events; deliveredReported only goes false → true', async () => {
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'paid', paidAt: ago(1), deliveredReported: true, events: [{ kind: 'a', at: ago(2) }] })
    const stale = { ...readRec(kv), status: 'paying' as const, deliveredReported: false, events: [{ kind: 'b', at: ago(1) }] }
    const out = await saveRecordGuarded(env, PL, stale)
    expect(out.status).toBe('paid')
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.deliveredReported).toBe(true)
    expect(rec.events.map((e) => e.kind)).toEqual(['a', 'b'])
  })

  it('never lowers the status rank between terminal states', async () => {
    const { env, kv } = makeEnv()
    // Stale capture_pending (rank 2) over manual_review (rank 3) → manual_review kept.
    seedRec(kv, { status: 'manual_review', alertedManualReview: true })
    await saveRecordGuarded(env, PL, { ...readRec(kv), status: 'capture_pending', alertedManualReview: false })
    expect(readRec(kv).status).toBe('manual_review')
    expect(readRec(kv).alertedManualReview).toBe(true)
    // Equal rank 3: failed_pay_invoice does not replace manual_review.
    await saveRecordGuarded(env, PL, { ...readRec(kv), status: 'failed_pay_invoice' })
    expect(readRec(kv).status).toBe('manual_review')
    // paid (rank 4) is never downgraded by anything.
    for (const st of ['manual_review', 'failed_pay_invoice', 'claimed_by_other_channel', 'capture_pending', 'paying', 'payin_seen'] as const) {
      seedRec(kv, { status: 'paid' })
      await saveRecordGuarded(env, PL, { ...readRec(kv), status: st })
      expect(readRec(kv).status).toBe('paid')
    }
    // Rank 0 transitions still work: payin_seen → failed_insufficient_balance.
    seedRec(kv, { status: 'payin_seen' })
    await saveRecordGuarded(env, PL, { ...readRec(kv), status: 'failed_insufficient_balance' })
    expect(readRec(kv).status).toBe('failed_insufficient_balance')
  })

  it('a terminal stored status wins over a non-terminal write, a terminal write goes through', async () => {
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'capture_pending' })
    await saveRecordGuarded(env, PL, { ...readRec(kv), status: 'payin_seen' })
    expect(readRec(kv).status).toBe('capture_pending')
    await saveRecordGuarded(env, PL, { ...readRec(kv), status: 'manual_review' })
    expect(readRec(kv).status).toBe('manual_review')
  })
})

// ── M3: cron sweep ──────────────────────────────────────────────────────────

describe('sweepCoinbaseFulfillments', () => {
  it('paying > 10 min + Coinbase settled → paid, delivery reported, never calls pay-invoice', async () => {
    const { calls } = stubFetch({ coinbase: { id: PL, status: 'COMPLETED', usageCount: 1, maxUsage: 1 } })
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'paying', payingAt: ago(11) })
    await sweepCoinbaseFulfillments(env)
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.deliveredReported).toBe(true)
    expect(calls.pay).toBe(0)
  })

  it('paying < 10 min is left alone (no Coinbase read)', async () => {
    const { calls } = stubFetch()
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'paying', payingAt: ago(3) })
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).status).toBe('paying')
    expect(calls.coinbase).toBe(0)
    expect(calls.pay).toBe(0)
  })

  it('capture_pending still pending > 30 min → manual_review + exactly one NOT-delivered alert', async () => {
    const { calls } = stubFetch({
      coinbase: { paymentSessionId: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_PENDING', expiresAt: new Date(Date.now() + 86400_000).toISOString() },
    })
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'capture_pending', payingAt: ago(31) })
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).status).toBe('manual_review')
    expect(calls.dingtalk).toHaveLength(1)
    expect(calls.dingtalk[0]).toContain('NOT delivered')
    expect(calls.dingtalk[0]).not.toContain(ROZO_ID)
    await sweepCoinbaseFulfillments(env)
    expect(calls.dingtalk).toHaveLength(1)
    expect(calls.pay).toBe(0)
  })

  it('capture_pending with Coinbase failure status → manual_review immediately', async () => {
    stubFetch({ coinbase: { paymentSessionId: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_FAILED', expiresAt: new Date(Date.now() + 86400_000).toISOString() } })
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'capture_pending', payingAt: ago(2) })
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).status).toBe('manual_review')
  })

  it('Coinbase query failure → no state change, no alert until failing > 30 min', async () => {
    const { calls } = stubFetch({ coinbase: null })
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'capture_pending', payingAt: ago(40) })
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).status).toBe('capture_pending')
    expect(calls.dingtalk).toHaveLength(0)
    // Failing since 31 minutes ago → one alert, still no state change.
    seedRec(kv, { ...readRec(kv), coinbaseQueryFailingSince: ago(31) })
    await sweepCoinbaseFulfillments(env)
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).status).toBe('capture_pending')
    expect(calls.dingtalk).toHaveLength(1)
  })

  it('payin_seen + Rozo payout_completed + unsettled link → one alert, no pay-invoice call', async () => {
    const { calls } = stubFetch({
      rozo: { id: ROZO_ID, status: 'payment_payout_completed', destination: { confirmedAt: ago(15) } },
    })
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'payin_seen', events: [{ kind: 'payment_payin_completed', at: ago(20) }] })
    await sweepCoinbaseFulfillments(env)
    expect(calls.pay).toBe(0)
    expect(calls.dingtalk).toHaveLength(1)
    expect(calls.dingtalk[0]).toContain('NOT delivered')
    expect(readRec(kv).alertedStuck).toBe(true)
    expect(readRec(kv).status).toBe('payin_seen')
    await sweepCoinbaseFulfillments(env)
    expect(calls.dingtalk).toHaveLength(1)
    expect(calls.pay).toBe(0)
  })

  it('delivery is marked reported only on HTTP 200; alerts once after 5 failures', async () => {
    const { up, calls } = stubFetch({
      coinbase: { id: PL, status: 'COMPLETED', usageCount: 1, maxUsage: 1 },
      deliveredStatus: 409,
    })
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'paid', paidAt: ago(5) })
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).deliveredReported).toBeFalsy()
    expect(readRec(kv).deliveredReportAttempts).toBe(1)

    up.deliveredStatus = 200
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).deliveredReported).toBe(true)
    expect(calls.delivered).toHaveLength(2)

    // Give-up path: 5 failures → one alert, then no further attempts.
    seedRec(kv, { status: 'paid', paidAt: ago(5), deliveredReportAttempts: 4 }, 'pl_testDelivery2')
    up.deliveredStatus = 500
    await sweepCoinbaseFulfillments(env)
    await sweepCoinbaseFulfillments(env)
    const r2 = readRec(kv, 'invoice-fulfillment:pl_testDelivery2')
    expect(r2.deliveredReportAttempts).toBe(5)
    expect(calls.dingtalk).toHaveLength(1)
    expect(calls.pay).toBe(0)
  })

  it('delivery reporting is off unless ROZO_DELIVERED_REPORT_ENABLED=true (no POST, no attempts)', async () => {
    const { calls } = stubFetch({ coinbase: { id: PL, status: 'COMPLETED', usageCount: 1, maxUsage: 1 } })
    const { env, kv } = makeEnv({ ROZO_DELIVERED_REPORT_ENABLED: undefined })
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    await sweepCoinbaseFulfillments(env)
    expect(readRec(kv).status).toBe('paid')
    expect(calls.delivered).toHaveLength(0)
    expect(readRec(kv).deliveredReportAttempts ?? 0).toBe(0)
  })

  it('skips Stripe records', async () => {
    const { calls } = stubFetch()
    const { env, kv } = makeEnv()
    kv._store.set('invoice-fulfillment:v2:stripe_crypto:cpis_x', JSON.stringify({ status: 'paying' }))
    const out = await sweepCoinbaseFulfillments(env)
    expect(out.scanned).toBe(0)
    expect(calls.coinbase).toBe(0)
  })
})

// ── Admin exec-gate clear (manual re-pay escape hatch) ─────────────────────

describe('POST /admin/coinbase-exec-gate/clear', () => {
  const V3_CREATED = { paymentSessionId: PL, status: 'PAYMENT_SESSION_STATUS_CREATED', expiresAt: new Date(Date.now() + 86400_000).toISOString() }
  const clearReq = (body: Record<string, unknown>) =>
    new Request('https://router.test/admin/coinbase-exec-gate/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': 'test-admin-secret' },
      body: JSON.stringify({ plId: PL, evidence: 'verified on Coinbase: session still CREATED', clearedBy: 'ops-test', ...body }),
    })

  async function setup(recStatus: FulfillmentRecord['status'] | null, coinbase: Record<string, unknown> | null) {
    const { calls } = stubFetch({ coinbase })
    const { env, kv } = makeEnv()
    if (recStatus) seedRec(kv, { status: recStatus })
    expect((await acquireCoinbaseExecGate(env, PL, 'evt-1')).ok).toBe(true)
    return { env, kv, calls }
  }

  it('happy path: manual_review + Coinbase CREATED + matching holder → cleared and recorded', async () => {
    const { env, kv, calls } = await setup('manual_review', V3_CREATED)
    const res = await handleCoinbaseExecGateClear(clearReq({ expectedHolder: 'evt-1' }), env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).changed).toBe(true)
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    const log = JSON.parse((await casRead(env, coinbaseExecGateClearLogKey(PL))).value!)
    expect(log).toHaveLength(1)
    expect(log[0].clearedBy).toBe('ops-test')
    expect(readRec(kv).events.some((e) => e.kind === 'exec_gate_cleared_by_admin')).toBe(true)
    expect(readRec(kv).status).toBe('manual_review')
    expect(calls.pay).toBe(0)
  })

  it('happy path also for failed_pay_invoice with a v1 link usageCount < maxUsage', async () => {
    const { env } = await setup('failed_pay_invoice', { id: PL, status: 'ACTIVE', usageCount: 0, maxUsage: 1 })
    const res = await handleCoinbaseExecGateClear(clearReq({ expectedHolder: 'evt-1' }), env)
    expect(res.status).toBe(200)
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
  })

  for (const st of ['paying', 'capture_pending', 'paid', 'payin_seen', null] as const) {
    it(`refuses when the record is ${st ?? 'missing'} (pay may be in flight / settled)`, async () => {
      const { env, calls } = await setup(st, V3_CREATED)
      const res = await handleCoinbaseExecGateClear(clearReq({ expectedHolder: 'evt-1' }), env)
      expect(res.status).toBe(409)
      expect((await readCoinbaseExecGate(env, PL))?.holder).toBe('evt-1')
      expect(calls.coinbase).toBe(0)
    })
  }

  const notExplicitlyUnsettled: Array<[string, Record<string, unknown>]> = [
    ['v3 CAPTURE_PENDING', { paymentSessionId: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_PENDING' }],
    ['v3 CAPTURE_SUCCEEDED', { paymentSessionId: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' }],
    ['v3 empty status', { paymentSessionId: PL }],
    ['v1 settled', { id: PL, usageCount: 1, maxUsage: 1 }],
    ['v1 non-numeric usage', { id: PL, usageCount: '0', maxUsage: '1' }],
    ['unrecognized object', { foo: 'bar' }],
  ]
  for (const [label, cb] of notExplicitlyUnsettled) {
    it(`refuses (409) when Coinbase is not explicitly unsettled: ${label}`, async () => {
      const { env } = await setup('manual_review', cb)
      const res = await handleCoinbaseExecGateClear(clearReq({ expectedHolder: 'evt-1' }), env)
      expect(res.status).toBe(409)
      expect((await readCoinbaseExecGate(env, PL))?.holder).toBe('evt-1')
    })
  }

  it('refuses (502) when Coinbase cannot be read', async () => {
    const { env } = await setup('manual_review', null)
    const res = await handleCoinbaseExecGateClear(clearReq({ expectedHolder: 'evt-1' }), env)
    expect(res.status).toBe(502)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toBe('evt-1')
  })

  it('requires expectedHolder (400) and refuses a mismatched holder (409)', async () => {
    const { env } = await setup('manual_review', V3_CREATED)
    expect((await handleCoinbaseExecGateClear(clearReq({}), env)).status).toBe(400)
    expect((await handleCoinbaseExecGateClear(clearReq({ expectedHolder: 'evt-other' }), env)).status).toBe(409)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toBe('evt-1')
  })

  it('rejects a wrong admin secret (401)', async () => {
    const { env } = await setup('manual_review', V3_CREATED)
    const req = new Request('https://router.test/admin/coinbase-exec-gate/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': 'nope' },
      body: JSON.stringify({ plId: PL, evidence: 'x'.repeat(30), clearedBy: 'a', expectedHolder: 'evt-1' }),
    })
    expect((await handleCoinbaseExecGateClear(req, env)).status).toBe(401)
  })
})

// ── M4: shared reservation counter removed ──────────────────────────────────

describe('funder-reserved-atomic is gone', () => {
  it('no source file references the old counter key or its helpers', () => {
    const root = resolve(__dirname, '..', 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8')
          if (/funder-reserved-atomic|\bbumpReserved\b|\breservedAtomic\b/.test(src)) offenders.push(p)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it('a full webhook settlement plus a sweep never touch the old counter key', async () => {
    stubFetch({ coinbase: { id: PL, status: 'COMPLETED', usageCount: 1, maxUsage: 1 } })
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent('payment_payin_completed')), env)
    await sweepCoinbaseFulfillments(env)
    expect(kv._touched).not.toContain('funder-reserved-atomic')
  })
})
