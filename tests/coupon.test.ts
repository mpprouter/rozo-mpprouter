import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  generateCouponCode,
  handleIssueCoupon,
  handleRedeemCoupon,
  handleResolveCoupon,
  handleAdminGetCoupon,
  handleReopenCircuit,
} from '../src/routes/coupon'
import type { Env } from '../src/index'
import { CIRCUIT_THRESHOLD, WARN_THRESHOLD } from '../src/routes/coupon-security'

/** In-memory stand-in for a Cloudflare D1Database (prepare/bind/run + all). */
class FakeD1 {
  rows: any[] = []
  prepare(sql: string) {
    const self = this
    return {
      _sql: sql,
      _args: [] as any[],
      bind(...args: any[]) {
        this._args = args
        return this
      },
      async run() {
        if (/^\s*INSERT/i.test(sql)) {
          const [
            request_id, created_at, result, failure_reason,
            code_hash, payment_id_hash, pair_hash, ip_prefix_hash, turnstile_passed,
          ] = this._args
          // INSERT OR IGNORE: skip on duplicate request_id.
          if (self.rows.some((r) => r.request_id === request_id)) return { success: true }
          self.rows.push({
            request_id, created_at, result, failure_reason,
            code_hash, payment_id_hash, pair_hash, ip_prefix_hash, turnstile_passed,
          })
        } else if (/^\s*DELETE/i.test(sql)) {
          const cutoff = this._args[0]
          self.rows = self.rows.filter((r) => r.created_at >= cutoff)
        }
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

// ── Fakes ────────────────────────────────────────────────────────────────────

/** In-memory stand-in for AtomicStoreDO speaking the /read + /commit protocol. */
class FakeAtomicDO {
  store = new Map<string, { value: string; version: number }>()
  // Real Durable Objects run at most ONE fetch handler at a time; all other
  // concurrent requests queue behind it. The fake must model that, otherwise
  // two concurrent CAS clients can interleave a /read between another's
  // /read and /commit and both "win" — a bypass that cannot happen in prod.
  // Serialize every fetch through a promise chain (single-threaded mutex).
  private tail: Promise<unknown> = Promise.resolve()

  fetch(req: Request): Promise<Response> {
    const run = this.tail.then(() => this._fetch(req))
    // Keep the chain alive even if a handler rejects.
    this.tail = run.catch(() => {})
    return run
  }

  private async _fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const body: any = await req.json()
    const cur = this.store.get(body.key) ?? { value: null as string | null, version: 0 }
    if (url.pathname === '/read') {
      return new Response(JSON.stringify({ value: cur.value, version: cur.version }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.pathname === '/commit') {
      if (cur.version !== body.expectedVersion) {
        return new Response(
          JSON.stringify({ ok: false, value: cur.value, version: cur.version }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (body.op === 'set') {
        this.store.set(body.key, { value: body.value, version: cur.version + 1 })
      } else {
        this.store.delete(body.key)
        this.store.set(body.key, { value: null as any, version: cur.version + 1 })
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
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

class FakeKV {
  store = new Map<string, string>()
  async get(key: string) {
    return this.store.get(key) ?? null
  }
  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

interface UpstreamConfig {
  quoteStatus: number
  quoteBody: any
  payStatus: number
  payBody: any
  balanceHex: string
  /** Test hook: runs (once) when the quote call is made, before it returns. */
  onQuote?: () => Promise<void>
  /**
   * Test hook: when set, every pay-invoice call awaits this promise before
   * returning. Used to hold concurrent redemptions inside their `paying`
   * window simultaneously, so an overlapping funder reservation is genuinely
   * exercised (real pay-invoice takes seconds; the mock is instant otherwise).
   */
  payGate?: Promise<void>
}

function makeEnv(cfg: Partial<UpstreamConfig> = {}) {
  const upstream: UpstreamConfig = {
    quoteStatus: 200,
    quoteBody: { invoice: { amount: '20' }, merchant: 'OpenRouter', linkId: 'pl_test123' },
    payStatus: 200,
    payBody: { ok: true, settled: true },
    // 1000 USDC — plenty of headroom over the $20 test coupon.
    balanceHex: '0x' + (1_000_000_000n).toString(16),
    ...cfg,
  }
  const calls = { quote: 0, pay: 0 }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('quote-invoice')) {
      calls.quote++
      if (upstream.onQuote) {
        const hook = upstream.onQuote
        upstream.onQuote = undefined
        await hook()
      }
      return new Response(JSON.stringify(upstream.quoteBody), {
        status: upstream.quoteStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('pay-invoice')) {
      calls.pay++
      if (upstream.payGate) await upstream.payGate
      return new Response(JSON.stringify(upstream.payBody), {
        status: upstream.payStatus,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('dingtalk')) {
      return new Response('{"errcode":0}', { status: 200 })
    }
    // Anything else is treated as a Base JSON-RPC balance call.
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: upstream.balanceHex }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const d1 = new FakeD1()
  const env = {
    ATOMIC_STORE: new FakeAtomicNamespace() as any,
    MPP_STORE: new FakeKV() as any,
    ADMIN_TOKEN: 'test-coupon-admin',
    PAYINVOICE_ADMIN_SECRET: 'test-pay-secret',
    ADMIN_ENDPOINT_ENABLED: 'true',
    BASE_RPC_URL: 'https://fake-rpc.test',
    COUPON_HASH_SECRET: 'test-hmac-secret',
    COUPON_SECURITY_DB: d1 as any,
    // Turnstile intentionally unset → skipped (staged-rollout posture). The
    // dedicated turnstile describe block sets TURNSTILE_SECRET explicitly.
  } as unknown as Env
  return { env, upstream, calls, fetchMock, d1 }
}

/** Read the coupon record straight from the fake coupon DO (replaces the
 *  removed public /coupon/status probe for state assertions). */
async function couponState(env: Env, code: string): Promise<string | null> {
  const ns = (env as any).ATOMIC_STORE
  const store = ns.get(ns.idFromName('coupon')).store as Map<string, { value: string }>
  const cur = store.get(`coupon:${code}`)
  if (!cur || !cur.value) return null
  return JSON.parse(cur.value).status
}

function issueReq(body: any, secret = 'test-coupon-admin') {
  return new Request('https://router.test/admin/coupon/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify(body),
  })
}

function redeemReq(code: string, url = 'https://payments.coinbase.com/payment-links/pl_test123', ip = '1.2.3.4') {
  return new Request('https://router.test/coupon/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ code, url }),
  })
}

const V3_SESSION_URL =
  'https://payments.coinbase.com/payment-sessions/paymentSession_a5306b93-e4b7-4c28-8799-f991da38bf22'

function resolveReq(body: any, secret = 'test-coupon-admin') {
  return new Request('https://router.test/admin/coupon/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify(body),
  })
}

async function issueCoupon(env: Env, amountUsd = '20'): Promise<string> {
  const resp = await handleIssueCoupon(issueReq({ amountUsd }), env)
  expect(resp.status).toBe(200)
  const body: any = await resp.json()
  expect(body.code).toMatch(/^\d{8}$/)
  return body.code
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.useRealTimers()
})

// ── Code generation ──────────────────────────────────────────────────────────

describe('generateCouponCode', () => {
  it('always returns exactly 8 decimal digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCouponCode()).toMatch(/^\d{8}$/)
    }
  })

  it('is not constant', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCouponCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})

// ── Issue ────────────────────────────────────────────────────────────────────

describe('POST /admin/coupon/issue', () => {
  it('rejects a missing/wrong admin secret', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const resp = await handleIssueCoupon(issueReq({ amountUsd: '20' }, 'wrong'), env)
    expect(resp.status).toBe(401)
  })

  it('rejects garbage and out-of-range amounts', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    for (const amountUsd of ['abc', '-5', '0', '201']) {
      const resp = await handleIssueCoupon(issueReq({ amountUsd }), env)
      expect(resp.status, `amount ${amountUsd}`).toBe(400)
    }
  })

  it('issues an 8-digit code with ~12h default expiry', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const resp = await handleIssueCoupon(issueReq({ amountUsd: '20' }), env)
    expect(resp.status).toBe(200)
    const body: any = await resp.json()
    expect(body.code).toMatch(/^\d{8}$/)
    expect(body.amountUsd).toBe('20')
    // 2026-07-07: claimUrl lets operators hand out a clickable link instead of
    // a bare code (open.rozo.ai/claim resolves ?code= and shows face value).
    // 2026-07-12: dropped utm_source/utm_medium — Goofish is the only channel,
    // so the tags add no signal and just lengthen the link (founder request).
    expect(body.claimUrl).toBe(
      `https://open.rozo.ai/claim?code=${body.code}`,
    )
    const ttlMs = Date.parse(body.expiresAt) - Date.now()
    expect(ttlMs).toBeGreaterThan(11.9 * 3_600_000)
    expect(ttlMs).toBeLessThan(12.1 * 3_600_000)
  })
})

describe('POST /coupon/redeem — Coinbase v3', () => {
  it('accepts a paymentSession URL and forwards its stable id', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env, '20')
    const response = await handleRedeemCoupon(redeemReq(code, V3_SESSION_URL), env)
    expect(response.status).toBe(200)
    expect(((await response.json()) as any).status).toBe('redeemed')
  })
})

// ── Redeem: happy path + idempotency ─────────────────────────────────────────

describe('POST /coupon/redeem', () => {
  it('redeems a valid coupon end-to-end', async () => {
    const { env, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    const resp = await handleRedeemCoupon(redeemReq(code), env)
    const body: any = await resp.json()
    expect(resp.status).toBe(200)
    expect(body.status).toBe('redeemed')
    expect(calls.pay).toBe(1)

    // The atomic funder reservation must be released after completion.
    const doInst = (env.ATOMIC_STORE as any).instances.get('coupon')
    const reserveRaw = doInst.store.get('funder-reserve')?.value
    expect(JSON.parse(reserveRaw).entries).toEqual({})
  })

  it('is idempotent for the same (code, plId) after success', async () => {
    const { env, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    await handleRedeemCoupon(redeemReq(code), env)

    const again = await handleRedeemCoupon(redeemReq(code), env)
    const body: any = await again.json()
    expect(body.status).toBe('redeemed')
    expect(calls.pay).toBe(1) // no second payment
  })

  it('rejects a redeemed coupon presented with a DIFFERENT link (uniform error)', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    await handleRedeemCoupon(redeemReq(code), env)

    const other = await handleRedeemCoupon(
      redeemReq(code, 'https://payments.coinbase.com/payment-links/pl_other456'),
      env,
    )
    expect(other.status).toBe(400)
    const body: any = await other.json()
    expect(body.error).toBe('INVALID_COUPON')
  })

  it('concurrent double-redeem triggers exactly one payment', async () => {
    const { env, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    const [r1, r2] = await Promise.all([
      handleRedeemCoupon(redeemReq(code), env),
      handleRedeemCoupon(redeemReq(code), env),
    ])
    const b1: any = await r1.json()
    const b2: any = await r2.json()
    const statuses = [b1.status, b2.status].sort()
    // One wins the CAS claim and completes; the other sees redeeming/redeemed.
    expect(statuses).toContain('redeemed')
    expect(calls.pay).toBe(1)
  })

  it('returns the uniform INVALID_COUPON for unknown codes', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const resp = await handleRedeemCoupon(redeemReq('00000000'), env)
    expect(resp.status).toBe(400)
    const body: any = await resp.json()
    expect(body.error).toBe('INVALID_COUPON')
  })

  it('rejects an expired coupon with the same uniform error', async () => {
    vi.useFakeTimers()
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    vi.advanceTimersByTime(12 * 3_600_000 + 60_000) // past the 12h default expiry
    const resp = await handleRedeemCoupon(redeemReq(code), env)
    expect(resp.status).toBe(400)
    const body: any = await resp.json()
    expect(body.error).toBe('INVALID_COUPON')
  })

  it('AMOUNT_MISMATCH rolls back to issued and stays redeemable', async () => {
    const { env, upstream, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env, '20')

    upstream.quoteBody = { invoice: { amount: '25' }, merchant: 'OpenRouter', linkId: 'pl_test123' }
    const bad = await handleRedeemCoupon(redeemReq(code), env)
    expect(bad.status).toBe(400)
    const badBody: any = await bad.json()
    expect(badBody.error).toBe('AMOUNT_MISMATCH')
    expect(calls.pay).toBe(0)

    // Fix the link amount → coupon still works.
    upstream.quoteBody = { invoice: { amount: '20' }, merchant: 'OpenRouter', linkId: 'pl_test123' }
    const good = await handleRedeemCoupon(redeemReq(code), env)
    const goodBody: any = await good.json()
    expect(goodBody.status).toBe('redeemed')
    expect(calls.pay).toBe(1)
  })

  it('quote 409 → LINK_USED_OR_EXPIRED, coupon survives', async () => {
    const { env, upstream, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    upstream.quoteStatus = 409
    const resp = await handleRedeemCoupon(redeemReq(code), env)
    expect(resp.status).toBe(409)
    const body: any = await resp.json()
    expect(body.error).toBe('LINK_USED_OR_EXPIRED')
    expect(calls.pay).toBe(0)

    upstream.quoteStatus = 200
    const retry = await handleRedeemCoupon(redeemReq(code), env)
    expect(((await retry.json()) as any).status).toBe('redeemed')
  })

  it('two coupons racing a pool that covers only one: exactly one pays', async () => {
    // Balance $25; two $20 coupons. The atomic check-and-reserve must let
    // exactly one through — the non-atomic read-check-bump this replaces
    // would have let BOTH pass the balance gate.
    const { env, upstream, calls, fetchMock } = makeEnv({
      balanceHex: '0x' + (25_000_000n).toString(16),
    })
    globalThis.fetch = fetchMock
    const codeA = await issueCoupon(env)
    const codeB = await issueCoupon(env)

    // Hold the winner inside its `paying` window (reservation still held) until
    // both requests have raced the funder gate, so the reservation genuinely
    // overlaps — otherwise the mock's instant pay-invoice would let the winner
    // reserve→pay→release before the loser even reserves (sequential, not a race).
    let releasePay: () => void = () => {}
    upstream.payGate = new Promise<void>((r) => { releasePay = r })

    const race = Promise.all([
      handleRedeemCoupon(redeemReq(codeA, undefined, '1.1.1.1'), env),
      handleRedeemCoupon(redeemReq(codeB, undefined, '2.2.2.2'), env),
    ])
    // Give the loser time to hit (and fail) the funder gate while the winner
    // is parked in pay-invoice, then let the winner finish.
    await new Promise((r) => setTimeout(r, 20))
    releasePay()
    const [rA, rB] = await race
    const statuses = [rA.status, rB.status].sort()
    expect(statuses).toEqual([200, 503])
    expect(calls.pay).toBe(1)
  })

  it('insufficient funder balance → 503, coupon rolls back to issued', async () => {
    const { env, calls, fetchMock } = makeEnv({
      balanceHex: '0x' + (5_000_000n).toString(16), // $5 < $20 face value
    })
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    const resp = await handleRedeemCoupon(redeemReq(code), env)
    expect(resp.status).toBe(503)
    expect(calls.pay).toBe(0)

    expect(await couponState(env, code)).toBe('issued')
  })

  it('admin void racing a redeem (during quote) blocks the payment', async () => {
    const { env, upstream, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    // While the redeem request is quoting the invoice, an operator voids the
    // coupon. The request must lose the paying transition and never pay.
    upstream.onQuote = async () => {
      const r = await handleResolveCoupon(resolveReq({ code, action: 'void' }), env)
      expect(r.status).toBe(200)
    }
    const resp = await handleRedeemCoupon(redeemReq(code), env)
    expect(resp.status).toBe(409)
    expect(((await resp.json()) as any).error).toBe('STATE_CHANGED')
    expect(calls.pay).toBe(0)

    // And the coupon stays void.
    const resp2 = await handleRedeemCoupon(redeemReq(code), env)
    expect(resp2.status).toBe(400)
  })

  it('pay-invoice failure parks in manual_review (reported as processing), never auto-retries payment', async () => {
    const { env, upstream, calls, fetchMock } = makeEnv({ payStatus: 502, payBody: { error: 'boom' } })
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    const resp = await handleRedeemCoupon(redeemReq(code), env)
    const body: any = await resp.json()
    expect(body.status).toBe('processing')
    expect(calls.pay).toBe(1)

    // Retrying does NOT trigger another pay-invoice call.
    upstream.payStatus = 200
    const retry = await handleRedeemCoupon(redeemReq(code), env)
    const retryBody: any = await retry.json()
    expect(retryBody.status).toBe('processing')
    expect(calls.pay).toBe(1)

    // Operator resolves: release → issued → redeem works again.
    const rel = await handleResolveCoupon(resolveReq({ code, action: 'release', reason: 'verified no payment' }), env)
    expect(rel.status).toBe(200)
    const final = await handleRedeemCoupon(redeemReq(code), env)
    expect(((await final.json()) as any).status).toBe('redeemed')
    expect(calls.pay).toBe(2)
  })
})

// ── Rate limiting ────────────────────────────────────────────────────────────

describe('public rate limiting', () => {
  it('locks an IP after the hourly budget is spent', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    let got429 = false
    for (let i = 0; i < 25; i++) {
      const resp = await handleRedeemCoupon(redeemReq('99999999', undefined, '9.9.9.9'), env)
      if (resp.status === 429) {
        got429 = true
        expect(i).toBeGreaterThanOrEqual(20) // IP_LIMIT_PER_HOUR
        break
      }
      expect(resp.status).toBe(400)
    }
    expect(got429).toBe(true)
  })

  it('a different IP is unaffected by another IP exhausting its budget', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    for (let i = 0; i < 22; i++) {
      await handleRedeemCoupon(redeemReq('99999999', undefined, '9.9.9.9'), env)
    }
    const resp = await handleRedeemCoupon(redeemReq('99999999', undefined, '8.8.8.8'), env)
    expect(resp.status).toBe(400) // uniform invalid, not 429
  })

  it('locks a code after repeated failed attempts even from fresh IPs', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    // 5 failures from distinct IPs → code locked.
    for (let i = 0; i < 5; i++) {
      await handleRedeemCoupon(redeemReq('12345678', undefined, `10.0.0.${i}`), env)
    }
    // A subsequent redeem for the locked/frozen code returns the uniform 400.
    const resp = await handleRedeemCoupon(redeemReq('12345678', undefined, '10.0.1.1'), env)
    expect(resp.status).toBe(400)
  })
})

// ── Admin resolve/get ────────────────────────────────────────────────────────

describe('admin resolve + get', () => {
  it('void makes a coupon unredeemable', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    await handleResolveCoupon(resolveReq({ code, action: 'void' }), env)
    const resp = await handleRedeemCoupon(redeemReq(code), env)
    expect(resp.status).toBe(400)
  })

  it('mark_redeemed only from in-flight states', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    const resp = await handleResolveCoupon(resolveReq({ code, action: 'mark_redeemed' }), env)
    expect(resp.status).toBe(409) // still `issued` — nothing to confirm
  })

  it('admin get returns the full record including events', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    const resp = await handleAdminGetCoupon(
      new Request(`https://router.test/admin/coupon/get?code=${code}`, {
        headers: { 'x-admin-secret': 'test-coupon-admin' },
      }),
      env,
    )
    expect(resp.status).toBe(200)
    const body: any = await resp.json()
    expect(body.coupon.status).toBe('issued')
    expect(body.coupon.events[0].kind).toBe('issued')
  })
})

// ── Abuse protection: audit, redaction, Turnstile, circuit, freezes ──────────
// (design: ainative/todos/20260722-mpprouter-coupon-claim-security.md)

function redeemReqT(code: string, url: string | undefined, ip: string, turnstileToken?: string) {
  return new Request('https://router.test/coupon/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      code,
      url: url ?? 'https://payments.coinbase.com/payment-links/pl_test123',
      ...(turnstileToken !== undefined ? { turnstileToken } : {}),
    }),
  })
}

