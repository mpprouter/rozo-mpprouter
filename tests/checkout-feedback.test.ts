import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  FEEDBACK_PATH,
  feedbackTokenFor,
  withFeedbackToken,
  validateFeedbackText,
  neutraliseForFeishu,
  buildFeedbackNotification,
  inQuietHours,
  handleCheckoutFeedback,
  drainCheckoutFeedbackNotifications,
  NOTIFY_MAX_ATTEMPTS,
} from '../src/routes/checkout-feedback'
import type { MerchantSettlement } from '../src/routes/webhook'

// Real SQLite behind a minimal D1 surface, so UNIQUE / ON CONFLICT / the claim
// UPDATE are exercised by the actual migration, not a hand-rolled fake.
function makeD1() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(new URL('../migrations/0003_checkout_feedback.sql', import.meta.url), 'utf8'))
  const db: any = {
    prepare(q: string) {
      let args: any[] = []
      return {
        bind(...a: any[]) { args = a; return this },
        async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } } },
        async first() { return (sql.prepare(q).get(...args) as any) ?? null },
        async all() { return { results: sql.prepare(q).all(...args) } },
      }
    },
  }
  return { db, sql }
}

const SECRET = 'test-feedback-secret'
const RPID = '11111111-2222-4333-8444-555555555555'
// 2026-10-05 03:00 UTC = 11:00 SGT (outside quiet hours)
const DAY = Date.UTC(2026, 9, 5, 3, 0, 0)
// 2026-10-05 16:00 UTC = 00:00 SGT (quiet hours)
const NIGHT = Date.UTC(2026, 9, 5, 16, 0, 0)

const SETTLED: MerchantSettlement = { found: true, settled: true, status: 'coinbase_v3:PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED', merchant: 'OpenRouter, Inc' }

function env(db: any, extra: Record<string, unknown> = {}) {
  return {
    COUPON_SECURITY_DB: db,
    CHECKOUT_FEEDBACK_TOKEN_SECRET: SECRET,
    FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_ALERT_CHAT_ID: 'c',
    ...extra,
  } as any
}

async function post(e: any, body: unknown, deps: any = {}, ctx?: any) {
  const req = new Request('https://x' + FEEDBACK_PATH, { method: 'POST', body: JSON.stringify(body) })
  const res = await handleCheckoutFeedback(req, e, ctx, { now: () => DAY, resolveSettlement: async () => SETTLED, ...deps })
  return { status: res.status, body: (await res.json()) as any }
}

