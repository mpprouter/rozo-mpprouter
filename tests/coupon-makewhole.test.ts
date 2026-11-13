/**
 * Make-whole coupons: one live coupon per merchant invoice, and one payment
 * per invoice across every path that can make the funder pay it.
 *
 * Design: ainative docs/design/20261112-makewhole-coupon-executor.zh.md
 * §4 (items 2, 5, 6), §8, §9 (items 3, 4, 5c).
 *
 *   - three callers (executor, Hermes, coupon-issue script) racing on the same
 *     invoice get ONE code; the same key retried returns the original code;
 *   - a make-whole request without the key is refused; standard coupons keep
 *     working unchanged;
 *   - void before any payment frees the invoice, void after a payment attempt
 *     keeps it reserved;
 *   - coupon redeem vs. the normal webhook fulfillment of the same invoice:
 *     exactly one pay-invoice request, in either order;
 *   - an unknown pay outcome keeps the invoice locked for every other path;
 *   - redeem re-reads Coinbase and refuses a captured / unreadable invoice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  casUpdate,
  couponKey,
  handleIssueCoupon,
  handleRedeemCoupon,
  handleResolveCoupon,
  makewholeReservationKey,
  parseMakewholeKey,
  parseReservation,
  type MakewholeReservation,
} from '../src/routes/coupon'
import { settleCoinbaseEvent, type FulfillmentRecord } from '../src/routes/webhook'
import { acquireCoinbaseExecGate, readCoinbaseExecGate } from '../src/routes/coinbase-exec-gate'
import { claimInvoiceKey, readInvoiceClaim } from '../src/routes/invoice-claim'
import { handleAdminPayInvoice, readAdminPayAttempt } from '../src/routes/pay-invoice-admin'
import { handleCoinbaseExecGateClear } from '../src/routes/coinbase-exec-gate-admin'
import type { Env } from '../src/index'
import { boundCoinbaseLink, boundRozoOrder } from './helpers/coinbase-binding'

const PL = 'pl_mwTest1'
const OTHER_PL = 'pl_mwOther2'
const KEY = `MW-1:${PL}`
const ROZO_ID = '33333333-4444-5555-6666-777777777777'
const LINK = `https://payments.coinbase.com/payment-links/${PL}`

// ── Fakes (same contracts as tests/coupon.test.ts) ───────────────────────────

class FakeD1 {
  rows: any[] = []
  prepare(_sql: string) {
    const self = this
    return {
      _args: [] as any[],
      bind(...args: any[]) {
        this._args = args
        return this
      },
      async run() {
        if (/^\s*INSERT/i.test(_sql)) self.rows.push({ args: this._args })
        return { success: true }
      },
      async all() {
        return { results: self.rows }
      },
      async first() {
        return self.rows[0] ?? null
      },
    }
  }
}

/** Serialized like a real Durable Object: one fetch handler at a time. */
class FakeAtomicDO {
  store = new Map<string, { value: string | null; version: number }>()
  private tail: Promise<unknown> = Promise.resolve()
  fetch(req: Request): Promise<Response> {
    const run = this.tail.then(() => this._fetch(req))
    this.tail = run.catch(() => {})
    return run
  }
  private async _fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const body: any = await req.json()
    const cur = this.store.get(body.key) ?? { value: null, version: 0 }
    if (url.pathname === '/read') return Response.json({ value: cur.value, version: cur.version })
    if (url.pathname === '/commit') {
      if (cur.version !== body.expectedVersion) {
        return Response.json({ ok: false, value: cur.value, version: cur.version })
      }
      this.store.set(body.key, { value: body.op === 'set' ? body.value : null, version: cur.version + 1 })
      return Response.json({ ok: true })
    }
    return new Response('Not Found', { status: 404 })
  }
}

