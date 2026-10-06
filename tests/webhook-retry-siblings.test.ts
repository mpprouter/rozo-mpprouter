/**
 * Webhook settlement for re-order siblings (`<link>__retryN`).
 *
 * Every Rozo order for one Coinbase link shares the one fulfillment record
 * keyed by the base link id, so the invoice settles at most once. The record
 * follows the order that actually pays (not an expired one that only sent a
 * status event), and a payin from a SECOND order is flagged as a double
 * payment (ops alert, refund by hand) and never pays the invoice again.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleRozoWebhook, saveRecordGuarded, type FulfillmentRecord } from '../src/routes/webhook'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

// ── helpers (same shape as webhook-alerts.test.ts) ─────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret'
const PL = 'pl_testDelivery1'
const ROZO_ID = '11111111-2222-3333-4444-555555555555'
const OLD_ID = '99999999-8888-7777-6666-555555555555'
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
  // Intercom POST /tickets: HTTP status, or 'throw' for a network error.
  intercom: number | 'throw'
}

function stubFetch(cfg: Partial<Upstream> = {}) {
  const up: Upstream = {
    balanceAtomic: 10_000_000n,
    payStatus: 200,
    payBody: CAPTURED_BODY,
    coinbase: { id: PL, status: 'ACTIVE', usageCount: 0, maxUsage: 1, preApprovalExpiry: String(Math.floor(Date.now() / 1000) + 86400) },
    rozo: null,
    deliveredStatus: 200,
    intercom: 200,
    ...cfg,
  }
  const calls = { pay: 0, coinbase: 0, rozoGet: 0, delivered: [] as Array<{ url: string; body: any; key: string | null }>, dingtalk: [] as string[], intercom: [] as Array<{ body: any; auth: string | null; version: string | null }> }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        calls.dingtalk.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.includes('api.intercom.io/tickets')) {
        const headers = new Headers(init?.headers)
        calls.intercom.push({ body: JSON.parse(String(init?.body)), auth: headers.get('Authorization'), version: headers.get('Intercom-Version') })
        if (up.intercom === 'throw') throw new TypeError('network down')
        if (up.intercom !== 200) return Response.json({ type: 'error.list', errors: [{ code: 'server_error', message: 'boom' }] }, { status: up.intercom })
        return Response.json({ type: 'ticket', id: '777', ticket_id: '12' })
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


afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function evt(type: string, id: string, orderId: string) {
  const e = payoutEvent(type)
  e.data.id = id
  e.data.orderId = orderId
  return e
}

describe('re-order siblings share one fulfillment record', () => {
  it('a __retry2 order settles the base link record exactly once', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stubFetch()
    const res = await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', ROZO_ID, `${PL}__retry2`)), env)
    expect(res.status).toBe(200)
    expect(calls.pay).toBe(1)
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.pl_id).toBe(PL)
    expect(rec.rozoPaymentId).toBe(ROZO_ID)
    expect(kv._store.has(`invoice-fulfillment:${PL}__retry2`)).toBe(false)
  })

  it('the record follows the paying order, not the expired one that only sent a status event', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stubFetch()
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_expired', OLD_ID, PL)), env)
    expect(readRec(kv).rozoPaymentId).toBe(OLD_ID)
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', ROZO_ID, `${PL}__retry2`)), env)
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.rozoPaymentId).toBe(ROZO_ID)
    expect(rec.settlingRozoPaymentId).toBe(ROZO_ID)
    // Delivery is reported for the order that paid.
    expect(calls.delivered.map((d) => d.url)).toEqual([expect.stringContaining(ROZO_ID)])
    expect(calls.dingtalk).toEqual([])
  })

  it('a late payment on the old expired order after the re-order settled -> no second pay, one refund alert', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stubFetch()
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', ROZO_ID, `${PL}__retry2`)), env)
    expect(calls.pay).toBe(1)
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payin_completed', OLD_ID, PL)), env)
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', OLD_ID, PL)), env)
    expect(calls.pay).toBe(1)
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.rozoPaymentId).toBe(ROZO_ID)
    expect(rec.duplicateRozoPaymentIds).toEqual([OLD_ID])
    const dupAlerts = calls.dingtalk.filter((t) => t.includes('Second payment for one invoice'))
    expect(dupAlerts).toHaveLength(1)
    expect(dupAlerts[0]).toContain(OLD_ID.slice(0, 8))
  })

  it('a pre-existing paid record (no settling field) still flags a second order', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stubFetch()
    seedRec(kv, { status: 'paid', rozoPaymentId: ROZO_ID })
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payin_completed', OLD_ID, `${PL}__retry2`)), env)
    expect(calls.pay).toBe(0)
    expect(readRec(kv).duplicateRozoPaymentIds).toEqual([OLD_ID])
    expect(calls.dingtalk.filter((t) => t.includes('Second payment'))).toHaveLength(1)
  })

  it('payin then payout of the same order is not a duplicate', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stubFetch({ balanceAtomic: 0n })
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payin_completed', ROZO_ID, `${PL}__retry2`)), env)
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', ROZO_ID, `${PL}__retry2`)), env)
    expect(readRec(kv).duplicateRozoPaymentIds ?? []).toEqual([])
    expect(calls.dingtalk.filter((t) => t.includes('Second payment'))).toHaveLength(0)
  })

  it('two siblings adopted concurrently -> the merge keeps one and reports the other', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stubFetch()
    seedRec(kv, { status: 'payin_seen', rozoPaymentId: ROZO_ID, settlingRozoPaymentId: ROZO_ID } as any)
    const racer = { ...readRec(kv), rozoPaymentId: OLD_ID, settlingRozoPaymentId: OLD_ID } as FulfillmentRecord
    const out = await saveRecordGuarded(env, PL, racer)
    expect(out.settlingRozoPaymentId).toBe(ROZO_ID)
    expect(out.rozoPaymentId).toBe(ROZO_ID)
    expect(out.duplicateRozoPaymentIds).toEqual([OLD_ID])
    expect(calls.dingtalk.filter((t) => t.includes('Second payment'))).toHaveLength(1)
  })

  it('a second order paying while the first is still waiting never drives settlement', async () => {
    const { env, kv } = makeEnv()
    const { up, calls } = stubFetch({ balanceAtomic: 0n })
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payin_completed', OLD_ID, PL)), env)
    expect(readRec(kv).settlingRozoPaymentId).toBe(OLD_ID)
    up.balanceAtomic = 10_000_000n
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', ROZO_ID, `${PL}__retry2`)), env)
    expect(calls.pay).toBe(0)
    expect(readRec(kv).duplicateRozoPaymentIds).toEqual([ROZO_ID])
    // The settling order's own payout still settles the invoice, once.
    await handleRozoWebhook(await signedWebhookRequest(evt('payment_payout_completed', OLD_ID, PL)), env)
    expect(calls.pay).toBe(1)
    const rec = readRec(kv)
    expect(rec.status).toBe('paid')
    expect(rec.rozoPaymentId).toBe(OLD_ID)
  })
})