describe('feedback token', () => {
  it('is deterministic per payment id and differs across ids', async () => {
    const a = await feedbackTokenFor(SECRET, RPID)
    expect(a).toBe(await feedbackTokenFor(SECRET, RPID))
    expect(a).not.toBe(await feedbackTokenFor(SECRET, '11111111-2222-4333-8444-000000000000'))
    expect(await feedbackTokenFor(undefined, RPID)).toBeNull()
  })

  it('withFeedbackToken adds the token to a 200 create-invoice body only', async () => {
    const ok = new Response(JSON.stringify({ rozoPaymentId: RPID, x: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const out = (await (await withFeedbackToken(ok, env(null))).json()) as any
    expect(out.feedbackToken).toBe(await feedbackTokenFor(SECRET, RPID))
    expect(out.x).toBe(1)
    const err = new Response(JSON.stringify({ rozoPaymentId: RPID }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    expect(((await (await withFeedbackToken(err, env(null))).json()) as any).feedbackToken).toBeUndefined()
    const noSecret = new Response(JSON.stringify({ rozoPaymentId: RPID }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    expect(((await (await withFeedbackToken(noSecret, env(null, { CHECKOUT_FEEDBACK_TOKEN_SECRET: '' }))).json()) as any).feedbackToken).toBeUndefined()
  })
})

describe('validateFeedbackText', () => {
  it('trims and accepts 1..1000 chars', () => {
    expect(validateFeedbackText('  Claude Max subscription  ')).toEqual({ ok: true, text: 'Claude Max subscription' })
    expect(validateFeedbackText('好'.repeat(1000)).ok).toBe(true)
  })
  it('rejects blank, too long, markup and control chars', () => {
    expect(validateFeedbackText('   \n ')).toEqual({ ok: false, code: 'EMPTY' })
    expect(validateFeedbackText(undefined)).toEqual({ ok: false, code: 'EMPTY' })
    expect(validateFeedbackText('a'.repeat(1001))).toEqual({ ok: false, code: 'TOO_LONG' })
    expect(validateFeedbackText('<script>alert(1)</script>')).toEqual({ ok: false, code: 'INVALID_TEXT' })
    expect(validateFeedbackText('<at user_id="all"></at>')).toEqual({ ok: false, code: 'INVALID_TEXT' })
    expect(validateFeedbackText('hi‮evil')).toEqual({ ok: false, code: 'INVALID_TEXT' })
  })
  it('rejects sensitive input so the buyer can edit it', () => {
    for (const t of [
      'pay https://payments.coinbase.com/payment-links/pl_01abcdefgh',
      'send to 0x1234567890abcdef1234567890abcdef12345678',
      'my email is a.b@example.com',
      'my seed phrase is ...',
      '我的私钥是',
      'call +1 415 555 0100',
      'coupon 12345678',
    ]) expect(validateFeedbackText(t)).toEqual({ ok: false, code: 'SENSITIVE_INPUT' })
  })
})

describe('notification content', () => {
  it('cannot mention @all or inject <at> tags', () => {
    expect(neutraliseForFeishu('@all <at user_id="all"></at>')).toBe('＠all ‹at user_id="all"›‹/at›')
    const msg = buildFeedbackNotification({
      feedback_id: 'fb_1', payment_id: RPID, merchant: 'OpenRouter, Inc', text: 'Cursor @all', locale: 'zh',
      created_at: DAY, settlement_status: 'coinbase_v3:PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED', settlement_checked_at: DAY,
      notification_status: 'pending', notification_attempts: 0,
    })
    expect(msg).toContain('fb_1')
    expect(msg).toContain(RPID)
    expect(msg).toContain('Cursor ＠all')
    expect(msg).not.toMatch(/@all|<at/)
  })
  it('quiet hours follow 23:00-06:00 Asia/Singapore', () => {
    expect(inQuietHours(DAY)).toBe(false)
    expect(inQuietHours(NIGHT)).toBe(true)
    expect(inQuietHours(Date.UTC(2026, 9, 5, 15, 0))).toBe(true) // 23:00 SGT
    expect(inQuietHours(Date.UTC(2026, 9, 5, 22, 0))).toBe(false) // 06:00 SGT
  })
})

describe('POST checkout-feedback', () => {
  let d: ReturnType<typeof makeD1>
  let token: string
  beforeEach(async () => {
    d = makeD1()
    token = (await feedbackTokenFor(SECRET, RPID))!
  })
  const count = () => (d.sql.prepare('SELECT COUNT(*) AS n FROM checkout_feedback').get() as any).n

  it('saves one row with the order link and a pending notification job', async () => {
    const r = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: ' Claude Pro ', locale: 'zh' })
    expect(r.status).toBe(200)
    expect(r.body.feedback_id).toMatch(/^fb_[0-9a-f]{24}$/)
    const row = d.sql.prepare('SELECT * FROM checkout_feedback').get() as any
    expect(row).toMatchObject({
      payment_id: RPID, text: 'Claude Pro', locale: 'zh', merchant: 'OpenRouter, Inc',
      settlement_status: 'coinbase_v3:PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED', notification_status: 'pending', notification_attempts: 0,
    })
  })

  it('double submit / retry returns the same id and keeps one row', async () => {
    const a = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'one' })
    const b = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'two' })
    expect(b.status).toBe(200)
    expect(b.body).toEqual({ ok: true, feedback_id: a.body.feedback_id, duplicate: true })
    expect(count()).toBe(1)
  })

  it('concurrent submits resolve to one row', async () => {
    const [a, b] = await Promise.all([
      post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'one' }),
      post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'two' }),
    ])
    expect(a.body.feedback_id).toBe(b.body.feedback_id)
    expect(count()).toBe(1)
  })

  it('rejects a bare payment id without a valid token', async () => {
    expect((await post(env(d.db), { rozo_payment_id: RPID, text: 'x' })).status).toBe(400)
    expect((await post(env(d.db), { rozo_payment_id: RPID, feedback_token: 'forged', text: 'x' })).status).toBe(403)
    const other = await feedbackTokenFor(SECRET, '11111111-2222-4333-8444-000000000000')
    expect((await post(env(d.db), { rozo_payment_id: RPID, feedback_token: other, text: 'x' })).status).toBe(403)
    expect(count()).toBe(0)
  })

  it.each([
    'coinbase_v3:PAYMENT_SESSION_STATUS_AUTHORIZED',
    'coinbase_v3:PAYMENT_SESSION_STATUS_PENDING',
    'router:paying',
    'router:missing',
    'stripe_router:provider_submitted',
  ])('refuses unsettled order (%s)', async (status) => {
    const r = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'x' }, {
      resolveSettlement: async () => ({ found: true, settled: false, status, merchant: null }),
    })
    expect(r).toEqual({ status: 409, body: { ok: false, error: 'NOT_SETTLED' } })
    expect(count()).toBe(0)
  })

  it('unknown payment and settlement-check errors save nothing', async () => {
    expect((await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'x' }, {
      resolveSettlement: async () => ({ found: false, settled: false, status: 'rozo:not_found', merchant: null }),
    })).status).toBe(404)
    expect((await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'x' }, {
      resolveSettlement: async () => { throw new Error('boom') },
    })).status).toBe(502)
    expect(count()).toBe(0)
  })

  it('invalid text is rejected with a code and nothing is saved', async () => {
    const r = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: '   ' })
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('EMPTY')
    const s = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'mail me at x@y.io' })
    expect(s.body.error).toBe('SENSITIVE_INPUT')
    expect(count()).toBe(0)
  })

  it('oversized bodies get 413 before any parsing (bytes, not UTF-16 units)', async () => {
    const big = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'a'.repeat(17 * 1024) })
    expect(big.status).toBe(413)
    // 6000 CJK chars = 18 KB of UTF-8 but only 6000 UTF-16 units.
    const cjk = await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: '好'.repeat(6000) })
    expect(cjk.status).toBe(413)
    expect(count()).toBe(0)
  })

  it('is off (503) without DB or secret', async () => {
    expect((await post(env(undefined), { rozo_payment_id: RPID, feedback_token: token, text: 'x' })).status).toBe(503)
    expect((await post(env(d.db, { CHECKOUT_FEEDBACK_TOKEN_SECRET: undefined }), { rozo_payment_id: RPID, feedback_token: token, text: 'x' })).status).toBe(503)
  })

  it('queues an immediate send attempt for a new row only', async () => {
    const waits: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) }
    const send = vi.fn(async () => true)
    await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'x' }, { send }, ctx)
    await Promise.all(waits)
    await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'x' }, { send }, ctx)
    await Promise.all(waits)
    expect(send).toHaveBeenCalledTimes(1)
    expect((d.sql.prepare('SELECT notification_status FROM checkout_feedback').get() as any).notification_status).toBe('sent')
  })
})