describe('redeem audit trail (D1)', () => {
  it('writes exactly one redacted event for EVERY outcome, never plaintext', async () => {
    const { env, d1, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env, '20')

    // success
    await handleRedeemCoupon(redeemReqT(code, undefined, '1.2.3.4'), env)
    // unknown code (failure)
    await handleRedeemCoupon(redeemReqT('00000000', undefined, '1.2.3.5'), env)
    // malformed (no code)
    await handleRedeemCoupon(
      new Request('https://router.test/coupon/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.6' },
        body: JSON.stringify({ url: 'pl_test123' }),
      }),
      env,
    )

    expect(d1.rows.length).toBe(3)
    const results = d1.rows.map((r: any) => r.result).sort()
    expect(results).toEqual(['failure', 'failure', 'success'])

    // No stored row may contain a plaintext code / full payment id / full IP.
    const blob = JSON.stringify(d1.rows)
    expect(blob).not.toContain(code)
    expect(blob).not.toContain('00000000')
    expect(blob).not.toContain('pl_test123')
    expect(blob).not.toContain('1.2.3.4')
    // Digests are 64-hex; ip_prefix_hash always present.
    for (const row of d1.rows) {
      expect(row.ip_prefix_hash).toMatch(/^[0-9a-f]{64}$/)
      expect([0, 1]).toContain(row.turnstile_passed)
    }
  })

  it('fails closed (500) with no plaintext when the HMAC key is unset', async () => {
    const { env, d1, fetchMock } = makeEnv()
    ;(env as any).COUPON_HASH_SECRET = undefined
    globalThis.fetch = fetchMock
    const resp = await handleRedeemCoupon(redeemReqT('12345678', undefined, '1.2.3.4'), env)
    expect(resp.status).toBe(500)
    expect(d1.rows.length).toBe(0) // never audit a plaintext-derivable row
  })
})

