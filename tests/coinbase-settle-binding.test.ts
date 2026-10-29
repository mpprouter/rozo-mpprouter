/**
 * Coinbase settle path hardening (webhook.ts settleCoinbaseEvent):
 *   A. order binding: re-read the Rozo order and the Coinbase invoice before
 *      pay-invoice; refuse on mismatch.
 *   B. daily spend ledger ('coinbase' ledger of reserveDailySpend).
 *   C. fast capture confirmation + delivered ack after pay-invoice.
 *   D. constant-time secret comparison helper.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  FAST_CONFIRM_OFFSETS_MS,
  fastConfirmAfterPay,
  handleRozoWebhook,
  type FulfillmentRecord,
} from '../src/routes/webhook'
import { readDailySpentAtomic, reserveDailySpend } from '../src/routes/stripe-fulfillment'
import { readCoinbaseExecGate } from '../src/routes/coinbase-exec-gate'
import { timingSafeEqualStr } from '../src/utils/timing-safe'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { boundCoinbaseLink, boundRozoOrder } from './helpers/coinbase-binding'

const WEBHOOK_SECRET = 'test-webhook-secret'
const PL = 'pl_testBinding1'
const ROZO_ID = '22222222-3333-4444-5555-666666666666'
const KEY = `invoice-fulfillment:${PL}`

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signed(evt: unknown): Promise<Request> {
  const body = JSON.stringify(evt)
  const ts = Date.now().toString()
  const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${ts}.${body}`)
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook', {
    method: 'POST',
    headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig}`, 'content-type': 'application/json' },
    body,
  })
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKv()
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

const CAPTURED = {
  success: true,
  coinbase: { protocolVersion: 'v1', captured: true, link: { usageCount: 1, maxUsage: 1 } },
}
const PENDING = {
  success: false,
  coinbase: { protocolVersion: 'v3', captured: false, session: { status: 'PAYMENT_SESSION_STATUS_CAPTURE_PENDING' } },
}

interface Up {
  order: Record<string, unknown> | null
  coinbase: Record<string, unknown> | null
  payStatus: number
  payBody: unknown
  balanceAtomic: bigint
  delivered: number[] // successive /delivered statuses; last one repeats
}

function stub(cfg: Partial<Up> = {}) {
  const up: Up = {
    order: boundRozoOrder(ROZO_ID, PL),
    coinbase: boundCoinbaseLink(PL),
    payStatus: 200,
    payBody: CAPTURED,
    balanceAtomic: 100_000_000n,
    delivered: [200],
    ...cfg,
  }
  const calls = { pay: 0, coinbase: 0, orderGet: 0, delivered: 0, dingtalk: [] as string[] }
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
        return new Response(JSON.stringify(up.payBody), { status: up.payStatus })
      }
      if (url.includes('payments.coinbase.com/next-api/')) {
        calls.coinbase++
        return up.coinbase ? Response.json(up.coinbase) : new Response('down', { status: 500 })
      }
      if (url.includes('intentapiv4.rozo.ai') && url.endsWith('/delivered')) {
        const status = up.delivered[Math.min(calls.delivered, up.delivered.length - 1)]
        calls.delivered++
        return new Response('{}', { status })
      }
      if (url.includes('intentapiv4.rozo.ai')) {
        calls.orderGet++
        return up.order ? Response.json(up.order) : new Response('nf', { status: 404 })
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + up.balanceAtomic.toString(16) })
    }),
  )
  return { up, calls }
}

let seq = 0
function event(type = 'payment_payout_completed', data: Record<string, unknown> = {}) {
  return {
    event_id: `evt-binding-${++seq}`,
    type,
    timestamp: new Date().toISOString(),
    data: {
      id: ROZO_ID,
      appId: 'merchant_openrouter',
      orderId: PL,
      status: 'payment_payout_completed',
      source: { amount: '1.00', chainId: '8453', txHash: null },
      destination: { amount: '1.00', chainId: '8453', txHash: '0xdeadbeef' },
      ...data,
    },
  }
}

// Runs the webhook with setTimeout faked so the binding retry backoff
// (BINDING_RETRY_DELAYS_MS) does not slow the suite down.
async function handleFast(req: Request, env: Env): Promise<Response> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    return await drive(handleRozoWebhook(req, env))
  } finally {
    vi.useRealTimers()
  }
}

// Advances faked timers until `p` settles (the handler awaits real crypto and
// fetch stubs between timers, so a single runAllTimers is not enough).
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false
  p.then(() => (done = true), () => (done = true))
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(1_000)
  }
  return p
}

function rec(kv: ReturnType<typeof makeKv>): FulfillmentRecord {
  return JSON.parse(kv._store.get(KEY)!)
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── A. order binding ────────────────────────────────────────────────────────

describe('Coinbase settle: order binding', () => {
  it('a paid order bound to the link pays once, using the Coinbase amount', async () => {
    const { calls } = stub({ coinbase: boundCoinbaseLink(PL, '0.99') })
    const { env, kv } = makeEnv()
    // The webhook amount is not what gets paid; the Coinbase invoice is.
    await handleRozoWebhook(await signed(event('payment_payout_completed', { destination: { amount: '0.01' } })), env)
    expect(calls.orderGet).toBeGreaterThanOrEqual(1)
    expect(calls.pay).toBe(1)
    const r = rec(kv)
    expect(r.status).toBe('paid')
    expect(r.invoiceAmountAtomic).toBe('990000')
  })

  it('a __retry2 sibling order binds to its base link', async () => {
    const { calls } = stub({ order: boundRozoOrder(ROZO_ID, `${PL}__retry2`) })
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signed(event('payment_payout_completed', { orderId: `${PL}__retry2` })), env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  const refusals: Array<[string, Partial<Up>, Record<string, unknown>, RegExp]> = [
    ['order for another link', { order: boundRozoOrder(ROZO_ID, 'pl_someoneElse') }, {}, /different invoice/],
    ['order on another app', { order: boundRozoOrder(ROZO_ID, PL, { appId: 'rozoDemo' }) }, {}, /appId rozoDemo/],
    ['webhook on another app', {}, { appId: 'wallet_rozopay' }, /webhook appId wallet_rozopay/],
    ['order not paid on a payout event', { order: boundRozoOrder(ROZO_ID, PL, { status: 'payment_unpaid' }) }, {}, /not paid/],
    ['order expired', { order: boundRozoOrder(ROZO_ID, PL, { status: 'payment_expired' }) }, {}, /payment_expired/],
    [
      'Coinbase invoice above the order destination',
      { coinbase: boundCoinbaseLink(PL, '3500.00'), order: boundRozoOrder(ROZO_ID, PL, { destination: { amount: '1.00' } }) },
      {},
      /exceeds Rozo order destination/,
    ],
  ]

  for (const [name, up, data, reason] of refusals) {
    it(`refuses (terminal, alert, no pay): ${name}`, async () => {
      const { calls } = stub(up)
      const { env, kv } = makeEnv()
      const res = await handleRozoWebhook(await signed(event('payment_payout_completed', data)), env)
      const body = (await res.json()) as any
      expect(calls.pay).toBe(0)
      expect(body.status).toBe('order_binding_failed')
      expect(body.reason).toMatch(reason)
      const r = rec(kv)
      expect(r.status).toBe('order_binding_failed')
      expect(r.failureReason).toMatch(reason)
      expect(r.events.some((e) => e.kind === 'order_binding_failed')).toBe(true)
      expect(calls.dingtalk).toHaveLength(1)
      expect(calls.dingtalk[0]).toContain('Rozo order does not match the invoice')
      // Never reaches the exec gate, and a replay stays refused.
      expect(await readCoinbaseExecGate(env, PL)).toBeNull()
      await handleRozoWebhook(await signed(event('payment_payout_completed', data)), env)
      expect(calls.pay).toBe(0)
    })
  }

  it('the exact destination amount is accepted (no tolerance either way)', async () => {
    const { calls } = stub({
      coinbase: boundCoinbaseLink(PL, '10.00'),
      order: boundRozoOrder(ROZO_ID, PL, { destination: { amount: '10.000000' } }),
    })
    const { env } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    expect(calls.pay).toBe(1)
  })

  const deferrals: Array<[string, Partial<Up>, string, RegExp]> = [
    ['Rozo order unreadable', { order: null }, 'payment_payout_completed', /unreadable/],
    ['Coinbase unreadable', { coinbase: null }, 'payment_payout_completed', /Coinbase invoice amount unreadable/],
    ['order still unpaid on a payin event', { order: boundRozoOrder(ROZO_ID, PL, { status: 'payment_unpaid' }) }, 'payment_payin_completed', /not paid yet/],
  ]
  for (const [name, up, type, reason] of deferrals) {
    it(`defers without paying (not terminal): ${name}`, async () => {
      const { calls } = stub(up)
      const { env, kv } = makeEnv()
      const evt = event(type)
      const res = await handleFast(await signed(evt), env)
      const body = (await res.json()) as any
      expect(calls.pay).toBe(0)
      expect(body.deferred).toBe('order_binding_unverified')
      // Retried in-process (3 attempts) before deferring.
      expect(calls.orderGet).toBe(3)
      // The dedup marker is released, so a resend of the same event reruns.
      expect(kv._store.has(`webhook-event:${evt.event_id}`)).toBe(false)
      expect(body.reason).toMatch(reason)
      expect(rec(kv).status).toBe('payin_seen')
      expect(calls.dingtalk).toHaveLength(0)
    })
  }

  it('a transient read failure is retried in-process and then pays', async () => {
    const { up, calls } = stub({ order: null })
    const { env, kv } = makeEnv()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const p = handleRozoWebhook(await signed(event()), env)
      for (let i = 0; i < 50 && calls.orderGet < 1; i++) await new Promise((r) => setImmediate(r))
      expect(calls.orderGet).toBe(1)
      up.order = boundRozoOrder(ROZO_ID, PL)
      await drive(p)
    } finally {
      vi.useRealTimers()
    }
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('a resent payout event after a deferral is processed again and pays', async () => {
    const { up, calls } = stub({ order: null })
    const { env, kv } = makeEnv()
    const evt = event()
    await handleFast(await signed(evt), env)
    expect(calls.pay).toBe(0)
    up.order = boundRozoOrder(ROZO_ID, PL)
    const res = await handleRozoWebhook(await signed(evt), env)
    expect(((await res.json()) as any).dedup).toBeUndefined()
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('a deferred binding settles on the next event once the reads succeed', async () => {
    const { up, calls } = stub({ order: null })
    const { env, kv } = makeEnv()
    await handleFast(await signed(event('payment_payin_completed')), env)
    expect(calls.pay).toBe(0)
    up.order = boundRozoOrder(ROZO_ID, PL)
    await handleRozoWebhook(await signed(event('payment_payout_completed')), env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('a missing intents API key fails closed (defers)', async () => {
    const { calls } = stub()
    const { env } = makeEnv({ ROZO_INTENTS_API_KEY: undefined })
    const res = await handleFast(await signed(event()), env)
    expect(((await res.json()) as any).deferred).toBe('order_binding_unverified')
    expect(calls.pay).toBe(0)
  })
})

// ── B. daily spend ledger ───────────────────────────────────────────────────

describe('Coinbase settle: daily spend ledger', () => {
  it('record-only when COINBASE_SETTLE_DAILY_CAP_USD is unset: counted, never refused', async () => {
    const { calls } = stub({ coinbase: boundCoinbaseLink(PL, '3500.00'), order: boundRozoOrder(ROZO_ID, PL, { destination: { amount: '3535.00' } }), balanceAtomic: 10_000_000_000n })
    const { env } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    expect(calls.pay).toBe(1)
    expect(await readDailySpentAtomic(env, new Date(), 'coinbase')).toBe(3_500_000_000n)
    // The Stripe ledger (shared by Stripe, UPI, Stripe coupons) is untouched.
    expect(await readDailySpentAtomic(env, new Date())).toBe(0n)
  })

  it('over the cap on a payout event: no pay, failed_insufficient_balance, one alert', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv({ COINBASE_SETTLE_DAILY_CAP_USD: '1.5' })
    await reserveDailySpend(env, new Date(), 1_000_000n, 'coinbase')
    const res = await handleRozoWebhook(await signed(event()), env)
    expect(((await res.json()) as any).deferred).toBe('daily_cap_reached')
    expect(calls.pay).toBe(0)
    const r = rec(kv)
    expect(r.status).toBe('failed_insufficient_balance')
    expect(r.events.some((e) => e.kind === 'daily_cap_reached')).toBe(true)
    expect(calls.dingtalk).toHaveLength(1)
    expect(calls.dingtalk[0]).toContain('daily settlement cap reached')
    expect(await readDailySpentAtomic(env, new Date(), 'coinbase')).toBe(1_000_000n)
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
  })

  it('over the cap on a payin event: defers quietly (payout event alerts)', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv({ COINBASE_SETTLE_DAILY_CAP_USD: '0.5' })
    await handleRozoWebhook(await signed(event('payment_payin_completed')), env)
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
    expect(calls.dingtalk).toHaveLength(0)
  })

  it('within the cap: reserves the invoice amount and pays', async () => {
    const { calls } = stub()
    const { env } = makeEnv({ COINBASE_SETTLE_DAILY_CAP_USD: '1' })
    await handleRozoWebhook(await signed(event()), env)
    expect(calls.pay).toBe(1)
    expect(await readDailySpentAtomic(env, new Date(), 'coinbase')).toBe(1_000_000n)
  })

  it('a definite 4xx refusal from pay-invoice gives the reservation back', async () => {
    stub({ payStatus: 422, payBody: { error: 'refused' } })
    const { env, kv } = makeEnv({ COINBASE_SETTLE_DAILY_CAP_USD: '10' })
    await handleRozoWebhook(await signed(event()), env)
    expect(rec(kv).status).toBe('failed_pay_invoice')
    expect(await readDailySpentAtomic(env, new Date(), 'coinbase')).toBe(0n)
  })

  it('an ambiguous 5xx keeps the reservation counted', async () => {
    stub({ payStatus: 502, payBody: { error: 'bad gateway' } })
    const { env } = makeEnv({ COINBASE_SETTLE_DAILY_CAP_USD: '10' })
    await handleRozoWebhook(await signed(event()), env)
    expect(await readDailySpentAtomic(env, new Date(), 'coinbase')).toBe(1_000_000n)
  })

  it('a second event stopped by the exec gate releases its own reservation', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv({ COINBASE_SETTLE_DAILY_CAP_USD: '10' })
    await handleRozoWebhook(await signed(event()), env)
    // Lost KV update: record rolled back, so the next event reaches the gate.
    const r = rec(kv)
    kv._store.set(KEY, JSON.stringify({ ...r, status: 'payin_seen' }))
    const res = await handleRozoWebhook(await signed(event()), env)
    expect(((await res.json()) as any).exec_gate_held).toBe(true)
    expect(calls.pay).toBe(1)
    expect(await readDailySpentAtomic(env, new Date(), 'coinbase')).toBe(1_000_000n)
  })
})

// ── C. fast capture confirmation ────────────────────────────────────────────

describe('Coinbase settle: fast confirmation after pay-invoice', () => {
  it('uses bounded offsets inside the waitUntil budget', () => {
    expect([...FAST_CONFIRM_OFFSETS_MS]).toEqual([5_000, 10_000, 20_000])
    expect(Math.max(...FAST_CONFIRM_OFFSETS_MS)).toBeLessThan(30_000)
  })

  it('capture_pending: the webhook schedules a follow-up without awaiting it', async () => {
    stub({ payBody: PENDING })
    const { env, kv } = makeEnv()
    const scheduled: Promise<unknown>[] = []
    const waitUntil = vi.fn((p: Promise<unknown>) => void scheduled.push(p))
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await handleRozoWebhook(await signed(event()), env, { waitUntil } as any)
      // settlement + fast confirm
      expect(waitUntil).toHaveBeenCalledTimes(2)
      expect(rec(kv).status).toBe('capture_pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('capture_pending → paid at the first tick Coinbase reports the capture, then acks once', async () => {
    const { up, calls } = stub({ payBody: PENDING, coinbase: boundCoinbaseLink(PL) })
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    expect(rec(kv).status).toBe('capture_pending')
    let ticks = 0
    const sleep = async () => {
      ticks++
      // Coinbase captures between the first and second tick.
      if (ticks === 2) up.coinbase = boundCoinbaseLink(PL, '1.00', { status: 'COMPLETED', usageCount: 1 })
    }
    const out = await fastConfirmAfterPay(env, PL, { sleep })
    expect(out).toBe('paid')
    expect(ticks).toBe(2)
    const r = rec(kv)
    expect(r.status).toBe('paid')
    expect(r.paidAt).toBeTruthy()
    expect(r.deliveredReported).toBe(true)
    expect(r.events.some((e) => e.kind === 'fast_confirm_coinbase_settled')).toBe(true)
    expect(calls.delivered).toBe(1)
    expect(calls.pay).toBe(1)
  })

  it('never pays again and never gives up: still pending after the last tick stays capture_pending', async () => {
    const { calls } = stub({ payBody: PENDING })
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    const out = await fastConfirmAfterPay(env, PL, { sleep: async () => {} })
    expect(out).toBe('capture_pending')
    expect(rec(kv).status).toBe('capture_pending')
    expect(calls.pay).toBe(1)
    expect(calls.coinbase).toBeGreaterThanOrEqual(3)
  })

  it('paid but Rozo answered 409 (payout pending): retried at the next tick, not counted as a failure', async () => {
    const { calls } = stub({ delivered: [409, 409, 200] })
    const { env, kv } = makeEnv()
    const waitUntil = vi.fn()
    // The scheduled background follow-up sleeps on a faked timer that never
    // fires; the explicit run below drives the ticks instead.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await handleRozoWebhook(await signed(event()), env, { waitUntil } as any)
    } finally {
      vi.useRealTimers()
    }
    expect(rec(kv).deliveredReported).toBeFalsy()
    expect(waitUntil).toHaveBeenCalledTimes(2)
    const out = await fastConfirmAfterPay(env, PL, { sleep: async () => {} })
    expect(out).toBe('paid')
    const r = rec(kv)
    expect(r.deliveredReported).toBe(true)
    expect(r.deliveredReportAttempts ?? 0).toBe(0)
    expect(calls.delivered).toBe(3)
  })

  it('already acknowledged: no follow-up is scheduled and a manual run does nothing', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv()
    const waitUntil = vi.fn()
    await handleRozoWebhook(await signed(event()), env, { waitUntil } as any)
    expect(rec(kv).deliveredReported).toBe(true)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const before = calls.delivered
    expect(await fastConfirmAfterPay(env, PL, { sleep: async () => {} })).toBe('paid')
    expect(calls.delivered).toBe(before)
  })

  it('never throws when an upstream read blows up', async () => {
    stub({ payBody: PENDING })
    const { env } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(fastConfirmAfterPay(env, PL, { sleep: async () => {} })).resolves.toBe('capture_pending')
  })
})

// ── D. constant-time compare ────────────────────────────────────────────────

describe('timingSafeEqualStr', () => {
  it('matches equal strings only', () => {
    expect(timingSafeEqualStr('s3cret-token', 's3cret-token')).toBe(true)
    expect(timingSafeEqualStr('s3cret-token', 's3cret-tokeN')).toBe(false)
    expect(timingSafeEqualStr('s3cret-token', 's3cret-toke')).toBe(false)
  })
  it('never matches a missing or empty side', () => {
    expect(timingSafeEqualStr(undefined, undefined)).toBe(false)
    expect(timingSafeEqualStr('', '')).toBe(false)
    expect(timingSafeEqualStr('x', undefined)).toBe(false)
    expect(timingSafeEqualStr(null, 'x')).toBe(false)
  })
})