describe('notification drain', () => {
  let d: ReturnType<typeof makeD1>
  beforeEach(async () => {
    d = makeD1()
    const token = (await feedbackTokenFor(SECRET, RPID))!
    await post(env(d.db), { rozo_payment_id: RPID, feedback_token: token, text: 'Midjourney' })
  })
  const row = () => d.sql.prepare('SELECT * FROM checkout_feedback').get() as any

  it('sends once with feedback_id as the Feishu dedup uuid, then never again', async () => {
    const send = vi.fn(async () => true)
    expect(await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY, send })).toMatchObject({ sent: 1 })
    expect(await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY + 1e7, send })).toMatchObject({ sent: 0 })
    expect(send).toHaveBeenCalledTimes(1)
    const [, content, opts] = send.mock.calls[0] as any[]
    expect(opts).toEqual({ uuid: row().feedback_id })
    expect(content).toContain('Midjourney')
    expect(row()).toMatchObject({ notification_status: 'sent', notification_attempts: 1 })
  })

  it('failure keeps the feedback, backs off and retries', async () => {
    const fail = vi.fn(async () => false)
    await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY, send: fail })
    expect(row()).toMatchObject({ notification_status: 'failed', notification_attempts: 1, text: 'Midjourney' })
    // Still inside backoff: no new attempt.
    await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY + 1000, send: fail })
    expect(fail).toHaveBeenCalledTimes(1)
    const ok = vi.fn(async () => true)
    await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY + 3 * 60 * 1000, send: ok })
    expect(ok).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ notification_status: 'sent', notification_attempts: 2 })
  })

  it('a thrown send counts as a failure, and gives up after max attempts', async () => {
    const boom = vi.fn(async () => { throw new Error('network') })
    let t = DAY
    for (let i = 0; i < NOTIFY_MAX_ATTEMPTS + 3; i++) {
      await drainCheckoutFeedbackNotifications(env(d.db), { now: () => t, send: boom as any })
      t += 24 * 60 * 60 * 1000 // same SGT hour each day, past any backoff
    }
    expect(boom).toHaveBeenCalledTimes(NOTIFY_MAX_ATTEMPTS)
    expect(row()).toMatchObject({ notification_status: 'abandoned', notification_attempts: NOTIFY_MAX_ATTEMPTS, text: 'Midjourney' })
  })

  it('holds delivery during quiet hours and sends after', async () => {
    const send = vi.fn(async () => true)
    expect(await drainCheckoutFeedbackNotifications(env(d.db), { now: () => NIGHT, send })).toMatchObject({ skipped: 'quiet_hours' })
    expect(row().notification_status).toBe('pending')
    await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY + 86400000, send })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('two concurrent drains claim the row once', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const send = vi.fn(async () => { await gate; return true })
    const a = drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY, send })
    const b = drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY, send })
    await new Promise((r) => setTimeout(r, 10))
    release()
    await Promise.all([a, b])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reclaims a stale `sending` row (crashed attempt)', async () => {
    d.sql.prepare("UPDATE checkout_feedback SET notification_status='sending', notification_claimed_at=?, notification_attempts=1").run(DAY)
    const send = vi.fn(async () => true)
    await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY + 60 * 1000, send })
    expect(send).not.toHaveBeenCalled()
    await drainCheckoutFeedbackNotifications(env(d.db), { now: () => DAY + 6 * 60 * 1000, send })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does nothing when Feishu is not configured', async () => {
    const send = vi.fn(async () => true)
    expect(await drainCheckoutFeedbackNotifications(env(d.db, { FEISHU_APP_ID: '' }), { now: () => DAY, send })).toMatchObject({ skipped: 'feishu_unconfigured' })
    expect(row().notification_status).toBe('pending')
  })
})
