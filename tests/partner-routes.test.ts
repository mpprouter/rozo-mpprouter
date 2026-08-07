import { describe, it, expect, beforeEach } from 'vitest'
import worker from '../src/index'
import { getOrCreatePartnerByEmail, setPartnerPassword, getPartner } from '../src/routes/partner-store'
import type { Env } from '../src/index'

/**
 * Route-level tests for the partner platform: the tenancy, auth and gating
 * behaviour that the primitives in partner-store.ts cannot enforce on their
 * own. Money mechanics themselves are covered in partner-store.test.ts.
 *
 * These go through `worker.fetch` rather than calling handlers directly, so
 * they also cover the routing and the kill switch — a handler that is correct
 * but unreachable, or reachable when it should be off, is still a bug.
 */

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
      this.store.set(body.key, { value: body.value, version: cur.version + 1 })
      return Response.json({ ok: true })
    }
    return new Response('Not Found', { status: 404 })
  }
}

class FakeNamespace {
  instances = new Map<string, FakeAtomicDO>()
  idFromName(n: string) {
    return n
  }
  get(id: string) {
    if (!this.instances.has(id)) this.instances.set(id, new FakeAtomicDO())
    return this.instances.get(id)!
  }
}

const ADMIN = 'test-admin-token'
const PW = 'correct-horse-42'

let env: Env
let ctx: any

beforeEach(() => {
  env = {
    ATOMIC_STORE: new FakeNamespace(),
    ADMIN_TOKEN: ADMIN,
    COUPON_ENDPOINT_ENABLED: 'true',
    PARTNER_ENDPOINT_ENABLED: 'true',
    PARTNER_SESSION_SECRET: 'unit-test-session-secret',
  } as unknown as Env
  ctx = { waitUntil() {}, passThroughOnException() {} }
})

const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://apiserver.mpprouter.dev${path}`, init), env, ctx)

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

async function seed(email: string, usd: string, password = PW) {
  const p = await getOrCreatePartnerByEmail(env, email)
  await setPartnerPassword(env, p.id, password)
  if (usd !== '0') {
    await postJson(
      '/admin/partner/topup',
      { email, amountUsd: usd, proof: `seed-${email}` },
      { 'x-admin-secret': ADMIN },
    )
  }
  return p.id
}

async function login(email: string, password = PW): Promise<string> {
  const resp = await postJson('/partner/auth/login', { username: email, password })
  expect(resp.status).toBe(200)
  const cookie = resp.headers.get('Set-Cookie')
  expect(cookie).toBeTruthy()
  return cookie!.split(';')[0]
}

// ── Kill switch ──────────────────────────────────────────────────────────────

