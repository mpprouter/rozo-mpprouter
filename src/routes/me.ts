/**
 * Buyer-facing, per-payer endpoints for the x402 dashboard
 * (github.com/mpprouter/x402-dashboard):
 *
 *   GET /v1/me/ledger?limit=&cursor=   — this payer's LLM facade calls, newest first
 *   GET /v1/me/usage?window=24h|7d|30d — aggregates for the same payer
 *
 * Authentication is the dashboard's own session: the portal verifies a
 * wallet signature (Sign-In-With-X) and issues an HS256 JWT whose `sub` is
 * the wallet address. The router shares that secret (PORTAL_SESSION_SECRET,
 * `wrangler secret put`) and verifies the token here, so a buyer sees token
 * counts and models only after proving control of the paying wallet. The
 * public /v1/ledger deliberately never carries those fields.
 *
 * Data source is the D1 `llm_facade_requests` table (indexed on
 * wallet_address + created_at). Non-LLM pay-per-call routes are recorded in
 * the KV order ledger, which has no payer index; the dashboard reads those
 * from chain + /v1/ledger?tx= instead.
 */

import type { Env } from '../index'

const ISSUER = 'x402-dashboard'
const AUDIENCE = 'session'
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export interface PortalSession {
  /** Wallet address the portal verified: Stellar G... or EIP-55 0x... */
  payer: string
  rail: 'stellar' | 'base'
}

/**
 * Verify the dashboard session JWT (HS256, iss x402-dashboard, aud session)
 * from the Authorization header. Returns null on any failure; callers turn
 * that into 401 without saying why.
 */
export async function verifyPortalSession(request: Request, env: Env): Promise<PortalSession | null> {
  const secret = env.PORTAL_SESSION_SECRET
  if (!secret || secret.length < 32) return null
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() ?? ''
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h))) as { alg?: string; typ?: string }
    if (header.alg !== 'HS256') return null
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)))
    if (!timingSafeEqual(expected, base64UrlDecode(s))) return null
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p))) as {
      iss?: string
      aud?: string | string[]
      sub?: string
      exp?: number
      rail?: string
    }
    if (payload.iss !== ISSUER) return null
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!aud.includes(AUDIENCE)) return null
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    const rail = payload.rail === 'base' ? 'base' : 'stellar'
    return { payer: payload.sub, rail }
  } catch {
    return null
  }
}

/** Row shape returned by /v1/me/ledger. Field names follow the dashboard's CLAUDE.md contract. */
export interface MeLedgerRow {
  order_id: string
  ts: string
  route_id: string
  payer: string
  amount_usd: number
  settlement_ref: string | null
  upstream_status: number | null
  latency_ms: number
  refund_status: 'none' | 'pending' | 'refunded' | 'unknown'
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  model: string | null
  requested_model: string | null
  provider: string | null
  /** settled | fallback_used | passthrough | delivered_unsettled | failed */
  status: string
  rail: 'stellar' | 'base'
  mode: 'x402-exact' | 'mpp-charge' | 'session'
}

interface FacadeRow {
  event_id: string
  request_id: string
  created_at: number
  wallet_address: string | null
  requested_model: string
  actual_model: string
  provider: string
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  quoted_amount_usd: string | null
  settlement_ref: string | null
  channel_cursor_after: string | null
  status: string
  /** json_extract(charge_evidence_json, '$.payment_method'): stellar.x402 | stellar.charge | stellar.channel */
  payment_method?: string | null
}

const SETTLED = new Set(['settled', 'fallback_used'])

const MODE_BY_METHOD: Record<string, MeLedgerRow['mode']> = {
  'stellar.x402': 'x402-exact',
  'stellar.charge': 'mpp-charge',
  'stellar.channel': 'session',
}

/**
 * Payment mode. The proxy records it explicitly (X-Payment-Method →
 * charge_evidence_json.payment_method); rows written before that existed fall
 * back to the shape of the settlement reference, which is only a heuristic.
 */
export function paymentMode(row: FacadeRow): MeLedgerRow['mode'] {
  const explicit = row.payment_method ? MODE_BY_METHOD[row.payment_method] : undefined
  if (explicit) return explicit
  if (row.channel_cursor_after) return 'session'
  const ref = row.settlement_ref ?? ''
  return /^[0-9a-fA-F]{64}$/.test(ref) ? 'x402-exact' : 'mpp-charge'
}