class FakeAtomicNamespace {
  instances = new Map<string, FakeAtomicDO>()
  idFromName(name: string) {
    return name
  }
  get(id: string) {
    if (!this.instances.has(id)) this.instances.set(id, new FakeAtomicDO())
    return this.instances.get(id)!
  }
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

interface Up {
  /** Coinbase next-api body for PL (null → 500, unreadable). */
  coinbase: Record<string, unknown> | null
  payStatus: number
  payBody: unknown
  /** When set, every pay-invoice call waits for it (holds callers in flight). */
  payGate?: Promise<void>
}

const CAPTURED = {
  success: true,
  coinbase: { protocolVersion: 'v1', captured: true, link: { usageCount: 1, maxUsage: 1 } },
}

function setup(cfg: Partial<Up> = {}, envOverrides: Record<string, unknown> = {}) {
  const up: Up = {
    coinbase: boundCoinbaseLink(PL, '20'),
    payStatus: 200,
    payBody: CAPTURED,
    ...cfg,
  }
  const calls = { pay: 0, payIds: [] as string[], coinbase: 0 }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('quote-invoice')) {
      return Response.json({ invoice: { amount: '20' }, merchant: 'OpenRouter', linkId: PL })
    }
    if (url.includes('agentapi.rozo.ai/pay-invoice')) {
      calls.pay++
      try {
        calls.payIds.push(JSON.parse(String(init?.body)).payment_id)
      } catch {
        /* ignore */
      }
      if (up.payGate) await up.payGate
      return new Response(JSON.stringify(up.payBody), { status: up.payStatus })
    }
    if (url.includes('payments.coinbase.com/next-api/')) {
      calls.coinbase++
      return up.coinbase ? Response.json(up.coinbase) : new Response('down', { status: 500 })
    }
    if (url.includes('intentapiv4.rozo.ai') && url.includes(`/payments/${ROZO_ID}`)) {
      return Response.json(
        boundRozoOrder(ROZO_ID, PL, { source: { amount: '20', chainId: '8453' }, destination: { amount: '20', chainId: '8453' } }),
      )
    }
    if (url.includes('dingtalk') || url.includes('feishu') || url.includes('larksuite')) {
      return Response.json({ errcode: 0, code: 0 })
    }
    // Base JSON-RPC balance read: 1000 USDC.
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16) })
  })
  vi.stubGlobal('fetch', fetchMock)
  const kv = makeKv()
  const env = {
    ATOMIC_STORE: new FakeAtomicNamespace() as any,
    MPP_STORE: kv as any,
    ADMIN_TOKEN: 'test-coupon-admin',
    PAYINVOICE_ADMIN_SECRET: 'test-pay-secret',
    ADMIN_ENDPOINT_ENABLED: 'true',
    BASE_RPC_URL: 'https://fake-rpc.test',
    COUPON_HASH_SECRET: 'test-hmac-secret',
    COUPON_SECURITY_DB: new FakeD1() as any,
    ROZO_INTENTS_API_KEY: 'test-rozo-key',
    ...envOverrides,
  } as unknown as Env
  return { env, up, calls, kv }
}

function issueReq(body: any, secret = 'test-coupon-admin') {
  return new Request('https://router.test/admin/coupon/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify(body),
  })
}

function mwBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'makewhole',
    idempotencyKey: KEY,
    amountUsd: '20',
    paymentProof: 'intents order 0a1b2c3d',
    source: 'executor',
    ...overrides,
  }
}

function redeemReq(code: string, url = LINK, ip = '1.2.3.4') {
  return new Request('https://router.test/coupon/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ code, url }),
  })
}

function resolveReq(body: any) {
  return new Request('https://router.test/admin/coupon/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'test-coupon-admin' },
    body: JSON.stringify(body),
  })
}

function adminPayReq(paymentId: string, extra: Record<string, unknown> = {}) {
  return new Request('https://router.test/admin/pay-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'test-pay-secret' },
    body: JSON.stringify({ payment_id: paymentId, ...extra }),
  })
}

function gateClearReq(expectedHolder: string) {
  return new Request('https://router.test/admin/coinbase-exec-gate/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'test-pay-secret' },
    body: JSON.stringify({
      plId: PL,
      expectedHolder,
      evidence: 'Coinbase link unused, no funder transfer on Base for this invoice',
      clearedBy: 'test-operator',
    }),
  })
}

function couponDo(env: Env): FakeAtomicDO {
  const ns = (env as any).ATOMIC_STORE as FakeAtomicNamespace
  return ns.get(ns.idFromName('coupon'))
}