describe('redeem Turnstile enforcement', () => {
  function withTurnstile(env: Env, siteverify: any) {
    ;(env as any).TURNSTILE_SECRET = 'sk_test'
    const inner = globalThis.fetch as any
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      if (String(input).includes('turnstile/v0/siteverify')) {
        return new Response(JSON.stringify(siteverify), { status: 200 })
      }
      return inner(input, init)
    }) as any
  }

  it('rejects a redeem with a forged Turnstile token before any payment', async () => {
    const { env, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    withTurnstile(env, { success: false, 'error-codes': ['invalid-input-response'] })

    const resp = await handleRedeemCoupon(redeemReqT(code, undefined, '1.2.3.4', 'forged'), env)
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as any).error).toBe('INVALID_COUPON')
    expect(calls.pay).toBe(0) // never reached payment
  })

  it('records turnstile_passed=1 on a valid token and completes redemption', async () => {
    const { env, d1, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)
    withTurnstile(env, { success: true, action: 'coupon_redeem' })

    const resp = await handleRedeemCoupon(redeemReqT(code, undefined, '1.2.3.4', 'good'), env)
    expect(((await resp.json()) as any).status).toBe('redeemed')
    expect(calls.pay).toBe(1)
    expect(d1.rows.at(-1).turnstile_passed).toBe(1)
  })
})

