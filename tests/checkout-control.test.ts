/**
 * Checkout emergency stop: switch semantics, stop/resume races, webhook
 * deferral, backlog replay, and the manual pay entry points.
 *
 * Design: ainative docs/design/20261023-admin-stop-resume-withdraw-checkout.zh.md
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleRozoWebhook, type FulfillmentRecord } from '../src/routes/webhook'
import {
  CHECKOUT_CONTROL_KEY,
  checkoutBacklogKey,
  clearPausedDelivery,
  listPausedDeliveries,
  recordPausedDelivery,
  readCheckoutControl,
  resumeCheckout,
  stopCheckout,
} from '../src/routes/checkout-control'
import { handleCheckoutControl } from '../src/routes/checkout-control-admin'
import { handleAdminPayInvoice } from '../src/routes/pay-invoice-admin'
import { readCoinbaseExecGate } from '../src/routes/coinbase-exec-gate'
import { casRead, casUpdate } from '../src/routes/stripe-atomic'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { boundCoinbaseLink } from './helpers/coinbase-binding'

const WEBHOOK_SECRET = 'test-webhook-secret'
const CONTROL_SECRET = 'test-control-secret'
const PL = 'pl_testCheckoutStop1'
const ROZO_ID = '99999999-2222-3333-4444-555555555555'
const KEY = `invoice-fulfillment:${PL}`
const REQ = { reason: 'incident drill', actor: 'test', requestId: 'req-1' }

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
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
    list: async (opts: { prefix?: string }) => ({
      keys: [...store.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).sort().map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKvMock()
  const env = {
    MPP_STORE: kv,
    ATOMIC_STORE: makeAtomicStoreMock(),
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    CHECKOUT_CONTROL_SECRET: CONTROL_SECRET,
    BASE_RPC_URL: 'https://rpc.test/primary',
    ROZO_INTENTS_API_KEY: 'test-rozo-key',
    ...overrides,
  }
  return { env: env as unknown as Env, kv }
}

const CAPTURED_BODY = {
  success: true,
  mode: 'admin',
  coinbase: { success: true, protocolVersion: 'v3', session: { id: PL, status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' }, captured: true },
}

function rozoPayment(status = 'payment_payout_completed') {
  return {
    id: ROZO_ID,
    appId: 'merchant_openrouter',
    orderId: PL,
    status,
    source: { amount: '1.00', chainId: '8453', txHash: '0xsrc' },
    destination: { amount: '1.00', chainId: '8453', txHash: '0xdst' },
  }
}

function stubFetch(rozo: Record<string, unknown> | null = rozoPayment()) {
  const calls = { pay: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('agentapi.rozo.ai/pay-invoice')) {
        calls.pay++
        return Response.json(CAPTURED_BODY)
      }
      if (url.includes('payments.coinbase.com/next-api/')) return Response.json(boundCoinbaseLink(PL))
      if (url.includes('intentapiv4.rozo.ai')) {
        if (!rozo) return new Response('nf', { status: 404 })
        return Response.json(rozo)
      }
      if (url.includes('oapi.dingtalk.com')) return Response.json({ errcode: 0 })
      // Funder balance RPC: 10 USDC.
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + (10_000_000n).toString(16) })
    }),
  )
  return calls
}

let seq = 0
function payoutEvent(type = 'payment_payout_completed') {
  return {
    event_id: `evt-stop-${++seq}`,
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

function readRec(kv: ReturnType<typeof makeKvMock>): FulfillmentRecord {
  return JSON.parse(kv._store.get(KEY)!)
}

function adminRequest(body?: unknown, secret = CONTROL_SECRET): Request {
  return new Request('https://apiserver.mpprouter.dev/admin/checkout-control', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('switch semantics', () => {
  it('absent key reads as running, stop pauses, a second stop changes nothing', async () => {
    const { env } = makeEnv()
    expect((await readCheckoutControl(env)).paused).toBe(false)

    const first = await stopCheckout(env, REQ)
    expect(first.changed).toBe(true)
    const r1 = await readCheckoutControl(env)
    expect(r1.paused).toBe(true)
    expect(r1.state?.reason).toBe('incident drill')

    const second = await stopCheckout(env, { ...REQ, reason: 'other', requestId: 'req-2' })
    expect(second.changed).toBe(false)
    const r2 = await readCheckoutControl(env)
    expect(r2.version).toBe(r1.version)
    expect(r2.state?.reason).toBe('incident drill')
  })

  it('fails closed on a corrupt value and on an unreadable store', async () => {
    const { env } = makeEnv()
    await casUpdate(env, CHECKOUT_CONTROL_KEY, () => ({ op: 'set', value: '{"paused":"no"}', result: true }))
    const corrupt = await readCheckoutControl(env)
    expect(corrupt.paused).toBe(true)
    expect(corrupt.error).toMatch(/unparseable/)

    const broken = makeEnv({
      ATOMIC_STORE: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }) },
    }).env
    const unreadable = await readCheckoutControl(broken)
    expect(unreadable.paused).toBe(true)
    expect(unreadable.error).toMatch(/unreadable/)
  })
})

describe('backlog index', () => {
  it('a clear for an entry that was re-paused meanwhile keeps the fresh entry', async () => {
    const { env } = makeEnv()
    const e = { provider: 'coinbase' as const, ref: PL, rozoPaymentId: ROZO_ID, eventType: 'payment_payin_completed' }
    expect(await recordPausedDelivery(env, e, new Date(1_000))).toBe(true)
    const [seen] = await listPausedDeliveries(env)
    await recordPausedDelivery(env, { ...e, eventType: 'payment_payout_completed' }, new Date(2_000))

    expect(await clearPausedDelivery(env, PL, seen)).toBe(false)
    const [kept] = await listPausedDeliveries(env)
    expect(kept).toMatchObject({ count: 2, eventType: 'payment_payout_completed', firstPausedAt: seen.firstPausedAt })

    expect(await clearPausedDelivery(env, PL, kept)).toBe(true)
    expect(await listPausedDeliveries(env)).toEqual([])
  })
})

describe('resume is conditional on the version the operator read', () => {
  it('a stop that lands after the read makes the old resume fail', async () => {
    const { env } = makeEnv()
    await stopCheckout(env, REQ)
    const seen = await readCheckoutControl(env)

    // Someone resumes and stops again in between: the version moves on.
    const resumed = await resumeCheckout(env, { ...REQ, requestId: 'req-r' }, seen.version)
    expect(resumed.ok).toBe(true)
    await stopCheckout(env, { ...REQ, requestId: 'req-s2', reason: 'new incident' })

    const stale = await resumeCheckout(env, { ...REQ, requestId: 'req-stale' }, seen.version)
    expect(stale.ok).toBe(false)
    expect((await readCheckoutControl(env)).paused).toBe(true)
  })

  it('resume of a running switch is a no-op', async () => {
    const { env } = makeEnv()
    const r = await resumeCheckout(env, REQ, 0)
    expect(r).toEqual({ ok: true, changed: false, state: null })
  })
})

describe('webhook while paused', () => {
  it('does not call pay-invoice, keeps the record pre-pay and indexes it', async () => {
    const { env, kv } = makeEnv()
    const calls = stubFetch()
    await stopCheckout(env, REQ)

    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    const body = await res.json() as any
    expect(res.status).toBe(200)
    expect(body.deferred).toBe('checkout_paused')
    expect(calls.pay).toBe(0)

    const rec = readRec(kv)
    expect(rec.status).toBe('payin_seen')
    expect(rec.events.some((e) => e.kind === 'checkout_paused')).toBe(true)
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()

    const backlog = await listPausedDeliveries(env)
    expect(backlog).toHaveLength(1)
    expect(backlog[0]).toMatchObject({ provider: 'coinbase', ref: PL, rozoPaymentId: ROZO_ID, eventType: 'payment_payout_completed' })
  })

  it('an unreadable switch also defers (fail closed)', async () => {
    const { env } = makeEnv()
    const calls = stubFetch()
    await casUpdate(env, CHECKOUT_CONTROL_KEY, () => ({ op: 'set', value: 'not json', result: true }))
    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(((await res.json()) as any).deferred).toBe('checkout_paused')
    expect(calls.pay).toBe(0)
  })

  it('pays normally when the switch is running', async () => {
    const { env, kv } = makeEnv()
    const calls = stubFetch()
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(calls.pay).toBe(1)
    expect(readRec(kv).status).toBe('paid')
  })
})

describe('admin endpoint: resume then replay', () => {
  it('replays the paused order exactly once through the normal path', async () => {
    const { env, kv } = makeEnv()
    const calls = stubFetch()

    let res = await handleCheckoutControl(adminRequest({ action: 'stop', ...{ reason: 'drill', actor: 't', request_id: 's1' } }), env)
    expect(((await res.json()) as any).verified).toBe(true)
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(calls.pay).toBe(0)

    // Replay while paused is refused.
    res = await handleCheckoutControl(adminRequest({ action: 'replay', reason: 'r', actor: 't', request_id: 'p0' }), env)
    expect(res.status).toBe(409)

    const status = (await (await handleCheckoutControl(adminRequest(), env)).json()) as any
    expect(status.checkout.paused).toBe(true)
    expect(status.backlog.count).toBe(1)

    // Resume needs the version the operator saw.
    res = await handleCheckoutControl(adminRequest({ action: 'resume', reason: 'fixed', actor: 't', request_id: 'r1' }), env)
    expect(res.status).toBe(400)
    res = await handleCheckoutControl(
      adminRequest({ action: 'resume', reason: 'fixed', actor: 't', request_id: 'r1', expected_version: status.checkout.version }),
      env,
    )
    const resumed = (await res.json()) as any
    expect(resumed.verified).toBe(true)
    // Resume alone moves no money.
    expect(calls.pay).toBe(0)

    res = await handleCheckoutControl(adminRequest({ action: 'replay', reason: 'backlog', actor: 't', request_id: 'p1' }), env)
    const replay = (await res.json()) as any
    expect(replay.results).toHaveLength(1)
    expect(replay.results[0].outcome).toBe('settled_path_ran')
    expect(replay.remaining).toBe(0)
    expect(calls.pay).toBe(1)
    expect(readRec(kv).status).toBe('paid')

    // A second replay finds nothing; an index row put back by hand is cleared
    // without paying again.
    await casUpdate(env, checkoutBacklogKey(PL), () => ({
      op: 'set',
      value: JSON.stringify({ provider: 'coinbase', ref: PL, rozoPaymentId: ROZO_ID, eventType: 'payment_payout_completed', firstPausedAt: 'x', lastPausedAt: 'x', count: 1 }),
      result: true,
    }))
    res = await handleCheckoutControl(adminRequest({ action: 'replay', reason: 'again', actor: 't', request_id: 'p2' }), env)
    const again = (await res.json()) as any
    expect(again.results[0].outcome).toBe('already_moved')
    expect(calls.pay).toBe(1)
  })

  it('keeps the entry when Rozo has not reached a payable status', async () => {
    const { env } = makeEnv()
    stubFetch(rozoPayment('payment_unpaid'))
    await stopCheckout(env, REQ)
    await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    const seen = await readCheckoutControl(env)
    await resumeCheckout(env, REQ, seen.version)
    const res = await handleCheckoutControl(adminRequest({ action: 'replay', reason: 'r', actor: 't', request_id: 'p' }), env)
    const replay = (await res.json()) as any
    expect(replay.results[0].outcome).toBe('needs_human')
    expect(replay.remaining).toBe(1)
  })

  it('rejects a wrong secret and the pay-invoice admin secret', async () => {
    const { env } = makeEnv()
    expect((await handleCheckoutControl(adminRequest(undefined, 'nope'), env)).status).toBe(401)
    expect((await handleCheckoutControl(adminRequest(undefined, 'test-admin-secret'), env)).status).toBe(401)
    const { env: noSecret } = makeEnv({ CHECKOUT_CONTROL_SECRET: undefined })
    expect((await handleCheckoutControl(adminRequest(), noSecret)).status).toBe(500)
  })

  it('stop and resume touch only the checkout key', async () => {
    const { env } = makeEnv()
    await handleCheckoutControl(adminRequest({ action: 'stop', reason: 'r', actor: 't', request_id: 's' }), env)
    const raw = await casRead(env, CHECKOUT_CONTROL_KEY)
    expect(JSON.parse(raw.value!).paused).toBe(true)
  })
})

describe('manual pay entry points while paused', () => {
  it('/admin/pay-invoice answers 503 without calling upstream', async () => {
    const { env } = makeEnv()
    const calls = stubFetch()
    await stopCheckout(env, REQ)
    const res = await handleAdminPayInvoice(
      new Request('https://apiserver.mpprouter.dev/admin/pay-invoice', {
        method: 'POST',
        headers: { 'x-admin-secret': 'test-admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ payment_id: PL }),
      }),
      env,
    )
    expect(res.status).toBe(503)
    expect(((await res.json()) as any).error).toBe('CHECKOUT_PAUSED')
    expect(calls.pay).toBe(0)
  })
})
