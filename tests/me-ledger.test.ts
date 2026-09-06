/**
 * GET /v1/me/ledger and /v1/me/usage — per-payer LLM usage for the x402
 * dashboard, gated on the dashboard's HS256 session JWT.
 */
import { describe, expect, it, vi } from 'vitest'
import { handleMeLedger, handleMeUsage, normalizeSettlementRef, toMeRow, verifyPortalSession } from '../src/routes/me'
import type { Env } from '../src/index'

const SECRET = 'test-portal-session-secret-0123456789abcdef'
const PAYER = 'GD5R4HTO5Y22ZNBD2ZZDJHFYN5JDYHDHG3VINLPM2ZU7HCIHUMI2BB4U'

function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(payload: Record<string, unknown>, secret = SECRET, alg = 'HS256'): Promise<string> {
  const h = b64url(JSON.stringify({ alg, typ: 'JWT' }))
  const p = b64url(JSON.stringify(payload))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)))
  return `${h}.${p}.${b64url(sig)}`
}

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return { iss: 'x402-dashboard', aud: 'session', sub: PAYER, rail: 'stellar', iat: now, exp: now + 3600, ...overrides }
}

function request(path: string, token: string): Request {
  return new Request(`https://apiserver.mpprouter.dev${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

const facadeRow = (i: number, extra: Record<string, unknown> = {}) => ({
  event_id: `evt_${i}`,
  request_id: `req_${i}`,
  created_at: 1_760_000_000_000 - i * 1000,
  wallet_address: PAYER,
  requested_model: 'claude-sonnet-5',
  actual_model: 'claude-sonnet-5',
  provider: 'anthropic',
  input_tokens: 1200,
  output_tokens: 300,
  cached_tokens: 0,
  quoted_amount_usd: '0.0123',
  settlement_ref: 'a'.repeat(64),
  channel_cursor_after: null,
  status: 'settled',
  ...extra,
})

describe('verifyPortalSession', () => {
  it('accepts a valid HS256 token from the dashboard', async () => {
    const token = await sign(claims())
    const s = await verifyPortalSession(request('/v1/me/ledger', token), { PORTAL_SESSION_SECRET: SECRET } as Env)
    expect(s).toEqual({ payer: PAYER, rail: 'stellar' })
  })

  it('rejects a bad signature, wrong issuer, wrong audience, expiry and missing secret', async () => {
    const env = { PORTAL_SESSION_SECRET: SECRET } as Env
    expect(await verifyPortalSession(request('/x', await sign(claims(), 'another-secret-that-is-long-enough-000')), env)).toBeNull()
    expect(await verifyPortalSession(request('/x', await sign(claims({ iss: 'someone-else' }))), env)).toBeNull()
    expect(await verifyPortalSession(request('/x', await sign(claims({ aud: 'nonce' }))), env)).toBeNull()
    expect(await verifyPortalSession(request('/x', await sign(claims({ exp: 1 }))), env)).toBeNull()
    expect(await verifyPortalSession(request('/x', await sign(claims({ sub: '' }))), env)).toBeNull()
    expect(await verifyPortalSession(request('/x', await sign(claims(), SECRET, 'none')), env)).toBeNull()
    expect(await verifyPortalSession(request('/x', await sign(claims())), {} as Env)).toBeNull()
  })
})

describe('GET /v1/me/ledger', () => {
  it('fails closed without a session', async () => {
    const res = await handleMeLedger(request('/v1/me/ledger', 'nope'), { PORTAL_SESSION_SECRET: SECRET } as Env)
    expect(res.status).toBe(401)
  })

  it('returns this payer\'s rows newest-first with tokens and a cursor', async () => {
    const rows = [facadeRow(0), facadeRow(1), facadeRow(2)]
    const all = vi.fn().mockResolvedValue({ results: rows })
    const bind = vi.fn(() => ({ all }))
    const db = { prepare: vi.fn(() => ({ bind })) }
    const env = { PORTAL_SESSION_SECRET: SECRET, COUPON_SECURITY_DB: db } as unknown as Env

    const res = await handleMeLedger(request('/v1/me/ledger?limit=2', await sign(claims())), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.payer).toBe(PAYER)
    expect(body.rows).toHaveLength(2)
    expect(body.next_cursor).toBe(`${rows[1].created_at}:evt_1`)
    expect(body.rows[0]).toMatchObject({
      order_id: 'evt_0',
      route_id: 'anthropic/claude-sonnet-5',
      payer: PAYER,
      amount_usd: 0.0123,
      settlement_ref: 'a'.repeat(64),
      upstream_status: 200,
      input_tokens: 1200,
      output_tokens: 300,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      rail: 'stellar',
      mode: 'x402-exact',
    })
    // The query is scoped to the authenticated wallet, never a caller-supplied one.
    expect(bind.mock.calls[0][0]).toBe(PAYER)
    expect(bind.mock.calls[0][4]).toBe(3) // limit + 1 to detect the next page
    expect(String(db.prepare.mock.calls[0][0])).toContain(
      'WHERE wallet_address = ? AND (created_at < ? OR (created_at = ? AND event_id < ?))',
    )
  })

  it('pages on (created_at, event_id) so same-millisecond rows are not skipped', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const bind = vi.fn(() => ({ all }))
    const db = { prepare: vi.fn(() => ({ bind })) }
    const env = { PORTAL_SESSION_SECRET: SECRET, COUPON_SECURITY_DB: db } as unknown as Env
    const token = await sign(claims())

    expect((await handleMeLedger(request('/v1/me/ledger?cursor=1760000000000:evt_7', token), env)).status).toBe(200)
    expect(bind.mock.calls[0].slice(0, 4)).toEqual([PAYER, 1_760_000_000_000, 1_760_000_000_000, 'evt_7'])
    // First-release cursors (bare timestamp) still work.
    expect((await handleMeLedger(request('/v1/me/ledger?cursor=1760000000000', token), env)).status).toBe(200)
    expect(bind.mock.calls[1].slice(0, 4)).toEqual([PAYER, 1_760_000_000_000, 1_760_000_000_000, ''])
  })

  it('validates limit and cursor', async () => {
    const env = { PORTAL_SESSION_SECRET: SECRET, COUPON_SECURITY_DB: {} } as unknown as Env
    const token = await sign(claims())
    expect((await handleMeLedger(request('/v1/me/ledger?limit=0', token), env)).status).toBe(400)
    expect((await handleMeLedger(request('/v1/me/ledger?cursor=abc', token), env)).status).toBe(400)
    expect((await handleMeLedger(request('/v1/me/ledger?cursor=0:evt', token), env)).status).toBe(400)
    expect((await handleMeLedger(request('/v1/me/ledger?cursor=123:', token), env)).status).toBe(400)
  })
})

describe('toMeRow', () => {
  it('maps status, mode and unsettled amounts', () => {
    const session = { payer: PAYER, rail: 'stellar' as const }
    expect(toMeRow(facadeRow(0, { status: 'failed' }) as any, session)).toMatchObject({ upstream_status: 502, amount_usd: 0 })
    expect(toMeRow(facadeRow(0, { status: 'passthrough' }) as any, session).amount_usd).toBe(0)
    // Explicit payment method recorded by the proxy wins over any inference.
    expect(toMeRow(facadeRow(0, { payment_method: 'stellar.channel' }) as any, session).mode).toBe('session')
    expect(toMeRow(facadeRow(0, { payment_method: 'stellar.charge' }) as any, session).mode).toBe('mpp-charge')
    expect(toMeRow(facadeRow(0, { payment_method: 'stellar.x402', settlement_ref: 'rcpt' }) as any, session).mode).toBe('x402-exact')
    // Rows from before the method was recorded fall back to the reference shape.
    expect(toMeRow(facadeRow(0, { channel_cursor_after: '5' }) as any, session).mode).toBe('session')
    expect(toMeRow(facadeRow(0, { settlement_ref: 'mpp-credential-id' }) as any, session).mode).toBe('mpp-charge')
    expect(toMeRow(facadeRow(0, { input_tokens: null, output_tokens: null }) as any, session)).toMatchObject({
      input_tokens: null,
      output_tokens: null,
    })
  })
})

describe('normalizeSettlementRef', () => {
  const TX = '477eed6222f0f2b9e4d4a0d4d1f0f9b0c7a1e5d3b9f8072615c4a3d2e1f0a9b8'
  const receipt = JSON.stringify({ method: 'stellar', reference: TX, status: 'success', timestamp: '2026-08-24T03:04:07.098Z' })

  it('passes a bare 64-hex tx hash through unchanged, case included', () => {
    expect(normalizeSettlementRef(TX)).toBe(TX)
    expect(normalizeSettlementRef(TX.toUpperCase())).toBe(TX.toUpperCase())
  })

  it('unwraps a base64 Stellar receipt to its on-chain reference', () => {
    expect(normalizeSettlementRef(btoa(receipt))).toBe(TX)
  })

  it('unwraps the base64url variant without padding', () => {
    const b64url = btoa(receipt).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(normalizeSettlementRef(b64url)).toBe(TX)
  })

  it('returns anything it cannot decode unchanged', () => {
    expect(normalizeSettlementRef('mpp-credential-id')).toBe('mpp-credential-id')
    expect(normalizeSettlementRef(btoa('not json at all'))).toBe(btoa('not json at all'))
    expect(normalizeSettlementRef(btoa(JSON.stringify({ method: 'stellar', reference: 'nope' })))).toBe(
      btoa(JSON.stringify({ method: 'stellar', reference: 'nope' })),
    )
    expect(normalizeSettlementRef(null)).toBeNull()
    expect(normalizeSettlementRef('')).toBe('')
  })

  it('gives the dashboard the tx hash and x402-exact mode for a legacy receipt row', () => {
    const session = { payer: PAYER, rail: 'stellar' as const }
    const row = toMeRow(facadeRow(0, { settlement_ref: btoa(receipt) }) as any, session)
    expect(row.settlement_ref).toBe(TX)
    expect(row.mode).toBe('x402-exact')
  })
})

describe('GET /v1/me/usage', () => {
  it('aggregates the window for the authenticated wallet only', async () => {
    const first = vi.fn().mockResolvedValue({ calls: 4, spend_usd: 0.05, input_tokens: 4000, output_tokens: 900, cached_tokens: 100 })
    const bind = vi.fn(() => ({ first }))
    const db = { prepare: vi.fn(() => ({ bind })) }
    const env = { PORTAL_SESSION_SECRET: SECRET, COUPON_SECURITY_DB: db } as unknown as Env
    const res = await handleMeUsage(request('/v1/me/usage?window=7d', await sign(claims())), env)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ window: '7d', calls: 4, spend_usd: 0.05, input_tokens: 4000, output_tokens: 900 })
    expect(bind.mock.calls[0][0]).toBe(PAYER)
    expect((await handleMeUsage(request('/v1/me/usage?window=1y', await sign(claims())), env)).status).toBe(400)
  })
})
