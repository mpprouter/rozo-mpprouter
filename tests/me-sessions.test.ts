/**
 * GET /v1/me/sessions — the verified payer's own Stellar payment channels,
 * read from the KV `stellarAgent:<G>` index plus the payer's D1 rows.
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

/** D1 mocked the way tests/me-ledger.test.ts mocks it: prepare→bind→first. */
function d1(row: Record<string, number | null> | null) {
  const first = vi.fn().mockResolvedValue(row)
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind }))
  return { db: { prepare } as unknown as Env['COUPON_SECURITY_DB'], bind }
}

function envWith(entries: Record<string, unknown>, usage: Record<string, number | null> | null = null): Env {
  return { PORTAL_SESSION_SECRET: SECRET, MPP_STORE: kv(entries), COUPON_SECURITY_DB: d1(usage).db } as Env
}

describe('GET /v1/me/sessions', () => {
  it('fails closed without a session token', async () => {
    const res = await handleMeSessions(request('not-a-jwt'), envWith({}))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('503s when the channel store is not bound', async () => {
    const res = await handleMeSessions(request(await tokenFor(PAYER)), { PORTAL_SESSION_SECRET: SECRET } as Env)
    expect(res.status).toBe(503)
  })

  it('returns an empty list when the payer has no channel', async () => {
    const res = await handleMeSessions(request(await tokenFor(PAYER)), envWith({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, payer: PAYER, sessions: [] })
  })

  it('returns the payer\'s own channel with spend from the voucher watermark', async () => {
    const env = envWith(
      { [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(PAYER) },
      { cursor_after: 25_000_000, calls: 7, last_activity: 1_760_000_000_000 },
    )
    const res = await handleMeSessions(request(await tokenFor(PAYER)), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toEqual({
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
      { cursor_after: 25_000_000, calls: 7, last_activity: 1_760_000_000_000 },
    )
    const res = await handleMeSessions(request(await tokenFor(PAYER)), env)
    expect(await res.json()).toEqual({ ok: true, payer: PAYER, sessions: [] })
  })

  it('scopes the D1 lookup to the verified payer', async () => {
    const usage = d1({ cursor_after: 0, calls: 0, last_activity: null })
    const env = {
      PORTAL_SESSION_SECRET: SECRET,
      MPP_STORE: kv({ [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(PAYER) }),
      COUPON_SECURITY_DB: usage.db,
    } as Env
    await handleMeSessions(request(await tokenFor(PAYER)), env)
    expect(usage.bind).toHaveBeenCalledWith(PAYER)
  })

  it('reports a never-used channel as fully remaining with no activity', async () => {
    const env = envWith(
      { [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(PAYER) },
      { cursor_after: null, calls: 0, last_activity: null },
    )
    const body = (await (await handleMeSessions(request(await tokenFor(PAYER)), env)).json()) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(body.sessions[0]).toMatchObject({ spent_usd: 0, remaining_usd: 10, status: 'open', calls: 0, last_activity_at: null })
  })

  it('maps a drained channel to closed and never below zero remaining', async () => {
    const env = envWith(
      { [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(PAYER, '10000000') },
      { cursor_after: 12_000_000, calls: 40, last_activity: 1_760_000_000_000 },
    )
    const body = (await (await handleMeSessions(request(await tokenFor(PAYER)), env)).json()) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(body.sessions[0]).toMatchObject({ status: 'closed', remaining_usd: 0, spent_usd: 1.2 })
  })

  it('still returns the channel when the usage database is unbound', async () => {
    const env = {
      PORTAL_SESSION_SECRET: SECRET,
      MPP_STORE: kv({ [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(PAYER) }),
    } as Env
    const body = (await (await handleMeSessions(request(await tokenFor(PAYER)), env)).json()) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(body.sessions[0]).toMatchObject({ budget_usd: 10, spent_usd: 0, calls: 0 })
  })

  it('never leaks prompts, routes or query strings', async () => {
    const env = envWith(
      { [`stellarAgent:${PAYER}`]: CHANNEL, [`stellarChannel:${CHANNEL}`]: channelState(PAYER) },
      { cursor_after: 1, calls: 1, last_activity: 1_760_000_000_000 },
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
