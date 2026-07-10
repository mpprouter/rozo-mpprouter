import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  generateCouponCode,
  handleIssueCoupon,
  handleRedeemCoupon,
  handleCouponStatus,
  handleResolveCoupon,
  handleAdminGetCoupon,
} from '../src/routes/coupon'
import type { Env } from '../src/index'

// ── Fakes ────────────────────────────────────────────────────────────────────

/** In-memory stand-in for AtomicStoreDO speaking the /read + /commit protocol. */
class FakeAtomicDO {
  store = new Map<string, { value: string; version: number }>()

  async fetch(req: Request): Promise<Response> {
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
  const env = {
    ATOMIC_STORE: new FakeAtomicNamespace() as any,
    MPP_STORE: new FakeKV() as any,
    ADMIN_TOKEN: 'test-coupon-admin',
    PAYINVOICE_ADMIN_SECRET: 'test-pay-secret',
    ADMIN_ENDPOINT_ENABLED: 'true',
    BASE_RPC_URL: 'https://fake-rpc.test',
  } as unknown as Env
  return { env, upstream, calls, fetchMock }
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

function statusReq(code: string, ip = '1.2.3.4') {
  return new Request(`https://router.test/coupon/status?code=${code}`, {
    method: 'GET',
    headers: { 'cf-connecting-ip': ip },
  })
}

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
    // 2026-07-07: claimUrl lets operators hand out a clickable prefill link
    // instead of a bare code (open.rozo.ai/claim reads ?code= into the pin field).
    expect(body.claimUrl).toBe(`https://open.rozo.ai/claim?code=${body.code}`)
    const ttlMs = Date.parse(body.expiresAt) - Date.now()
    expect(ttlMs).toBeGreaterThan(11.9 * 3_600_000)
    expect(ttlMs).toBeLessThan(12.1 * 3_600_000)
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
    const { env, calls, fetchMock } = makeEnv({
      balanceHex: '0x' + (25_000_000n).toString(16),
    })
    globalThis.fetch = fetchMock
    const codeA = await issueCoupon(env)
    const codeB = await issueCoupon(env)

    const [rA, rB] = await Promise.all([
      handleRedeemCoupon(redeemReq(codeA, undefined, '1.1.1.1'), env),
      handleRedeemCoupon(redeemReq(codeB, undefined, '2.2.2.2'), env),
    ])
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

    const st = await handleCouponStatus(statusReq(code), env)
    expect(((await st.json()) as any).status).toBe('issued')
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
    // Now issue can't be probed: even the status endpoint sees it as invalid.
    const st = await handleCouponStatus(statusReq('12345678', '10.0.1.1'), env)
    expect(st.status).toBe(400)
  })
})

// ── Status endpoint ──────────────────────────────────────────────────────────

describe('GET /coupon/status', () => {
  it('shows issued state for a valid code, uniform error for unknown', async () => {
    const { env, fetchMock } = makeEnv()
    globalThis.fetch = fetchMock
    const code = await issueCoupon(env)

    const ok = await handleCouponStatus(statusReq(code), env)
    const okBody: any = await ok.json()
    expect(okBody.status).toBe('issued')
    expect(okBody.amountUsd).toBe('20')

    const missing = await handleCouponStatus(statusReq('00000001'), env)
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as any).error).toBe('INVALID_COUPON')
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