describe('redeem global circuit breaker', () => {
  it('blocks redemption before any payment once the circuit is open, and audits the rejection', async () => {
    const { env, d1, calls, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    // Drive >CIRCUIT_THRESHOLD malformed POSTs from many IPs to open the circuit.
    for (let i = 0; i <= CIRCUIT_THRESHOLD + 1; i++) {
      await handleRedeemCoupon(
        new Request('https://router.test/coupon/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': `77.0.${Math.floor(i / 250)}.${i % 250}` },
          body: JSON.stringify({ code: '00000000', url: 'pl_nope' }),
        }),
        env,
      )
    }
    // A brand-new valid coupon now cannot pay — circuit is open.
    const code = await issueCoupon(env)
    const before = calls.pay
    const resp = await handleRedeemCoupon(redeemReqT(code, undefined, '9.9.9.9'), env)
    expect(resp.status).toBe(503)
    expect(((await resp.json()) as any).error).toBe('TEMPORARILY_UNAVAILABLE')
    expect(calls.pay).toBe(before) // no payment while open
    // The rejected-while-open request is audited.
    expect(d1.rows.some((r: any) => r.failure_reason === 'circuit_open')).toBe(true)
  })

  it('authenticated admin reopen restores redemption; unauthenticated fails', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    for (let i = 0; i <= CIRCUIT_THRESHOLD + 1; i++) {
      await handleRedeemCoupon(
        new Request('https://router.test/coupon/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': `66.0.${Math.floor(i / 250)}.${i % 250}` },
          body: JSON.stringify({ code: '00000000', url: 'pl_nope' }),
        }),
        env,
      )
    }
    // Unauthenticated reopen is rejected.
    const bad = await handleReopenCircuit(
      new Request('https://router.test/admin/coupon/circuit/reopen', { method: 'POST', headers: { 'x-admin-secret': 'wrong' } }),
      env,
    )
    expect(bad.status).toBe(401)

    // Authenticated reopen clears it.
    const ok = await handleReopenCircuit(
      new Request('https://router.test/admin/coupon/circuit/reopen', { method: 'POST', headers: { 'x-admin-secret': 'test-coupon-admin' } }),
      env,
    )
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as any).wasOpen).toBe(true)

    // Redemption works again.
    const code = await issueCoupon(env)
    const resp = await handleRedeemCoupon(redeemReqT(code, undefined, '9.9.9.9'), env)
    expect(((await resp.json()) as any).status).toBe('redeemed')
  })
})

