/**
 * Buyer-facing, per-payer endpoints for the x402 dashboard
 * (github.com/mpprouter/x402-dashboard):
 *
 *   GET /v1/me/ledger?limit=&cursor=   — this payer's LLM facade calls, newest first
 *   GET /v1/me/usage?window=24h|7d|30d — aggregates for the same payer
 *   GET /v1/me/sessions                — this payer's own payment channels
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
import { getChannelForAgent, getStellarChannel } from '../mpp/stellar-channel-store'
import { Store } from 'mppx/server'
import { doAtomicParams } from '../mpp/kv-atomic-store'
import { isChannelBlocked } from '../playground/channel-voucher-store'

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

const TX_HASH = /^[0-9a-fA-F]{64}$/

/**
 * `llm_facade_requests.settlement_ref` stores the upstream `X-Payment-Tx`
 * header verbatim. On Stellar that header is not a tx hash but a base64 JSON
 * receipt wrapping one, e.g.
 *   {"method":"stellar","reference":"<64 hex>","status":"success", ...}
 * The dashboard's row contract expects the on-chain tx hash, and dedupes
 * router rows against chain rows on it — passing the blob through made every
 * LLM call appear twice. Unwrap receipt-shaped refs; leave anything else
 * (already a hash, an mpp credential id, garbage) exactly as it came.
 */
export function normalizeSettlementRef(raw: string | null): string | null {
  if (!raw) return raw
  if (TX_HASH.test(raw)) return raw
  try {
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4))
    const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const parsed = JSON.parse(decoded) as unknown
    if (parsed && typeof parsed === 'object') {
      const reference = (parsed as { reference?: unknown }).reference
      if (typeof reference === 'string' && TX_HASH.test(reference)) return reference
    }
  } catch {
    // Not a base64 JSON receipt — fall through and keep the raw value.
  }
  return raw
}

/**
 * Payment mode. The proxy records it explicitly (X-Payment-Method →
 * charge_evidence_json.payment_method); rows written before that existed fall
 * back to the shape of the settlement reference, which is only a heuristic.
 * The heuristic sees the normalized ref, so a legacy row whose receipt wraps a
 * tx hash reads as `x402-exact`, matching the chain view.
 */
export function paymentMode(row: FacadeRow, normalizedRef?: string | null): MeLedgerRow['mode'] {
  const explicit = row.payment_method ? MODE_BY_METHOD[row.payment_method] : undefined
  if (explicit) return explicit
  if (row.channel_cursor_after) return 'session'
  const ref = (normalizedRef === undefined ? normalizeSettlementRef(row.settlement_ref ?? null) : normalizedRef) ?? ''
  return TX_HASH.test(ref) ? 'x402-exact' : 'mpp-charge'
}