function couponRecord(env: Env, code: string): any {
  const cur = couponDo(env).store.get(couponKey(code))
  return cur?.value ? JSON.parse(cur.value) : null
}

function reservation(env: Env, invoiceId = PL): MakewholeReservation | null {
  return parseReservation(couponDo(env).store.get(makewholeReservationKey(invoiceId))?.value ?? null)
}

/** All coupon records on the coupon DO that belong to `key`. */
function couponsForKey(env: Env, key = KEY): any[] {
  const out: any[] = []
  for (const [k, v] of couponDo(env).store) {
    if (!k.startsWith('coupon:') || !v.value) continue
    const rec = JSON.parse(v.value)
    if (rec.makewholeKey === key) out.push(rec)
  }
  return out
}

async function issueMw(env: Env, overrides: Record<string, unknown> = {}): Promise<any> {
  const resp = await handleIssueCoupon(issueReq(mwBody(overrides)), env)
  return { status: resp.status, body: (await resp.json()) as any }
}

function webhookEvent(eventId: string) {
  return {
    eventId,
    eventType: 'payment_payout_completed',
    plId: PL,
    rozoPaymentId: ROZO_ID,
    now: Date.now(),
    evt: {
      event_id: eventId,
      type: 'payment_payout_completed',
      timestamp: new Date().toISOString(),
      data: {
        id: ROZO_ID,
        appId: 'merchant_openrouter',
        orderId: PL,
        status: 'payment_payout_completed',
        source: { amount: '20', chainId: '8453', txHash: null },
        destination: { amount: '20', chainId: '8453', txHash: '0xdeadbeef' },
      },
    } as any,
  }
}

