import { describe, it, expect } from 'vitest'
import {
  SITE_NOTICE_ADMIN_PATH,
  SITE_NOTICE_KEY,
  SITE_NOTICE_PATH,
  handleSiteNotice,
  handleSiteNoticeAdmin,
  validateNotice,
} from '../src/routes/site-notice'

const SECRET = 'test-control-secret'
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)

function makeEnv(extra: Record<string, unknown> = {}) {
  const kv = new Map<string, string>()
  const env: any = {
    CHECKOUT_CONTROL_SECRET: SECRET,
    MPP_STORE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    },
    ...extra,
  }
  return { env, kv }
}

const MAINTENANCE = {
  id: 'openrouter-maintenance-20261101',
  sites: ['checkout', 'upi'],
  starts_at: '2026-10-31T00:00:00Z',
  ends_at: '2026-11-01T22:00:00Z',
  message: { en: 'OpenRouter maintenance.', zh: 'OpenRouter 维护。' },
  link_url: 'https://openrouter.ai/',
  link_label: { en: 'Learn more' },
}

async function admin(env: any, body: unknown, secret = SECRET) {
  const req = new Request('https://x' + SITE_NOTICE_ADMIN_PATH, {
    method: 'POST',
    headers: { 'x-admin-secret': secret },
    body: JSON.stringify(body),
  })
  const res = await handleSiteNoticeAdmin(req, env, () => NOW)
  return { status: res.status, body: (await res.json()) as any }
}

async function pub(env: any, site: string, at = NOW) {
  const res = await handleSiteNotice(new Request(`https://x${SITE_NOTICE_PATH}?site=${site}`), env, () => at)
  return { status: res.status, cache: res.headers.get('cache-control'), body: (await res.json()) as any }
}

describe('site notice admin', () => {
  it('rejects a missing or wrong secret', async () => {
    const { env } = makeEnv()
    expect((await admin(env, { action: 'clear', actor: 'a', reason: 'r' }, 'nope')).status).toBe(401)
    const { env: unset } = makeEnv({ CHECKOUT_CONTROL_SECRET: undefined })
    expect((await admin(unset, { action: 'clear', actor: 'a', reason: 'r' })).status).toBe(500)
  })

  it('requires actor and reason', async () => {
    const { env } = makeEnv()
    expect((await admin(env, { action: 'set', notices: [MAINTENANCE] })).status).toBe(400)
  })

  it('sets, then clears', async () => {
    const { env, kv } = makeEnv()
    const set = await admin(env, { action: 'set', notices: [MAINTENANCE], actor: 'claude', reason: 'OR maintenance' })
    expect(set.status).toBe(200)
    expect(JSON.parse(kv.get(SITE_NOTICE_KEY)!).notices[0].ends_at).toBe('2026-11-01T22:00:00.000Z')
    const clear = await admin(env, { action: 'clear', actor: 'claude', reason: 'done' })
    expect(clear.status).toBe(200)
    expect(clear.body.before.notices).toHaveLength(1)
    expect(JSON.parse(kv.get(SITE_NOTICE_KEY)!).notices).toEqual([])
  })

  it('validates notices', () => {
    expect(typeof validateNotice({ ...MAINTENANCE, link_url: 'http://openrouter.ai' })).toBe('string')
    expect(typeof validateNotice({ ...MAINTENANCE, link_url: 'javascript:alert(1)' })).toBe('string')
    expect(typeof validateNotice({ ...MAINTENANCE, sites: ['rescue'] })).toBe('string')
    expect(typeof validateNotice({ ...MAINTENANCE, message: { zh: 'x' } })).toBe('string')
    expect(typeof validateNotice({ ...MAINTENANCE, ends_at: MAINTENANCE.starts_at })).toBe('string')
    expect(typeof validateNotice({ ...MAINTENANCE, id: 'Bad Id' })).toBe('string')
    expect(typeof validateNotice(MAINTENANCE)).toBe('object')
  })
})

describe('public site notice', () => {
  it('returns only notices live now for the site', async () => {
    const { env } = makeEnv()
    await admin(env, {
      action: 'set',
      actor: 'claude',
      reason: 't',
      notices: [MAINTENANCE, { ...MAINTENANCE, id: 'upi-only', sites: ['upi'] }],
    })
    const checkout = await pub(env, 'checkout')
    expect(checkout.status).toBe(200)
    expect(checkout.cache).toBe('public, max-age=60')
    expect(checkout.body.notices.map((n: any) => n.id)).toEqual(['openrouter-maintenance-20261101'])
    expect((await pub(env, 'upi')).body.notices).toHaveLength(2)
    // After ends_at nothing is served.
    expect((await pub(env, 'checkout', Date.UTC(2026, 10, 1, 22, 0, 0))).body.notices).toEqual([])
    // Before starts_at nothing is served.
    expect((await pub(env, 'checkout', Date.UTC(2026, 9, 30))).body.notices).toEqual([])
  })

  it('rejects unknown sites and answers empty when nothing is stored', async () => {
    const { env } = makeEnv()
    expect((await pub(env, 'rescue')).status).toBe(400)
    expect((await pub(env, 'checkout')).body.notices).toEqual([])
  })

  it('answers empty instead of failing when the store errors', async () => {
    const { env } = makeEnv()
    env.MPP_STORE.get = async () => {
      throw new Error('kv down')
    }
    const r = await pub(env, 'checkout')
    expect(r.status).toBe(200)
    expect(r.cache).toBe('no-store')
    expect(r.body.notices).toEqual([])
  })
})