export function toMeRow(row: FacadeRow, session: PortalSession): MeLedgerRow {
  const ref = normalizeSettlementRef(row.settlement_ref ?? null)
  const mode = paymentMode(row, ref)
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

/**
 * GET /v1/me/sessions — the verified payer's own Stellar payment channels.
 *
 * Data source, and why:
 *   - Identity → channel: the KV secondary index `stellarAgent:<G>` that
 *     src/mpp/stellar-channel-store.ts already maintains for the dispatch
 *     path. It is keyed by the payer, so no new store and no migration are
 *     needed. V2 is one channel per agent, so this returns at most one row.
 *   - Channel metadata (deposit, open time, contract, asset): the
 *     `stellarChannel:<C>` record behind that index.
 *   - Spend AND lifecycle: the cumulative voucher record mppx keeps at
 *     `stellar:channel:cumulative:<C>` on the atomic (Durable Object) store —
 *     read with exactly the same key and shape the spend path itself reads
 *     (src/routes/proxy.ts and stellar-channel-dispatch.ts's rollback). Its
 *     `amount` is in the same base units as `depositRaw`, which is what
 *     proxy.ts compares it against in the capacity gate, and its `settling`
 *     flag is the same one the rollback guard refuses to rewind past.
 *   - Blocked state: the closed / fenced markers on that same atomic store,
 *     read through `isChannelBlocked` rather than by retyping its keys.
 *     All of these are plain reads; nothing here verifies, advances, rolls
 *     back or settles a voucher.
 *
 * The D1 `llm_facade_requests.channel_cursor_after` column is deliberately
 * NOT used for spend: nothing in the repo writes it, so it is NULL in
 * production and would report every used channel as untouched. D1 is used
 * only for the two informational counters, scoped to this channel by
 * `payment_method = 'stellar.channel'` AND `created_at >= openedAt` so a
 * previous channel's calls are not attributed to the current one after the
 * agent rotates channels.
 *
 * The authoritative remaining balance lives on chain; this endpoint reports
 * the router's own view and never signs or moves anything. Non-custodial:
 * read-only, no balance held here.
 *
 * Only the channel whose stored `agentAccount` equals the verified payer is
 * returned, so a stale or hand-edited index cannot leak another buyer's
 * channel. Prompts, query strings and route ids are never included.
 */

/** Stellar USDC is 7-decimal; channel amounts are decimal strings of base units. */
const STROOP = 10_000_000

export interface MeSessionRow {
  session_id: string
  rail: 'stellar' | 'base'
  status: 'open' | 'closing' | 'closed'
  budget_usd: number
  spent_usd: number
  remaining_usd: number
  opened_at: string
  expires_at: string | null
  channel_ref: string
  /** Calls settled against this channel, from the payer's own D1 rows. */
  calls: number
  /** ISO-8601 of the newest call we recorded on this channel; null when never used. */
  last_activity_at: string | null
}

/** Base units (decimal string) → USD. Bad input reads as 0 rather than NaN. */
export function rawToUsd(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0
  return Number(BigInt(raw)) / STROOP
}

/**
 * Lifecycle, in precedence order, because a channel can be unspendable while
 * money still appears to remain:
 *
 *   1. `blocked` — the channel carries a closed or fenced marker, so the
 *      dispatch gate rejects every further call. Report `closed` even with a
 *      positive remaining balance.
 *   2. `settling` — a settlement is in flight on the cumulative record. mppx
 *      will not accept a new voucher past it, so the channel is `closing`.
 *   3. Otherwise the deposit decides: funds left → `open`, drained → `closed`.
 *
 * Deriving this from `remainingUsd` alone (the first cut) reported a settling
 * or closed channel as `open`, which the dashboard would render as spendable.
 */
export function channelStatus(
  remainingUsd: number,
  lifecycle: { blocked: boolean; settling: boolean },
): MeSessionRow['status'] {
  if (lifecycle.blocked) return 'closed'
  if (lifecycle.settling) return 'closing'
  return remainingUsd > 0 ? 'open' : 'closed'
}

/**
 * Read the cumulative voucher record for a channel: the vouched amount in the
 * same base units as `depositRaw`, plus the in-flight settlement flag. The
 * record mppx keeps is `{ amount, settling? }` — the exact shape
 * `rollbackFailedChannelVoucher` inspects. A missing record means no voucher
 * has ever been accepted. Read-only.
 */
export async function readChannelCumulative(
  env: Env,
  channelContract: string,
): Promise<{ amountRaw: string; settling: boolean }> {
  const store = Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))
  const current = (await store.get(`stellar:channel:cumulative:${channelContract}`)) as
    | { amount?: string | number; settling?: unknown }
    | null
  if (!current || typeof current !== 'object') return { amountRaw: '0', settling: false }
  return {
    amountRaw: current.amount === undefined ? '0' : String(current.amount),
    settling: Boolean(current.settling),
  }
}

export async function handleMeSessions(request: Request, env: Env): Promise<Response> {
  const session = await verifyPortalSession(request, env)
  if (!session) return json(401, { error: 'Unauthorized' })
  if (!env.MPP_STORE || !env.ATOMIC_STORE) return json(503, { error: 'Channel store is not configured' })

  const contract = await getChannelForAgent(env, session.payer)
  if (!contract) return json(200, { ok: true, payer: session.payer, sessions: [] })

  const state = await getStellarChannel(env, contract)
  // Fail closed on a stale index: only a record that names this payer as the
  // funder may be shown.
  if (!state || state.agentAccount !== session.payer) {
    return json(200, { ok: true, payer: session.payer, sessions: [] })
  }

  // Both reads hit the same strongly-consistent atomic store the spend path
  // uses, so a channel that just became unspendable cannot still read `open`.
  const [cumulative, blocked] = await Promise.all([
    readChannelCumulative(env, state.channelContract),
    isChannelBlocked(env, state.channelContract),
  ])
  const budget_usd = rawToUsd(state.depositRaw)
  const spent_usd = rawToUsd(cumulative.amountRaw)
  const remaining_usd = Math.max(0, budget_usd - spent_usd)

  // Informational counters only. A channel opened before this row scoping
  // existed simply reports fewer calls; it can never report another channel's.
  const openedAtMs = Date.parse(state.openedAt)
  let calls = 0
  let lastActivityMs: number | null = null
  if (env.COUPON_SECURITY_DB && Number.isFinite(openedAtMs)) {
    const usage = await env.COUPON_SECURITY_DB.prepare(`
      SELECT COUNT(*) AS calls, MAX(created_at) AS last_activity
      FROM llm_facade_requests
      WHERE wallet_address = ? AND created_at >= ?
        AND status IN ('settled','fallback_used')
        AND json_extract(charge_evidence_json, '$.payment_method') = 'stellar.channel'
    `).bind(session.payer, openedAtMs).first<Record<string, number | null>>()
    calls = Number(usage?.calls ?? 0)
    lastActivityMs = usage?.last_activity ?? null
  }

  const row: MeSessionRow = {
    session_id: state.channelContract,
    rail: 'stellar',
    status: channelStatus(remaining_usd, { blocked, settling: cumulative.settling }),
    budget_usd,
    spent_usd,
    remaining_usd,
    opened_at: state.openedAt,
    expires_at: null,
    channel_ref: state.channelContract,
    calls,
    last_activity_at: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
  }

  return json(200, { ok: true, payer: session.payer, sessions: [row] })
}