function fulfillment(kv: ReturnType<typeof makeKv>): FulfillmentRecord | null {
  const raw = kv._store.get(`invoice-fulfillment:${PL}`)
  return raw ? JSON.parse(raw) : null
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Key grammar ──────────────────────────────────────────────────────────────

describe('parseMakewholeKey', () => {
  it('accepts MW-1 keys for Coinbase v1 and v3 ids only', () => {
    expect(parseMakewholeKey('MW-1:pl_abc123')).toBe('pl_abc123')
    expect(parseMakewholeKey('MW-1:paymentSession_a5306b93-e4b7')).toBe('paymentSession_a5306b93-e4b7')
    for (const bad of ['pl_abc', 'MW-1:', 'MW-1:cpis_123', 'MW-2:pl_abc', 'MW-1:pl_abc/../x', 42, null]) {
      expect(parseMakewholeKey(bad), String(bad)).toBeNull()
    }
  })
})

// ── Issuance ─────────────────────────────────────────────────────────────────

describe('POST /admin/coupon/issue, make-whole', () => {
  it('rejects a make-whole request without idempotencyKey', async () => {
    const { env } = setup()
    const { status, body } = await issueMw(env, { idempotencyKey: undefined })
    expect(status).toBe(400)
    expect(body.error).toBe('MAKEWHOLE_KEY_REQUIRED')
    expect(couponsForKey(env)).toHaveLength(0)
  })

  it('rejects a malformed key, an invoiceId that disagrees with the key, and a missing proof', async () => {
    const { env } = setup()
    expect((await issueMw(env, { idempotencyKey: 'MW-1:cpis_x' })).body.error).toBe('INVALID_IDEMPOTENCY_KEY')
    expect((await issueMw(env, { invoiceId: OTHER_PL })).body.error).toBe('INVALID_IDEMPOTENCY_KEY')
    expect((await issueMw(env, { paymentProof: '  ' })).body.error).toBe('PAYMENT_PROOF_REQUIRED')
    expect((await issueMw(env, { kind: 'standard' })).body.error).toBe('INVALID_IDEMPOTENCY_KEY')
    expect((await issueMw(env, { kind: 'bogus' })).body.error).toBe('INVALID_KIND')
    expect(reservation(env)).toBeNull()
  })

  it('a body carrying idempotencyKey without kind is treated as make-whole', async () => {
    const { env } = setup()
    const { status, body } = await issueMw(env, { kind: undefined })
    expect(status).toBe(200)
    expect(body.kind).toBe('makewhole')
    expect(couponRecord(env, body.code).makewholeInvoiceId).toBe(PL)
  })

  it('same key retried returns the original code (created only once)', async () => {
    const { env } = setup()
    const first = await issueMw(env)
    expect(first.status).toBe(200)
    expect(first.body.created).toBe(true)
    expect(first.body.code).toMatch(/^\d{10}$/)
    const again = await issueMw(env, { source: 'hermes' })
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(again.body.code).toBe(first.body.code)
    expect(couponsForKey(env)).toHaveLength(1)
  })

  it('three callers racing on one invoice get exactly one code', async () => {
    const { env } = setup()
    const results = await Promise.all(
      ['executor', 'hermes', 'coupon-issue'].map((source) => issueMw(env, { source })),
    )
    for (const r of results) expect(r.status).toBe(200)
    const codes = new Set(results.map((r) => r.body.code))
    expect(codes.size).toBe(1)
    expect(results.filter((r) => r.body.created)).toHaveLength(1)
    expect(couponsForKey(env)).toHaveLength(1)
    expect(reservation(env)?.state).toBe('active')
    expect(reservation(env)?.code).toBe([...codes][0])
  })

  it('same key with a different face value → 409 IDEMPOTENCY_CONFLICT, no second code', async () => {
    const { env } = setup()
    const first = await issueMw(env)
    const conflict = await issueMw(env, { amountUsd: '25' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT')
    expect(conflict.body.code).toBeUndefined()
    expect(couponsForKey(env).map((r) => r.code)).toEqual([first.body.code])
  })

  it('different invoices get independent reservations', async () => {
    const { env } = setup()
    const a = await issueMw(env)
    const b = await issueMw(env, { idempotencyKey: `MW-1:${OTHER_PL}` })
    expect(a.body.code).not.toBe(b.body.code)
    expect(reservation(env, OTHER_PL)?.code).toBe(b.body.code)
  })

  it('repairs a crash between the reservation and the coupon record (same code)', async () => {
    const { env } = setup()
    const now = new Date().toISOString()
    const orphan: MakewholeReservation = {
      v: 1,
      idempotencyKey: KEY,
      invoiceId: PL,
      code: '1234567890',
      amountAtomic: '20000000',
      amountUsd: '20',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      reservedAt: now,
      paymentProof: 'intents order 0a1b2c3d',
      issueSource: 'executor',
      state: 'active',
      history: [],
    }
    await casUpdate(env, makewholeReservationKey(PL), () => ({ op: 'set', value: JSON.stringify(orphan), result: null }))
    const { status, body } = await issueMw(env)
    expect(status).toBe(200)
    expect(body.code).toBe('1234567890')
    expect(couponRecord(env, '1234567890')?.status).toBe('issued')
  })

  it('void before any payment frees the invoice: the next request gets a new code', async () => {
    const { env } = setup()
    const first = await issueMw(env)
    const v = await handleResolveCoupon(resolveReq({ code: first.body.code, action: 'void', reason: 'test' }), env)
    expect(v.status).toBe(200)
    expect(((await v.json()) as any).makewholeReservation).toBe('released')
    const second = await issueMw(env)
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(true)
    expect(second.body.code).not.toBe(first.body.code)
    expect(couponRecord(env, first.body.code).status).toBe('void')
    expect(reservation(env)?.history.map((h) => h.code)).toEqual([first.body.code])
  })

  it('void after a payment attempt keeps the invoice reserved (409 MAKEWHOLE_RESERVATION_HELD)', async () => {
    const { env } = setup({ payStatus: 502, payBody: { error: 'boom' } })
    const first = await issueMw(env)
    await handleRedeemCoupon(redeemReq(first.body.code), env)
    expect(couponRecord(env, first.body.code).status).toBe('manual_review')
    // Even release → issued → void (event history still shows `paying`).
    await handleResolveCoupon(resolveReq({ code: first.body.code, action: 'release', reason: 'x' }), env)
    const v = await handleResolveCoupon(resolveReq({ code: first.body.code, action: 'void', reason: 'x' }), env)
    expect(((await v.json()) as any).makewholeReservation).toBe('held')
    const again = await issueMw(env)
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('MAKEWHOLE_RESERVATION_HELD')
    expect(couponsForKey(env)).toHaveLength(1)
  })

  it('a retry while the coupon is in manual_review returns the original code, never a second one', async () => {
    const { env } = setup({ payStatus: 502, payBody: { error: 'boom' } })
    const first = await issueMw(env)
    await handleRedeemCoupon(redeemReq(first.body.code), env)
    const again = await issueMw(env, { source: 'hermes' })
    expect(again.status).toBe(200)
    expect(again.body.code).toBe(first.body.code)
    expect(again.body.status).toBe('manual_review')
  })
})

describe('POST /admin/coupon/issue, standard coupons stay backward compatible', () => {
  it('a legacy body (no kind, no key) still mints a fresh code each call', async () => {
    const { env } = setup()
    const a = (await (await handleIssueCoupon(issueReq({ amountUsd: '20', paymentProof: 'promo-20261112' }), env)).json()) as any
    const b = (await (await handleIssueCoupon(issueReq({ amountUsd: '20', paymentProof: 'promo-20261112' }), env)).json()) as any
    expect(a.ok && b.ok).toBe(true)
    expect(a.code).not.toBe(b.code)
    expect(couponRecord(env, a.code).kind).toBeUndefined()
  })

  it('a standard request whose proof names an invoice or an MW-1 key is refused', async () => {
    const { env } = setup()
    for (const proof of [`make-whole for ${PL}`, `MW-1:${PL}`, 'see paymentSession_a5306b93e4b7']) {
      const r = await handleIssueCoupon(issueReq({ amountUsd: '20', paymentProof: proof }), env)
      expect(r.status, proof).toBe(400)
      expect(((await r.json()) as any).error).toBe('MAKEWHOLE_KEY_REQUIRED')
    }
  })

  it('COUPON_ISSUE_REQUIRE_KIND=true refuses a body without kind; kind=standard works', async () => {
    const { env } = setup({}, { COUPON_ISSUE_REQUIRE_KIND: 'true' })
    const r = await handleIssueCoupon(issueReq({ amountUsd: '20' }), env)
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error).toBe('KIND_REQUIRED')
    const ok = await handleIssueCoupon(issueReq({ kind: 'standard', amountUsd: '20' }), env)
    expect(ok.status).toBe(200)
  })

  it('a standard coupon still redeems any link of the right amount', async () => {
    const { env, calls } = setup()
    const code = ((await (await handleIssueCoupon(issueReq({ amountUsd: '20' }), env)).json()) as any).code
    const r = (await (await handleRedeemCoupon(redeemReq(code), env)).json()) as any
    expect(r.status).toBe('redeemed')
    expect(calls.pay).toBe(1)
  })
})

// ── Redemption ───────────────────────────────────────────────────────────────

describe('POST /coupon/redeem, make-whole coupons', () => {
  it('redeems its own invoice when Coinbase reports it unsettled', async () => {
    const { env, calls } = setup()
    const { body } = await issueMw(env)
    const r = (await (await handleRedeemCoupon(redeemReq(body.code), env)).json()) as any
    expect(r.status).toBe('redeemed')
    expect(calls.pay).toBe(1)
    expect(calls.payIds).toEqual([PL])
  })

  it('refuses any other link with the uniform error, pays nothing', async () => {
    const { env, calls } = setup()
    const { body } = await issueMw(env)
    const resp = await handleRedeemCoupon(
      redeemReq(body.code, `https://payments.coinbase.com/payment-links/${OTHER_PL}`),
      env,
    )
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error).toBe('INVALID_COUPON')
    expect(calls.pay).toBe(0)
    expect(couponRecord(env, body.code).status).toBe('issued')
  })

  it('Coinbase already CAPTURE_SUCCEEDED (v3) → 409 LINK_USED_OR_EXPIRED, pays nothing', async () => {
    const SESSION = 'paymentSession_a5306b93-e4b7-4c28-8799-f991da38bf22'
    const { env, calls } = setup({
      coinbase: { paymentSessionId: SESSION, status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' },
    })
    const { body } = await issueMw(env, { idempotencyKey: `MW-1:${SESSION}` })
    const resp = await handleRedeemCoupon(
      redeemReq(body.code, `https://payments.coinbase.com/payment-sessions/${SESSION}`),
      env,
    )
    expect(resp.status).toBe(409)
    expect(((await resp.json()) as any).error).toBe('LINK_USED_OR_EXPIRED')
    expect(calls.pay).toBe(0)
    expect(couponRecord(env, body.code).status).toBe('issued')
    expect(await readCoinbaseExecGate(env, SESSION)).toBeNull()
  })

  it('Coinbase v1 link fully used → refused, pays nothing', async () => {
    const { env, calls } = setup({ coinbase: boundCoinbaseLink(PL, '20', { usageCount: 1, maxUsage: 1 }) })
    const { body } = await issueMw(env)
    const resp = await handleRedeemCoupon(redeemReq(body.code), env)
    expect(resp.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('Coinbase unreadable → 502 fail closed, pays nothing, coupon stays issued', async () => {
    const { env, calls } = setup({ coinbase: null })
    const { body } = await issueMw(env)
    const resp = await handleRedeemCoupon(redeemReq(body.code), env)
    expect(resp.status).toBe(502)
    expect(calls.pay).toBe(0)
    expect(couponRecord(env, body.code).status).toBe('issued')
  })
})

// ── One payment per invoice across paths ─────────────────────────────────────

describe('coupon redeem vs normal fulfillment of the same invoice', () => {
  for (const order of ['coupon-first', 'webhook-first'] as const) {
    it(`concurrent (${order}): exactly one pay-invoice request`, async () => {
      let open!: () => void
      const payGate = new Promise<void>((r) => (open = r))
      const { env, calls, kv } = setup({ payGate })
      const { body } = await issueMw(env)
      const redeem = () => handleRedeemCoupon(redeemReq(body.code), env).then((r) => r.json() as Promise<any>)
      const settle = () => settleCoinbaseEvent(env, webhookEvent('evt-mw-race-1'))
      const [first, second] = order === 'coupon-first' ? [redeem(), settle()] : [settle(), redeem()]
      // Let both reach their claim / gate decision, then release pay-invoice.
      for (let i = 0; i < 50 && calls.pay === 0; i++) await new Promise((r) => setTimeout(r, 1))
      await new Promise((r) => setTimeout(r, 20))
      open()
      await Promise.all([first, second])
      expect(calls.pay).toBe(1)
      const gate = await readCoinbaseExecGate(env, PL)
      expect(gate).not.toBeNull()
      const couponPaid = gate!.holder.startsWith(`coupon:${body.code}:`)
      if (couponPaid) {
        expect(couponRecord(env, body.code).status).toBe('redeemed')
        expect(fulfillment(kv)?.status).not.toBe('paid')
      } else {
        expect(couponRecord(env, body.code).status).toBe('issued')
        expect(fulfillment(kv)?.status).toBe('paid')
      }
    })
  }

  it('coupon pay outcome unknown: the webhook, a new issue and admin pay-invoice all stay off', async () => {
    const { env, calls, kv } = setup({ payStatus: 502, payBody: { error: 'upstream timeout' } })
    const { body } = await issueMw(env)
    await handleRedeemCoupon(redeemReq(body.code), env)
    expect(calls.pay).toBe(1)
    expect(couponRecord(env, body.code).status).toBe('manual_review')

    // The order later settles normally: the webhook must not pay again.
    await settleCoinbaseEvent(env, webhookEvent('evt-mw-after-unknown'))
    expect(calls.pay).toBe(1)
    expect(fulfillment(kv)?.status).toBe('claimed_by_other_channel')

    // Another caller asking for a make-whole code gets the same parked coupon.
    const again = await issueMw(env, { source: 'hermes' })
    expect(again.body.code).toBe(body.code)

    // A manual pay is refused too.
    const admin = await handleAdminPayInvoice(adminPayReq(PL), env)
    expect(admin.status).toBe(409)
    expect(((await admin.json()) as any).code).toBe('LINK_CLAIMED')
    expect(calls.pay).toBe(1)

    // Locks are still held by the coupon attempt.
    expect((await readCoinbaseExecGate(env, PL))?.holder.startsWith(`coupon:${body.code}:`)).toBe(true)
    expect((await readInvoiceClaim(env, PL))?.ref).toBe(`coupon:${body.code}`)
  })

  it('webhook pay outcome unknown: the make-whole coupon does not pay', async () => {
    const { env, calls } = setup({ payStatus: 502, payBody: { error: 'upstream timeout' } })
    await settleCoinbaseEvent(env, webhookEvent('evt-mw-webhook-unknown'))
    expect(calls.pay).toBe(1)
    const { body } = await issueMw(env)
    const resp = await handleRedeemCoupon(redeemReq(body.code), env)
    expect(resp.status).toBe(409)
    expect(((await resp.json()) as any).error).toBe('LINK_CLAIMED')
    expect(calls.pay).toBe(1)
    expect(couponRecord(env, body.code).status).toBe('issued')
  })
})

describe('/admin/pay-invoice takes the per-invoice claim and gate', () => {
  it('a second manual pay of the same invoice is refused; nothing sent twice', async () => {
    const { env, calls } = setup()
    const a = await handleAdminPayInvoice(adminPayReq(PL), env)
    expect(a.status).toBe(200)
    const b = await handleAdminPayInvoice(adminPayReq(PL), env)
    expect(b.status).toBe(409)
    expect(calls.pay).toBe(1)
    expect((await readCoinbaseExecGate(env, PL))?.holder.startsWith('admin-pay:')).toBe(true)
  })

  it('after a manual pay, a make-whole coupon for that invoice does not pay', async () => {
    const { env, calls } = setup({ payStatus: 502, payBody: { error: 'unknown' } })
    await handleAdminPayInvoice(adminPayReq(PL), env)
    expect(calls.pay).toBe(1)
    const { body } = await issueMw(env)
    const resp = await handleRedeemCoupon(redeemReq(body.code), env)
    expect(resp.status).toBe(409)
    expect(calls.pay).toBe(1)
  })
})

describe('manual pay keeps a verified recovery path (codex P1)', () => {
  it('a definite manual pay failure can be cleared and re-paid once with the returned repay_ref', async () => {
    const { env, up, calls } = setup({ payStatus: 400, payBody: { error: 'bad request' } })
    const first = await handleAdminPayInvoice(adminPayReq(PL), env)
    expect(first.status).toBe(400)
    const holder = (await readCoinbaseExecGate(env, PL))!.holder
    expect(holder.startsWith('admin-pay:')).toBe(true)
    expect((await readAdminPayAttempt(env, PL))?.status).toBe('failed')

    // Without the verified clear, every later manual pay is refused.
    expect((await handleAdminPayInvoice(adminPayReq(PL), env)).status).toBe(409)
    expect(calls.pay).toBe(1)

    const cleared = await handleCoinbaseExecGateClear(gateClearReq(holder), env)
    expect(cleared.status).toBe(200)
    const repayRef = ((await cleared.json()) as any).repayRef as string
    expect(repayRef).toMatch(/^admin-repay:/)
    expect((await readInvoiceClaim(env, PL))?.ref).toBe(repayRef)

    // A fresh manual pay (no repay_ref) is still refused; only the handed-over ref re-pays.
    expect((await handleAdminPayInvoice(adminPayReq(PL), env)).status).toBe(409)
    up.payStatus = 200
    up.payBody = CAPTURED
    const repay = await handleAdminPayInvoice(adminPayReq(PL, { repay_ref: repayRef }), env)
    expect(repay.status).toBe(200)
    expect(calls.pay).toBe(2)
    // And never a third time with the same ref: the gate is held again.
    expect((await handleAdminPayInvoice(adminPayReq(PL, { repay_ref: repayRef }), env)).status).toBe(409)
    expect(calls.pay).toBe(2)
  })

  it('an unknown manual pay outcome is not clearable right away', async () => {
    const { env } = setup({ payStatus: 502, payBody: { error: 'timeout' } })
    await handleAdminPayInvoice(adminPayReq(PL), env)
    const holder = (await readCoinbaseExecGate(env, PL))!.holder
    expect((await readAdminPayAttempt(env, PL))?.status).toBe('unknown')
    const resp = await handleCoinbaseExecGateClear(gateClearReq(holder), env)
    expect(resp.status).toBe(409)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toBe(holder)
  })

  it('a settled invoice is never cleared for a re-pay', async () => {
    const { env, up } = setup({ payStatus: 400, payBody: { error: 'bad request' } })
    await handleAdminPayInvoice(adminPayReq(PL), env)
    const holder = (await readCoinbaseExecGate(env, PL))!.holder
    up.coinbase = boundCoinbaseLink(PL, '20', { usageCount: 1, maxUsage: 1 })
    expect((await handleCoinbaseExecGateClear(gateClearReq(holder), env)).status).toBe(409)
  })

  it('a clear whose response was lost returns the same unused repay_ref on retry (codex P1 round 1)', async () => {
    const { env, calls } = setup({ payStatus: 400, payBody: { error: 'bad request' } })
    await handleAdminPayInvoice(adminPayReq(PL), env)
    const holder = (await readCoinbaseExecGate(env, PL))!.holder
    const first = (await (await handleCoinbaseExecGateClear(gateClearReq(holder), env)).json()) as any
    expect(first.repayRef).toMatch(/^admin-repay:/)
    const again = await handleCoinbaseExecGateClear(gateClearReq(holder), env)
    expect(again.status).toBe(200)
    const body = (await again.json()) as any
    expect(body.changed).toBe(false)
    expect(body.repayRef).toBe(first.repayRef)
    expect(calls.pay).toBe(1)
  })

  it('once the re-pay ran, a retried clear no longer hands out its ref', async () => {
    const { env, up } = setup({ payStatus: 400, payBody: { error: 'bad request' } })
    await handleAdminPayInvoice(adminPayReq(PL), env)
    const holder = (await readCoinbaseExecGate(env, PL))!.holder
    const { repayRef } = (await (await handleCoinbaseExecGateClear(gateClearReq(holder), env)).json()) as any
    up.payStatus = 200
    up.payBody = CAPTURED
    expect((await handleAdminPayInvoice(adminPayReq(PL, { repay_ref: repayRef }), env)).status).toBe(200)
    // The gate is held by the re-pay now: the old holder no longer matches.
    const retry = await handleCoinbaseExecGateClear(gateClearReq(holder), env)
    expect(retry.status).toBe(409)
  })

  it('an admin-pay gate with no "sent" marker (crash before it) is clearable only once old (codex P1 round 1)', async () => {
    const { env } = setup()
    const ref = 'admin-pay:11111111-2222-3333-4444-555555555555'
    expect((await claimInvoiceKey(env, PL, 'crypto', ref)).ok).toBe(true)
    expect((await acquireCoinbaseExecGate(env, PL, ref, new Date(Date.now() - 5 * 60_000))).ok).toBe(true)
    expect(await readAdminPayAttempt(env, PL)).toBeNull()
    expect((await handleCoinbaseExecGateClear(gateClearReq(ref), env)).status).toBe(409)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toBe(ref)

    const { env: env2, calls: calls2 } = setup()
    expect((await claimInvoiceKey(env2, PL, 'crypto', ref)).ok).toBe(true)
    expect((await acquireCoinbaseExecGate(env2, PL, ref, new Date(Date.now() - 2 * 3600_000))).ok).toBe(true)
    const cleared = await handleCoinbaseExecGateClear(gateClearReq(ref), env2)
    expect(cleared.status).toBe(200)
    const { repayRef } = (await cleared.json()) as any
    expect((await readInvoiceClaim(env2, PL))?.ref).toBe(repayRef)
    expect(calls2.pay).toBe(0)
  })

  it('a malformed repay_ref is rejected before anything is claimed', async () => {
    const { env, calls } = setup()
    const resp = await handleAdminPayInvoice(adminPayReq(PL, { repay_ref: 'admin-pay:guess' }), env)
    expect(resp.status).toBe(400)
    expect(calls.pay).toBe(0)
    expect(await readInvoiceClaim(env, PL)).toBeNull()
  })
})