describe('pair freeze cannot permanently DoS a valid coupon', () => {
  it('5 failed pair attempts freeze temporarily but the coupon survives (not voided)', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env, '20')
    // Attacker submits the SAME (code, wrong-amount link) 5 times → pair fails.
    // Use a link whose quote amount mismatches so each attempt is a real failure
    // that rolls the coupon back to issued (never permanently void).
    ;(env as any).__mismatch = true
    const attackLink = 'https://payments.coinbase.com/payment-links/pl_attack'
    // Point the quote mock at a mismatching amount for the attack link only.
    const inner = globalThis.fetch as any
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      if (String(input).includes('quote-invoice')) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        if (body.payment_id === 'pl_attack') {
          return new Response(JSON.stringify({ invoice: { amount: '999' } }), { status: 200 })
        }
      }
      return inner(input, init)
    }) as any

    for (let i = 0; i < 5; i++) {
      await handleRedeemCoupon(redeemReqT(code, attackLink, `55.0.0.${i}`), env)
    }
    // The pair (code + pl_attack) is now frozen → uniform 400.
    const frozen = await handleRedeemCoupon(redeemReqT(code, attackLink, '55.0.0.9'), env)
    expect(frozen.status).toBe(400)

    // The KEY security property: the identifier freeze is TEMPORARY and does
    // NOT permanently void the victim's coupon. The record is still `issued`
    // (rolled back after every mismatch), never `void`. Only a success, expiry,
    // or an authenticated admin action may permanently void it — an attacker
    // spamming failures cannot.
    globalThis.fetch = fetchMock
    expect(await couponState(env, code)).toBe('issued')

    // And once the temporary freeze lifts (simulated here by clearing the DO
    // freeze counters the way expiry would), the coupon redeems normally with a
    // correct link — the victim is not locked out.
    const ns = (env as any).ATOMIC_STORE
    const store = ns.get(ns.idFromName('coupon')).store as Map<string, unknown>
    for (const k of [...store.keys()]) if (String(k).startsWith('frz:')) store.delete(k)

    const good = await handleRedeemCoupon(redeemReqT(code, undefined, '55.0.9.9'), env)
    expect(((await good.json()) as any).status).toBe('redeemed')
  })
})