export function toMeRow(row: FacadeRow, session: PortalSession): MeLedgerRow {
  const ref = row.settlement_ref ?? null
  const mode = paymentMode(row)
  const settled = SETTLED.has(row.status)
  return {
    order_id: row.event_id,
    ts: new Date(row.created_at).toISOString(),
    route_id: `${row.provider}/${row.actual_model}`,
    payer: session.payer,
    amount_usd: settled ? Number(row.quoted_amount_usd ?? 0) || 0 : 0,
    settlement_ref: ref,
    upstream_status: row.status === 'failed' ? 502 : 200,
    latency_ms: 0,
    refund_status: 'none',
    input_tokens: row.input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    cached_tokens: row.cached_tokens ?? null,
    model: row.actual_model ?? null,
    requested_model: row.requested_model ?? null,
    provider: row.provider ?? null,
    status: row.status,
    rail: session.rail,
    mode,
  }
}

export async function handleMeLedger(request: Request, env: Env): Promise<Response> {
  const session = await verifyPortalSession(request, env)
  if (!session) return json(401, { error: 'Unauthorized' })
  if (!env.COUPON_SECURITY_DB) return json(503, { error: 'Usage database is not configured' })

  const url = new URL(request.url)
  const limitRaw = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return json(400, { error: `limit must be an integer between 1 and ${MAX_LIMIT}.` })
    }
    limit = Math.min(parsed, MAX_LIMIT)
  }
  // Cursor is `<created_at>:<event_id>` of the last row on the previous page.
  // Paging on (created_at, event_id) rather than created_at alone means two
  // rows written in the same millisecond at a page boundary are not skipped.
  // A bare `<created_at>` (the first release's cursor) is still accepted.
  const cursor = parseCursor(url.searchParams.get('cursor'))
  if (cursor === false) {
    return json(400, { error: 'cursor must be <created_at>:<event_id> from a previous page.' })
  }
  const beforeTs = cursor?.createdAt ?? Number.MAX_SAFE_INTEGER
  const beforeId = cursor?.eventId ?? ''

  const result = await env.COUPON_SECURITY_DB.prepare(`
    SELECT event_id, request_id, created_at, wallet_address, requested_model, actual_model, provider,
      input_tokens, output_tokens, cached_tokens, quoted_amount_usd, settlement_ref,
      channel_cursor_after, status,
      json_extract(charge_evidence_json, '$.payment_method') AS payment_method
    FROM llm_facade_requests
    WHERE wallet_address = ? AND (created_at < ? OR (created_at = ? AND event_id < ?))
    ORDER BY created_at DESC, event_id DESC LIMIT ?
  `).bind(session.payer, beforeTs, beforeTs, beforeId, limit + 1).all<FacadeRow>()

  const all = result.results ?? []
  const page = all.slice(0, limit)
  const rows = page.map((r) => toMeRow(r, session))
  const last = page[page.length - 1]
  const next_cursor = all.length > limit && last ? `${last.created_at}:${last.event_id}` : null

  return json(200, { ok: true, payer: session.payer, order: 'ts_desc', rows, next_cursor })
}

interface LedgerCursor {
  createdAt: number
  eventId: string
}

/** null = no cursor, false = malformed. A bare timestamp pages by created_at only. */
export function parseCursor(raw: string | null): LedgerCursor | null | false {
  if (!raw) return null
  const sep = raw.indexOf(':')
  const tsPart = sep === -1 ? raw : raw.slice(0, sep)
  const eventId = sep === -1 ? '' : raw.slice(sep + 1)
  if (!/^\d{1,16}$/.test(tsPart)) return false
  const createdAt = Number(tsPart)
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return false
  if (sep !== -1 && (!eventId || eventId.length > 128)) return false
  return { createdAt, eventId }
}

const WINDOW_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export async function handleMeUsage(request: Request, env: Env): Promise<Response> {
  const session = await verifyPortalSession(request, env)
  if (!session) return json(401, { error: 'Unauthorized' })
  if (!env.COUPON_SECURITY_DB) return json(503, { error: 'Usage database is not configured' })

  const url = new URL(request.url)
  const window = url.searchParams.get('window') ?? '30d'
  const span = WINDOW_MS[window]
  if (!span) return json(400, { error: 'window must be one of 24h, 7d, 30d.' })
  const since = Date.now() - span

  const totals = await env.COUPON_SECURITY_DB.prepare(`
    SELECT COUNT(*) AS calls,
      SUM(CASE WHEN status IN ('settled','fallback_used') THEN CAST(quoted_amount_usd AS REAL) ELSE 0 END) AS spend_usd,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cached_tokens) AS cached_tokens
    FROM llm_facade_requests WHERE wallet_address = ? AND created_at >= ?
  `).bind(session.payer, since).first<Record<string, number | null>>()

  return json(200, {
    window,
    calls: Number(totals?.calls ?? 0),
    spend_usd: Number(totals?.spend_usd ?? 0),
    input_tokens: Number(totals?.input_tokens ?? 0),
    output_tokens: Number(totals?.output_tokens ?? 0),
    cached_tokens: Number(totals?.cached_tokens ?? 0),
    refunded_usd: 0,
  })
}
