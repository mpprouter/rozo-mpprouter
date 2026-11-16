/**
 * Agent Checkout B9: client outcome reports.
 *
 *   POST /v1/checkout/client-report
 *   {"client":"rozo-checkout-cli","version":"0.1.27","outcome":"refused",
 *    "code":"CREATE_DRIFT","flow":"coinbase","rozoPaymentId":"<uuid>"?}
 *
 * The CLI and the MCP server send one report when a payment attempt ends on
 * the client side, so the weekly patrol can see local refusals and abandoned
 * attempts per client version (it only sees orders today).
 *
 * Off unless CLIENT_REPORTS_ENABLED is exactly 'true' (404). Unauthenticated
 * by design: a report carries no person, wallet or payment detail, every field
 * is a closed enum or a strict pattern, unknown fields are dropped, and each IP
 * is rate limited (CLIENT_REPORTS_IP_LIMIT_PER_HOUR, best effort) under one atomic
 * global hourly cap (CLIENT_REPORTS_GLOBAL_LIMIT_PER_HOUR); either unset = 503. Answers 204
 * and never reflects input. Storage: D1 ROUTE_METRICS_DB, table
 * checkout_client_reports (migrations-metrics/0005). A storage failure still
 * answers 204: reporting must never change what a client does next.
 */

import type { Env } from '../index'
import { rateLimitOk } from './invoice-details'
import { clientIp } from './create-invoice-gate'
import { casUpdate } from './stripe-atomic'

export const CLIENT_REPORT_PATH = '/v1/checkout/client-report'

