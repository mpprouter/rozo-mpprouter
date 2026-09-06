/**
 * GET /v1/me/sessions — the verified payer's own Stellar payment channels,
 * read from the KV `stellarAgent:<G>` index, the mppx cumulative watermark on
 * the atomic store, and (for counters only) the payer's own D1 rows.
 */
import { describe, expect, it, vi } from 'vitest'
import { channelStatus, handleMeSessions, rawToUsd } from '../src/routes/me'
import type { Env } from '../src/index'

const SECRET = 'test-portal-session-secret-0123456789abcdef'
const PAYER = 'GD5R4HTO5Y22ZNBD2ZZDJHFYN5JDYHDHG3VINLPM2ZU7HCIHUMI2BB4U'
const OTHER = 'GBQ3PXQPXVLZ4CFTPO4M6JLLOEMBVIDKJRRDLFN3IZ4CGJ2PW6ZL2ROT'
const CHANNEL = 'CCW67HXK3W3PJ7WKDPD5FJHDQZQ2QYJZLQ7VUXHVMLGHFYAOJH4FNGMA'

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(payload: Record<string, unknown>): Promise<string> {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64url(JSON.stringify(payload))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)))
  return `${h}.${p}.${b64url(sig)}`
}

async function tokenFor(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ iss: 'x402-dashboard', aud: 'session', sub, rail: 'stellar', iat: now, exp: now + 3600 })
}

function request(token: string): Request {
  return new Request('https://apiserver.mpprouter.dev/v1/me/sessions', { headers: { Authorization: `Bearer ${token}` } })
}

const channelState = (agentAccount: string, depositRaw = '100000000') => ({
  channelContract: CHANNEL,
  commitmentKey: agentAccount,
  agentAccount,
  currency: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  network: 'stellar:pubnet',
  depositRaw,
  openedAt: '2026-09-01T00:00:00.000Z',
})

/** KV holding one agent index entry + one channel record. */
function kv(entries: Record<string, unknown>): Env['MPP_STORE'] {
  return {
    get: vi.fn(async (k: string) => (k in entries ? (typeof entries[k] === 'string' ? entries[k] : JSON.stringify(entries[k])) : null)),
  } as unknown as Env['MPP_STORE']
}

/**
 * Fake ATOMIC_STORE Durable Object namespace speaking the /read protocol of
 * src/mpp/atomic-store-do.ts, so the endpoint exercises the real
 * `stellar:channel:cumulative:<C>` key rather than a stubbed store.
 */