describe('kill switch', () => {
  it('404s the entire partner surface — pages AND api — when disabled', async () => {
    env = { ...env, PARTNER_ENDPOINT_ENABLED: 'false' } as Env
    for (const p of ['/partner', '/partner/app', '/partner/me', '/partner/coupons']) {
      expect((await call(p)).status, p).toBe(404)
    }
    // A half-open surface (pages up, API down) would look usable and fail
    // exactly where money moves, so both must go together.
    expect((await postJson('/partner/auth/login', { username: 'a@b.c', password: 'x' })).status)
      .toBe(404)
  })
})

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('login', () => {
  it('accepts the right password and sets an HttpOnly session cookie', async () => {
    await seed('e@x.com', '100')
    const resp = await postJson('/partner/auth/login', { username: 'e@x.com', password: PW })
    expect(resp.status).toBe(200)
    const cookie = resp.headers.get('Set-Cookie')!
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
  })

  it('gives byte-identical answers for a wrong password and an unknown user', async () => {
    // Any difference here is an account-existence oracle.
    await seed('e@x.com', '100')
    const wrongPw = await postJson('/partner/auth/login', { username: 'e@x.com', password: 'nope' })
    const unknown = await postJson('/partner/auth/login', { username: 'ghost@x.com', password: 'nope' })
    expect(wrongPw.status).toBe(unknown.status)
    expect(await wrongPw.text()).toBe(await unknown.text())
    expect(wrongPw.headers.get('Set-Cookie')).toBeNull()
  })

  it('locks the account after repeated failures, and the right password stops working too', async () => {
    await seed('e@x.com', '100')
    for (let i = 0; i < 12; i++) {
      await postJson('/partner/auth/login', { username: 'e@x.com', password: `bad${i}` })
    }
    const resp = await postJson('/partner/auth/login', { username: 'e@x.com', password: PW })
    expect(resp.status).not.toBe(200)
    expect(resp.headers.get('Set-Cookie')).toBeNull()
  })

  it('fails closed when the session secret is missing', async () => {
    await seed('e@x.com', '100')
    env = { ...env, PARTNER_SESSION_SECRET: undefined } as Env
    const resp = await postJson('/partner/auth/login', { username: 'e@x.com', password: PW })
    expect(resp.status).toBe(500)
    expect(resp.headers.get('Set-Cookie')).toBeNull()
  })

  it('there is no signup endpoint', async () => {
    for (const p of ['/partner/auth/register', '/partner/register', '/partner/signup']) {
      expect((await postJson(p, { username: 'x@y.z', password: 'p' })).status, p).toBe(404)
    }
  })
})

// ── Session enforcement + tenancy ────────────────────────────────────────────

describe('session and tenancy', () => {
  it('every partner API endpoint refuses an anonymous caller', async () => {
    expect((await call('/partner/me')).status).toBe(401)
    expect((await call('/partner/coupons')).status).toBe(401)
    expect((await postJson('/partner/coupon/issue', { credits: 1, clientKey: 'k' })).status).toBe(401)
  })

  it('rejects a forged cookie', async () => {
    await seed('e@x.com', '100')
    const resp = await call('/partner/me', { headers: { Cookie: 'rozo_partner=forged.value' } })
    expect(resp.status).toBe(401)
  })

  it('one partner cannot see or void another partner’s coupon', async () => {
    const mineEmail = 'me@x.com'
    await seed(mineEmail, '100')
    await seed('you@x.com', '100')
    const yourCookie = await login('you@x.com')
    const issued: any = await (
      await postJson(
        '/partner/coupon/issue',
        { credits: 1, clientKey: 'y1' },
        { Cookie: yourCookie },
      )
    ).json()
    expect(issued.code).toMatch(/^\d{10}$/)

    const myCookie = await login(mineEmail)
    const list: any = await (await call('/partner/coupons', { headers: { Cookie: myCookie } })).json()
    const codes = (list.coupons ?? list).map((c: any) => c.code)
    expect(codes).not.toContain(issued.code)

    const stolen = await postJson(
      `/partner/coupon/${issued.code}/void`,
      { confirm: issued.code.slice(-4) },
      { Cookie: myCookie },
    )
    expect(stolen.status).toBeGreaterThanOrEqual(400)
    // ...and the real owner's balance is untouched by the attempt.
    const yourMe: any = await (await call('/partner/me', { headers: { Cookie: yourCookie } })).json()
    expect(BigInt(yourMe.balanceAtomic)).toBe(98_950_000n) // 100 - 1.05
  })
})

// ── Issue ────────────────────────────────────────────────────────────────────

