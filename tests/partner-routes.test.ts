import { describe, it, expect, beforeEach } from 'vitest'
import worker from '../src/index'
import { SESSION_COOKIE, signSession } from '../src/routes/partner-auth'
import {
  getOrCreatePartnerByEmail,
  setPartnerPassword,
  getPartner,
  getPartnerIdByEmail,
} from '../src/routes/partner-store'
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

  it('rejects forged and foreign-signed session cookies', async () => {
    // The first version of this test used the WRONG cookie name, so it only
    // exercised the no-cookie path and gave signature verification zero
    // coverage — a regression accepting any 3-part token would have passed.
    const id = await seed('e@x.com', '100')
    const good = await login('e@x.com')
    const value = good.split('=')[1]
    const [v, payload, sig] = value.split('.')

    const forged = [
      `${SESSION_COOKIE}=v1.${payload}.${sig}xx`, // tampered signature
      `${SESSION_COOKIE}=v1.${btoa(JSON.stringify({ p: id, e: Date.now() + 1e9 }))}.${sig}`, // payload swapped under an old sig
      `${SESSION_COOKIE}=${v}.${payload}`, // truncated, 2 parts
      `${SESSION_COOKIE}=not.a.token`,
    ]
    for (const c of forged) {
      expect((await call('/partner/me', { headers: { Cookie: c } })).status, c.slice(0, 40)).toBe(401)
    }

    // A cookie signed with a DIFFERENT secret must not validate here.
    const otherEnv = { ...env, PARTNER_SESSION_SECRET: 'a-different-secret' } as Env
    const foreign = await signSession('a-different-secret', id, Date.now() + 1e9)
    const resp = await worker.fetch(
      new Request('https://apiserver.mpprouter.dev/partner/me', {
        headers: { Cookie: `${SESSION_COOKIE}=${foreign}` },
      }),
      env,
      ctx,
    )
    expect(resp.status).toBe(401)
    void otherEnv
  })

  it('the genuine cookie still works (guards against the test above passing vacuously)', async () => {
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    expect((await call('/partner/me', { headers: { Cookie: cookie } })).status).toBe(200)
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

    const myBefore: any = await (await call('/partner/me', { headers: { Cookie: myCookie } })).json()
    const stolen = await postJson(
      `/partner/coupon/${issued.code}/void`,
      { confirm: issued.code.slice(-4) },
      { Cookie: myCookie },
    )
    // Exactly 404 — a coupon that is not yours must be indistinguishable from
    // one that does not exist. `>= 400` would also accept a 500, which could
    // mean the store got far enough to touch it.
    expect(stolen.status).toBe(404)

    // The victim keeps their debit...
    const yourMe: any = await (await call('/partner/me', { headers: { Cookie: yourCookie } })).json()
    expect(BigInt(yourMe.balanceAtomic)).toBe(98_950_000n) // 100 - 1.05
    // ...and, the part the earlier assertion missed, the ATTACKER gained
    // nothing. A bug refunding a cross-tenant void into the caller's balance
    // would have passed the victim-side check alone.
    const myAfter: any = await (await call('/partner/me', { headers: { Cookie: myCookie } })).json()
    expect(myAfter.balanceAtomic).toBe(myBefore.balanceAtomic)
    // And the coupon itself is untouched.
    expect((await call('/partner/coupons', { headers: { Cookie: yourCookie } })).status).toBe(200)
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

describe('expiry', () => {
  it('defaults to 14 days', async () => {
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    const b: any = await (
      await postJson('/partner/coupon/issue', { credits: 1, clientKey: 'k' }, { Cookie: cookie })
    ).json()
    const days = (Date.parse(b.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(13.9)
    expect(days).toBeLessThan(14.1)
  })

  it('honours a custom expiry — the field name mismatch made this silently impossible', async () => {
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    for (const field of ['expiresInMinutes', 'expiresMinutes']) {
      const b: any = await (
        await postJson(
          '/partner/coupon/issue',
          { credits: 1, clientKey: `k-${field}`, [field]: 60 },
          { Cookie: cookie },
        )
      ).json()
      const hours = (Date.parse(b.expiresAt) - Date.now()) / 3_600_000
      expect(hours, field).toBeLessThan(1.1)
    }
  })
})

describe('whole cents', () => {
  it('refuses a face value with a sub-cent tail', async () => {
    // 1.005 credits x 1.05 = $1.05525 — no payment UI can produce that, so the
    // coupon would be paid for and unspendable.
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    const a = await postJson(
      '/partner/coupon/issue',
      { credits: 1.005, clientKey: 'k1' },
      { Cookie: cookie },
    )
    expect(a.status).toBe(400)
    const b = await postJson(
      '/partner/coupon/issue',
      { amountUsd: '10.505', clientKey: 'k2' },
      { Cookie: cookie },
    )
    expect(b.status).toBe(400)
    // Nothing was charged.
    const me: any = await (await call('/partner/me', { headers: { Cookie: cookie } })).json()
    expect(BigInt(me.balanceAtomic)).toBe(100_000_000n)
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

describe('partner identifier', () => {
  it('accepts a bare username as well as an email', async () => {
    // The first partner logs in as `earnest`; requiring an @ would make the
    // account uncreatable.
    const r = await postJson(
      '/admin/partner/topup',
      { email: 'earnest', amountUsd: '2.10', proof: 'id-test' },
      { 'x-admin-secret': ADMIN },
    )
    expect(r.status).toBe(200)
    const id = await getPartnerIdByEmail(env, 'earnest')
    expect(id).toBeTruthy()
    expect(BigInt((await getPartner(env, id!))!.balanceAtomic)).toBe(2_100_000n)
  })

  it('still rejects junk that would silently mint a second account', async () => {
    for (const bad of ['', 'a', 'ear nest', 'earnest;drop', '<script>']) {
      const r = await postJson(
        '/admin/partner/topup',
        { email: bad, amountUsd: '1', proof: `junk-${bad}` },
        { 'x-admin-secret': ADMIN },
      )
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
  })
})

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

// ── Passphrase generator ─────────────────────────────────────────────────────

describe('generatePartnerPassword', () => {
  it('produces a readable word-word-NN passphrase', async () => {
    const { generatePartnerPassword } = await import('../src/routes/partner-store')
    for (let i = 0; i < 200; i++) {
      expect(generatePartnerPassword()).toMatch(/^[a-z]+-[a-z]+-\d{2}$/)
    }
  })

  it('is not constant and spreads across the word list', async () => {
    const { generatePartnerPassword } = await import('../src/routes/partner-store')
    const first = new Set(
      Array.from({ length: 400 }, () => generatePartnerPassword().split('-')[0]),
    )
    // A modulus over a 97-word list biases toward the front; a healthy spread
    // is the cheap check that rejection sampling is actually running.
    expect(first.size).toBeGreaterThan(40)
  })

  it('stays readable: plain lowercase words, no whitespace, no confusable digits', async () => {
    // NB: an `l` inside `tulip` is fine — l/1 and O/0 confusion is a problem
    // for isolated random characters, and the whole point of words is that
    // context disambiguates them. What must stay clean is the DIGIT tail,
    // where there is no context to lean on.
    const { generatePartnerPassword } = await import('../src/routes/partner-store')
    for (let i = 0; i < 200; i++) {
      const pw = generatePartnerPassword()
      const [w1, w2, digits] = pw.split('-')
      expect(w1).toMatch(/^[a-z]{3,}$/)
      expect(w2).toMatch(/^[a-z]{3,}$/)
      expect(digits).toMatch(/^[1-9][0-9]$/) // 10-99, never a leading zero
      expect(pw).not.toMatch(/\s/)
    }
  })
})

// ── Founder-facing UI contract ───────────────────────────────────────────────

describe('dashboard copy and controls', () => {
  it('offers 1/5/10/20/50/100 credit quick amounts', async () => {
    const html = await (await call('/partner/app')).text()
    for (const n of [1, 5, 10, 20, 50, 100]) {
      expect(html, `chip ${n}`).toContain(`data-credits="${n}"`)
    }
  })

  it('has no expiry input — 14 days is stated, not configurable', async () => {
    const html = await (await call('/partner/app')).text()
    expect(html).not.toContain('expires-input')
    expect(html).toContain('14 天')
  })

  it('names no contact channel other than the chat widget', async () => {
    // Every "contact us" route is the Intercom launcher now; a stale Telegram
    // handle in one corner of one page is how a partner ends up messaging a
    // channel nobody watches.
    for (const p of ['/partner', '/partner/app']) {
      const html = await (await call(p)).text()
      expect(html, p).not.toMatch(/Telegram|@rozoai/i)
      expect(html, p).toContain('help-fab')
    }
  })

  it('the explainer leads with the customer script and drops the pricing pitch', async () => {
    const html = await (await call('/partner')).text()
    expect(html).toContain('cust-copy')
    expect(html).toContain('open.rozo.ai/claim?code=XXXXXX')
    expect(html).not.toContain('我们不赚差价')
    expect(html).not.toContain('没有注册入口')
    // The customer script must come before the login form: it is what a
    // partner opens this page to fetch.
    expect(html.indexOf('cust-copy')).toBeLessThan(html.indexOf('login-form'))
  })
})

// ── coupon.rozo.ai root ──────────────────────────────────────────────────────

describe('coupon.rozo.ai root', () => {
  const at = (host: string, path: string) =>
    worker.fetch(new Request(`https://${host}${path}`), env, ctx)

  it('redirects the bare domain to the partner backend', async () => {
    const resp = await at('coupon.rozo.ai', '/')
    expect(resp.status).toBe(302)
    expect(new URL(resp.headers.get('Location')!).pathname).toBe('/partner')
  })

  it('leaves apiserver.mpprouter.dev alone', async () => {
    // The API hostname must keep serving its own index; redirecting it would
    // point integrators at a page that means nothing to them.
    const resp = await at('apiserver.mpprouter.dev', '/')
    expect(resp.status).not.toBe(302)
  })

  it('does not touch anything below the root on coupon.rozo.ai', async () => {
    // A blanket redirect here would swallow /partner/auth/login, which the
    // login form posts to from this very origin.
    expect((await at('coupon.rozo.ai', '/partner')).status).toBe(200)
    expect((await at('coupon.rozo.ai', '/health')).status).toBe(200)
  })
})

// ── Suspension ───────────────────────────────────────────────────────────────

describe('partner status', () => {
  it('suspends an account: no login, and an existing session stops working', async () => {
    // Nothing could set this field before, so a partner could not be turned
    // off at all — a real gap for a system holding balances.
    await seed('e@x.com', '100')
    const cookie = await login('e@x.com')
    expect((await call('/partner/me', { headers: { Cookie: cookie } })).status).toBe(200)

    const r = await postJson(
      '/admin/partner/status',
      { email: 'e@x.com', status: 'suspended' },
      { 'x-admin-secret': ADMIN },
    )
    expect(r.status).toBe(200)

    // The live cookie is cut off too, not just new logins.
    expect((await call('/partner/me', { headers: { Cookie: cookie } })).status).toBe(403)
    const relogin = await postJson('/partner/auth/login', { username: 'e@x.com', password: PW })
    expect(relogin.status).not.toBe(200)
    expect((await postJson(
      '/partner/coupon/issue',
      { credits: 1, clientKey: 'k' },
      { Cookie: cookie },
    )).status).toBeGreaterThanOrEqual(400)
  })

  it('keeps the balance and history — the books still have to reconcile', async () => {
    const id = await seed('e@x.com', '100')
    await postJson('/admin/partner/status', { email: 'e@x.com', status: 'suspended' }, { 'x-admin-secret': ADMIN })
    expect(BigInt((await getPartner(env, id))!.balanceAtomic)).toBe(100_000_000n)
  })

  it('is reversible', async () => {
    await seed('e@x.com', '100')
    await postJson('/admin/partner/status', { email: 'e@x.com', status: 'suspended' }, { 'x-admin-secret': ADMIN })
    await postJson('/admin/partner/status', { email: 'e@x.com', status: 'active' }, { 'x-admin-secret': ADMIN })
    expect((await postJson('/partner/auth/login', { username: 'e@x.com', password: PW })).status).toBe(200)
  })

  it('refuses an unknown partner rather than creating one', async () => {
    // topup and login-link create on first use; flipping the state of something
    // that does not exist is a typo, not an intent.
    const r = await postJson(
      '/admin/partner/status',
      { email: 'ghost', status: 'suspended' },
      { 'x-admin-secret': ADMIN },
    )
    expect(r.status).toBe(404)
    expect(await getPartnerIdByEmail(env, 'ghost')).toBeNull()
  })

  it('needs the admin secret and a valid status', async () => {
    await seed('e@x.com', '100')
    expect((await postJson('/admin/partner/status', { email: 'e@x.com', status: 'suspended' })).status).toBe(401)
    expect((await postJson('/admin/partner/status', { email: 'e@x.com', status: 'banana' }, { 'x-admin-secret': ADMIN })).status).toBe(400)
  })
})

// ── Customer message template ────────────────────────────────────────────────

describe('customer message', () => {
  it('names both the credits and the dollars, and carries no expiry line', async () => {
    // The buyer picks a package by credits inside OpenRouter, but the link has
    // to come out at an exact dollar figure. Giving one number without the
    // other is what produces a link that misses by a few cents.
    const js = await (await call('/partner/app')).text()
    expect(js).toContain("credits + '积分（$' + face + '）'")
    expect(js).toContain("'1. 在 OpenRouter 里生成一条 ' + amountPhrase + ' 的支付链接'")
    expect(js).not.toContain('有效期至')
    expect(js).not.toContain('过期后失效')
  })

  it('falls back to dollars-only when a coupon was issued by amount', async () => {
    // Those carry no credits figure; "null积分" would be worse than saying
    // nothing about credits at all.
    const js = await (await call('/partner/app')).text()
    expect(js).toContain("'金额正好是 $' + face")
  })
})

// ── Transport security ───────────────────────────────────────────────────────

describe('https enforcement', () => {
  const at = (u: string, init: RequestInit = {}) => worker.fetch(new Request(u, init), env, ctx)

  it('never serves the login page over plaintext http', async () => {
    // This shipped broken: http://coupon.rozo.ai/partner returned the full
    // login form, password field and all. The browser calls it "not secure",
    // a submitted password crosses the wire in the clear, and the Secure
    // session cookie is never set — so it is insecure AND non-functional.
    const resp = await at('http://coupon.rozo.ai/partner')
    expect(resp.status).toBe(301)
    const loc = new URL(resp.headers.get('Location')!)
    expect(loc.protocol).toBe('https:')
    expect(loc.pathname).toBe('/partner')
  })

  it('upgrades the scheme before doing anything else, including the root redirect', async () => {
    // The root redirect used to inherit the request scheme, so the bare domain
    // actively forwarded people TO the plaintext page.
    const resp = await at('http://coupon.rozo.ai/')
    expect(resp.status).toBe(301)
    expect(new URL(resp.headers.get('Location')!).protocol).toBe('https:')
  })

  it('preserves the path and query when upgrading', async () => {
    const resp = await at('http://coupon.rozo.ai/partner/auth/callback?token=abc')
    const loc = new URL(resp.headers.get('Location')!)
    expect(loc.protocol).toBe('https:')
    expect(loc.pathname).toBe('/partner/auth/callback')
    expect(loc.searchParams.get('token')).toBe('abc')
  })

  it('sends HSTS on every partner response, including errors', async () => {
    for (const p of ['/partner', '/partner/app', '/partner/me', '/partner/nope']) {
      const resp = await at(`https://coupon.rozo.ai${p}`)
      expect(resp.headers.get('Strict-Transport-Security'), p).toBe('max-age=31536000')
    }
  })

  it('does not claim includeSubDomains', async () => {
    // That would commit every rozo.ai subdomain to HTTPS-only.
    const h = (await at('https://coupon.rozo.ai/partner')).headers.get('Strict-Transport-Security')!
    expect(h).not.toMatch(/includeSubDomains/i)
  })

  it('leaves apiserver.mpprouter.dev on http alone', async () => {
    // A 301 turns a POST into a GET in some clients; that hostname has
    // integrators whose requests must not be silently mangled.
    const resp = await at('http://apiserver.mpprouter.dev/health')
    expect(resp.status).toBe(200)
  })
})