function atomicStore(values: Record<string, unknown>) {
  const keysRead: string[] = []
  const fetchFn = vi.fn(async (req: Request) => {
    const { key } = (await req.json()) as { key: string }
    keysRead.push(key)
    const v = values[key]
    return new Response(JSON.stringify({ value: v === undefined ? null : JSON.stringify(v), version: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const ns = {
    idFromName: vi.fn(() => 'mppx-id'),
    get: vi.fn(() => ({ fetch: fetchFn })),
  } as unknown as Env['ATOMIC_STORE']
  return { ns, keysRead }
}

/** D1 mocked the way tests/me-ledger.test.ts mocks it: prepare→bind→first. */
function d1(row: Record<string, number | null> | null) {
  const first = vi.fn().mockResolvedValue(row)
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn((sql: string) => {
    sqls.push(sql)
    return { bind }
  })
  const sqls: string[] = []
  return { db: { prepare } as unknown as Env['COUPON_SECURITY_DB'], bind, sqls }
}

const CUMULATIVE_KEY = `stellar:channel:cumulative:${CHANNEL}`

function envWith(
  entries: Record<string, unknown>,
  usage: Record<string, number | null> | null = null,
  cumulative: Record<string, unknown> = {},
): Env {
  return {
    PORTAL_SESSION_SECRET: SECRET,
    MPP_STORE: kv(entries),
    ATOMIC_STORE: atomicStore(cumulative).ns,
    COUPON_SECURITY_DB: d1(usage).db,
  } as Env
}

/** The common "this payer owns CHANNEL" KV fixture. */
const ownChannel = (depositRaw?: string) => ({
  [`stellarAgent:${PAYER}`]: CHANNEL,
  [`stellarChannel:${CHANNEL}`]: channelState(PAYER, depositRaw),
})

async function sessionsFrom(env: Env): Promise<Array<Record<string, unknown>>> {
  const res = await handleMeSessions(request(await tokenFor(PAYER)), env)
  expect(res.status).toBe(200)
  return ((await res.json()) as { sessions: Array<Record<string, unknown>> }).sessions
}

describe('GET /v1/me/sessions', () => {
  it('fails closed without a session token', async () => {
    const res = await handleMeSessions(request('not-a-jwt'), envWith({}))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('503s when either channel store is not bound', async () => {
    const noKv = await handleMeSessions(request(await tokenFor(PAYER)), { PORTAL_SESSION_SECRET: SECRET } as Env)
    expect(noKv.status).toBe(503)
    // The cumulative watermark lives on the atomic store, so a missing
    // ATOMIC_STORE must fail closed rather than report every channel unspent.
    const noAtomic = await handleMeSessions(request(await tokenFor(PAYER)), {
      PORTAL_SESSION_SECRET: SECRET,
      MPP_STORE: kv({}),
    } as Env)
    expect(noAtomic.status).toBe(503)
  })

  it('returns an empty list when the payer has no channel', async () => {
    const res = await handleMeSessions(request(await tokenFor(PAYER)), envWith({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, payer: PAYER, sessions: [] })
  })

  it('returns the payer\'s own channel with spend from the mppx cumulative watermark', async () => {
    const env = envWith(
      ownChannel(),
      { calls: 7, last_activity: 1_760_000_000_000 },
      { [CUMULATIVE_KEY]: { amount: '25000000' } },
    )
    const sessions = await sessionsFrom(env)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual({
      session_id: CHANNEL,
      rail: 'stellar',
      status: 'open',
      budget_usd: 10,
      spent_usd: 2.5,
      remaining_usd: 7.5,
      opened_at: '2026-09-01T00:00:00.000Z',
      expires_at: null,
      channel_ref: CHANNEL,
      calls: 7,
      last_activity_at: '2025-10-09T08:53:20.000Z',
    })
  })

  it('never returns a channel funded by a different payer', async () => {
    // A stale/hand-edited index points this payer at someone else's channel.
    const env = envWith(
      { [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(OTHER) },
      { calls: 7, last_activity: 1_760_000_000_000 },
      { [CUMULATIVE_KEY]: { amount: '25000000' } },
    )
    const res = await handleMeSessions(request(await tokenFor(PAYER)), env)
    expect(await res.json()).toEqual({ ok: true, payer: PAYER, sessions: [] })
  })

  it('reads spend from the same cumulative key the spend path uses', async () => {
    const atomic = atomicStore({ [CUMULATIVE_KEY]: { amount: '5000000' } })
    const env = {
      PORTAL_SESSION_SECRET: SECRET,
      MPP_STORE: kv(ownChannel()),
      ATOMIC_STORE: atomic.ns,
    } as Env
    const sessions = await sessionsFrom(env)
    expect(atomic.keysRead).toContain(CUMULATIVE_KEY)
    expect(sessions[0]).toMatchObject({ spent_usd: 0.5, remaining_usd: 9.5 })
  })

  it('reports zero spend when no voucher has ever been accepted', async () => {
    const sessions = await sessionsFrom(envWith(ownChannel(), null, {}))
    expect(sessions[0]).toMatchObject({ spent_usd: 0, remaining_usd: 10, status: 'open' })
  })

  it('scopes the D1 counters to this payer, this channel and calls after it opened', async () => {
    const usage = d1({ calls: 0, last_activity: null })
    const env = {
      PORTAL_SESSION_SECRET: SECRET,
      MPP_STORE: kv(ownChannel()),
      ATOMIC_STORE: atomicStore({}).ns,
      COUPON_SECURITY_DB: usage.db,
    } as Env
    await handleMeSessions(request(await tokenFor(PAYER)), env)
    // Rows from a channel the agent used BEFORE this one must not be counted,
    // so the window starts at this channel's openedAt.
    expect(usage.bind).toHaveBeenCalledWith(PAYER, Date.parse('2026-09-01T00:00:00.000Z'))
    expect(usage.sqls[0]).toContain("'stellar.channel'")
    expect(usage.sqls[0]).toContain('created_at >= ?')
    // The column nothing writes must not be trusted for spend.
    expect(usage.sqls[0]).not.toContain('channel_cursor_after')
  })

  it('reports a never-used channel as fully remaining with no activity', async () => {
    const env = envWith(ownChannel(), { calls: 0, last_activity: null }, {})
    const sessions = await sessionsFrom(env)
    expect(sessions[0]).toMatchObject({ spent_usd: 0, remaining_usd: 10, status: 'open', calls: 0, last_activity_at: null })
  })

  it('maps a drained channel to closed and never below zero remaining', async () => {
    const env = envWith(
      ownChannel('10000000'),
      { calls: 40, last_activity: 1_760_000_000_000 },
      { [CUMULATIVE_KEY]: { amount: '12000000' } },
    )
    const sessions = await sessionsFrom(env)
    expect(sessions[0]).toMatchObject({ status: 'closed', remaining_usd: 0, spent_usd: 1.2 })
  })

  it('still reports real spend when the usage database is unbound', async () => {
    // Spend does not depend on D1 at all; only the two counters do.
    const env = {
      PORTAL_SESSION_SECRET: SECRET,
      MPP_STORE: kv(ownChannel()),
      ATOMIC_STORE: atomicStore({ [CUMULATIVE_KEY]: { amount: '25000000' } }).ns,
    } as Env
    const sessions = await sessionsFrom(env)
    expect(sessions[0]).toMatchObject({ budget_usd: 10, spent_usd: 2.5, remaining_usd: 7.5, calls: 0, last_activity_at: null })
  })

  it('never leaks prompts, routes or query strings', async () => {
    const env = envWith(
      ownChannel(),
      { calls: 1, last_activity: 1_760_000_000_000 },
      { [CUMULATIVE_KEY]: { amount: '1' } },
    )
    const text = await (await handleMeSessions(request(await tokenFor(PAYER)), env)).text()
    for (const k of ['prompt', 'messages', 'route_id', 'query', 'model']) expect(text).not.toContain(k)
  })
})

describe('rawToUsd / channelStatus', () => {
  it('converts 7-decimal base units and treats junk as zero', () => {
    expect(rawToUsd('10000000')).toBe(1)
    expect(rawToUsd('1')).toBeCloseTo(0.0000001, 9)
    expect(rawToUsd(null)).toBe(0)
    expect(rawToUsd('not-a-number')).toBe(0)
  })

  it('is open only while funds remain', () => {
    expect(channelStatus(0.01)).toBe('open')
    expect(channelStatus(0)).toBe('closed')
  })
})