const CLIENTS = new Set(['rozo-checkout-cli', 'rozo-checkout-mcp'])
const OUTCOMES = new Set(['succeeded', 'refused', 'failed', 'abandoned', 'unconfirmed'])
const FLOWS = new Set(['coinbase', 'bitrefill', 'x402'])
// Numeric semver only: a prerelease suffix is free text and is not accepted.
const VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
// Codes the checkout CLI emits (scripts/src at 0.1.27). Anything else is
// stored as OTHER, never verbatim, so a mis-mapped client cannot persist a key
// or an address that happens to look like an UPPER_SNAKE code.
export const KNOWN_CODES: ReadonlySet<string> = new Set([
  'ALREADY_SENT', 'AMOUNT_PRECISION', 'AWAITING_DEPOSIT', 'BAD_ADDRESS_FAMILY', 'BAD_AMOUNT',
  'BAD_BITREFILL_INVOICE', 'BAD_DEPOSIT_ADDRESS', 'BAD_FUNDING', 'BAD_INVOICE_AMOUNT', 'BAD_LINK',
  'BAD_PAYER_ADDRESS', 'BITREFILL_ECHO_MISMATCH', 'BLACKLIST_HIT', 'BLACKLIST_UNAVAILABLE',
  'BROADCAST_AMBIGUOUS', 'BROADCAST_FAILED', 'CANCELLED', 'CAP_PER_TX', 'CONFIRMATION_REQUIRED',
  'CONFIRMATION_STALE', 'CREATE_DRIFT', 'CREATE_FAILED', 'DECIMALS_MISMATCH', 'DEPOSIT_ACCOUNT_MISMATCH',
  'DEPOSIT_ACCOUNT_MISSING', 'DEPOSIT_ACCOUNT_NOT_WALLET', 'DEPOSIT_BELOW_RENT', 'DEPOSIT_CHANGED',
  'DEPOSIT_INCOMPLETE', 'DEPOSIT_MEMO_REQUIRED', 'DEPOSIT_NOT_LIVE', 'DUPLICATE_INVOICE', 'EXPIRED',
  'EXPIRY_MARGIN', 'EXPIRY_UNPARSABLE', 'GAS_CHECK_UNAVAILABLE', 'HTTP_BAD_JSON', 'HTTP_TIMEOUT',
  'HTTP_UNREACHABLE', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_GAS', 'INVALID_ADDRESS', 'INVALID_AMOUNT',
  'INVOICE_EXPIRING', 'INVOICE_EXPIRY_REQUIRED', 'INVOICE_IN_PROGRESS', 'INVOICE_UNSUPPORTED',
  'LEGACY_COMMERCE_URL', 'LINK_NO_LONGER_PAYABLE', 'LINK_PAYABILITY_UNKNOWN', 'LOCK_TIMEOUT',
  'MISSING_EXPECTED_AMOUNT', 'NATIVE_AMOUNT_TOO_HIGH', 'NATIVE_AMOUNT_TOO_LOW', 'NATIVE_AMOUNT_UNKNOWN',
  'NATIVE_NOT_AVAILABLE', 'NATIVE_NOT_OFFERED', 'NATIVE_TOKEN_ADDRESS_UNEXPECTED', 'NO_DISCOUNT_VIOLATION',
  'NO_KEY_SOURCE', 'NO_ORDER_STATE', 'NO_RPC', 'NO_TOKEN_ACCOUNT', 'NO_TOKEN_ADDRESS', 'NOT_CONFIRMED',
  'ORDER_ALREADY_FUNDED', 'ORDER_ALREADY_PAID', 'ORDER_EXPIRED', 'ORDER_NEEDS_ATTENTION',
  'ORDER_NOT_PAYABLE', 'ORDER_NOT_RESUMABLE', 'ORDER_STATE_UNKNOWN', 'PREPARED_TX_MISMATCH',
  'PRICING_VIOLATION', 'QUOTE_EXPIRED', 'QUOTE_EXPIRY_MARGIN', 'REUSED_SOURCE_MISMATCH',
  'RPC_CHAIN_MISMATCH', 'RPC_READ_FAILED', 'RPC_UNREACHABLE', 'RUNTIME_ERROR', 'SEND_FAILED',
  'SEND_NOT_OPTED_IN', 'SEND_UNSUPPORTED_CHAIN', 'SEND_WINDOW_CLOSED', 'SEND_WINDOW_UNKNOWN',
  'STATE_CORRUPT', 'STATE_UNREADABLE', 'TOKEN_READ_FAILED', 'TX_FAILED', 'TX_REVERTED', 'TX_UNCONFIRMED',
  'UNKNOWN', 'UNSUPPORTED_SOURCE', 'USER_CANCELLED', 'WRONG_SENDER_SCRIPT', 'X402_BAD_CHALLENGE',
  'X402_BAD_SIGNATURE', 'X402_BAD_TOPUP', 'X402_LEDGER_UNAVAILABLE', 'X402_NO_KEY', 'X402_NOT_402',
  'X402_OVER_BUDGET', 'X402_PAYER_DISABLED', 'X402_PAYER_MODE_CHANGED', 'X402_PAYMENT_REJECTED',
  'X402_REPLAY_FAILED', 'X402_RETRY', 'X402_TOPUP_MISMATCH', 'X402_TOPUP_SOURCE_UNSUPPORTED',
  'X402_UNSUPPORTED', 'ZEC_ADDRESS_INVALID', 'ZEC_AMOUNT_TOO_HIGH', 'ZEC_AMOUNT_TOO_LOW',
  'ZEC_AMOUNT_UNKNOWN', 'ZEC_NOT_OFFERED', 'ZEC_PAYMENT_URI_INVALID', 'ZEC_PAYMENT_URI_MISMATCH',
  'ZEC_PAYMENT_URI_MISSING', 'ZEC_QUOTE_EXPIRED', 'ZEC_RECEIVE_MODE_MISMATCH', 'ZEC_SHIELDED_NOT_AVAILABLE',
  'ZEC_SHIELDED_REQUIRED',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 2048

export interface ClientReport {
  client: string
  version: string
  outcome: string
  code: string | null
  flow: string | null
  rozoPaymentId: string | null
}

/** Strict parse; null when any present field is out of contract. */
export function parseClientReport(b: unknown): ClientReport | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null
  const o = b as Record<string, unknown>
  if (typeof o.client !== 'string' || !CLIENTS.has(o.client)) return null
  if (typeof o.version !== 'string' || !VERSION_RE.test(o.version)) return null
  if (typeof o.outcome !== 'string' || !OUTCOMES.has(o.outcome)) return null
  const code = o.code === undefined || o.code === null ? null : o.code
  if (code !== null && (typeof code !== 'string' || !CODE_RE.test(code))) return null
  if (o.outcome === 'succeeded' && code !== null) return null
  const flow = o.flow === undefined || o.flow === null ? null : o.flow
  if (flow !== null && (typeof flow !== 'string' || !FLOWS.has(flow))) return null
  const pid = o.rozoPaymentId === undefined || o.rozoPaymentId === null ? null : o.rozoPaymentId
  if (pid !== null && (typeof pid !== 'string' || !UUID_RE.test(pid))) return null
  return {
    client: o.client,
    version: o.version,
    outcome: o.outcome,
    code: code === null ? null : KNOWN_CODES.has(code as string) ? (code as string) : 'OTHER',
    flow: flow as string | null,
    rozoPaymentId: pid === null ? null : (pid as string).toLowerCase(),
  }
}

function plain(status: number, code?: string): Response {
  return code
    ? new Response(JSON.stringify({ error: { code } }), { status, headers: { 'content-type': 'application/json' } })
    : new Response(null, { status })
}

/** Read at most `cap` bytes; cancels the stream as soon as it is exceeded. */
async function readCapped(request: Request, cap: number): Promise<string | null | 'too_large'> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) return 'too_large'
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        await reader.cancel().catch(() => undefined)
        return 'too_large'
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch {
    return null
  }
}