describe('issue', () => {
  it('converts credits to face value exactly (50 credits -> $52.50)', async () => {
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    const body: any = await (
      await postJson('/partner/coupon/issue', { credits: 50, clientKey: 'k1' }, { Cookie: cookie })
    ).json()
    expect(body.amountUsd).toBe('52.5')
    expect(BigInt(body.balanceAfterAtomic)).toBe(47_500_000n)
  })

  it('402s on insufficient balance and creates no coupon', async () => {
    await seed('e@x.com', '1')
    const cookie = await login('e@x.com')
    const resp = await postJson(
      '/partner/coupon/issue',
      { credits: 50, clientKey: 'k1' },
      { Cookie: cookie },
    )
    expect(resp.status).toBe(402)
    const list: any = await (await call('/partner/coupons', { headers: { Cookie: cookie } })).json()
    expect((list.coupons ?? list).length).toBe(0)
  })

  it('replaying a clientKey does not charge twice', async () => {
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    const a: any = await (
      await postJson('/partner/coupon/issue', { credits: 1, clientKey: 'same' }, { Cookie: cookie })
    ).json()
    const b: any = await (
      await postJson('/partner/coupon/issue', { credits: 1, clientKey: 'same' }, { Cookie: cookie })
    ).json()
    expect(b.code).toBe(a.code)
    const me: any = await (await call('/partner/me', { headers: { Cookie: cookie } })).json()
    expect(BigInt(me.balanceAtomic)).toBe(98_950_000n)
  })
})

// ── Void ─────────────────────────────────────────────────────────────────────

describe('void', () => {
  it('requires the last 4 digits and returns the money on success', async () => {
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    const c: any = await (
      await postJson('/partner/coupon/issue', { credits: 1, clientKey: 'k' }, { Cookie: cookie })
    ).json()

    const wrong = await postJson(
      `/partner/coupon/${c.code}/void`,
      { confirm: '0000' === c.code.slice(-4) ? '1111' : '0000' },
      { Cookie: cookie },
    )
    expect(wrong.status).toBe(400)
    let me: any = await (await call('/partner/me', { headers: { Cookie: cookie } })).json()
    expect(BigInt(me.balanceAtomic)).toBe(98_950_000n) // still debited

    const ok = await postJson(
      `/partner/coupon/${c.code}/void`,
      { confirm: c.code.slice(-4) },
      { Cookie: cookie },
    )
    expect(ok.status).toBe(200)
    me = await (await call('/partner/me', { headers: { Cookie: cookie } })).json()
    expect(BigInt(me.balanceAtomic)).toBe(100_000_000n)
  })
})

// ── Admin ────────────────────────────────────────────────────────────────────

describe('admin endpoints', () => {
  it('reject a missing or wrong admin secret', async () => {
    expect((await postJson('/admin/partner/topup', { email: 'a@b.c', amountUsd: '1', proof: 'p' })).status)
      .toBe(401)
    expect(
      (
        await postJson(
          '/admin/partner/topup',
          { email: 'a@b.c', amountUsd: '1', proof: 'p' },
          { 'x-admin-secret': 'wrong' },
        )
      ).status,
    ).toBe(401)
  })

  it('credit once per proof', async () => {
    await seed('e@x.com', '0')
    for (let i = 0; i < 2; i++) {
      await postJson(
        '/admin/partner/topup',
        { email: 'e@x.com', amountUsd: '100', proof: 'order-1' },
        { 'x-admin-secret': ADMIN },
      )
    }
    const id = (await getPartner(env, (await getOrCreatePartnerByEmail(env, 'e@x.com')).id))!
    expect(BigInt(id.balanceAtomic)).toBe(100_000_000n)
  })
})

// ── Pages ────────────────────────────────────────────────────────────────────

describe('pages', () => {
  it('the explainer states the fee is OpenRouter’s, not ours', async () => {
    const html = await (await call('/partner')).text()
    expect(html).toContain('OpenRouter 收取，非 Rozo')
    expect(html).toContain('1 credit')
  })

  it('no page offers a withdrawal or refund route', async () => {
    for (const p of ['/partner', '/partner/app']) {
      const html = await (await call(p)).text()
      expect(html, p).not.toMatch(/提现|withdraw|退款/i)
    }
  })

  it('the explainer tells the partner how to log in again', async () => {
    const html = await (await call('/partner')).text()
    expect(html).toContain('怎么再次登录')
  })
})