/**
 * One atomic hourly window for all callers, in its own DO instance (never the
 * payment coordinator's) and one key per hour, so a late request can never
 * roll a window back. Store unavailable = no slot.
 */
export const CLIENT_REPORT_DO_INSTANCE = 'client-report-counter'
async function takeGlobalSlot(env: Env, limit: number, now = Date.now()): Promise<boolean> {
  const key = `client-report-global:v2:${Math.floor(now / 3_600_000)}`
  try {
    return await casUpdate<boolean>(env, key, (raw) => {
      const n = raw && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : 0
      if (n >= limit) return { op: 'noop', result: false }
      return { op: 'set', value: String(n + 1), result: true }
    }, CLIENT_REPORT_DO_INSTANCE)
  } catch {
    return false
  }
}

export async function handleClientReport(
  request: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  if (env.CLIENT_REPORTS_ENABLED !== 'true') return plain(404, 'NOT_FOUND')
  if (request.method !== 'POST') return plain(405, 'METHOD_NOT_ALLOWED')
  const limit = Number(env.CLIENT_REPORTS_IP_LIMIT_PER_HOUR)
  if (!env.CLIENT_REPORTS_IP_LIMIT_PER_HOUR || !Number.isSafeInteger(limit) || limit <= 0 || !env.ROUTE_METRICS_DB) {
    return plain(503, 'NOT_CONFIGURED')
  }
  const globalLimit = Number(env.CLIENT_REPORTS_GLOBAL_LIMIT_PER_HOUR)
  if (!env.CLIENT_REPORTS_GLOBAL_LIMIT_PER_HOUR || !Number.isSafeInteger(globalLimit) || globalLimit <= 0) {
    return plain(503, 'NOT_CONFIGURED')
  }
  // Per-IP: best-effort KV window (abuse shaping). The bound on what can be
  // stored is the global window below, which is atomic (DO CAS) and fails
  // closed: if the counter cannot be read or written, nothing is stored.
  const rl = await rateLimitOk(env, `client-report:ip:${clientIp(request)}`, limit, 3600)
  if (!rl.ok) return plain(429, 'RATE_LIMITED')

  const text = await readCapped(request, MAX_BODY_BYTES)
  if (text === 'too_large') return plain(413, 'TOO_LARGE')
  if (text === null) return plain(400, 'INVALID_INPUT')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return plain(400, 'INVALID_INPUT')
  }
  const r = parseClientReport(parsed)
  if (!r) return plain(400, 'INVALID_INPUT')
  if (!(await takeGlobalSlot(env, globalLimit))) return plain(429, 'RATE_LIMITED')

  const db = env.ROUTE_METRICS_DB
  const write = db
    .prepare(
      `INSERT INTO checkout_client_reports
         (report_id, created_at, client, client_version, outcome, code, flow, rozo_payment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), Date.now(), r.client, r.version, r.outcome, r.code, r.flow, r.rozoPaymentId)
    .run()
    .then(
      () => undefined,
      (e: Error) => console.warn(`[client-report] write failed: ${e.name}`),
    )
  if (ctx) ctx.waitUntil(write)
  else await write
  return plain(204)
}
