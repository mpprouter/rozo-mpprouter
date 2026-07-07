/**
 * Coupon redemption layer — prepaid vouchers for invoice fulfillment.
 *
 * Product flow (see rozo/todos/20260707-open-rozo-payment-coupon-model.md):
 *   1. Customer pays RMB off-platform (Goofish). Operator confirms receipt.
 *   2. Operator issues an 8-digit coupon code via POST /admin/coupon/issue.
 *   3. Customer enters (code + their Coinbase payment link) on open.rozo.ai.
 *   4. POST /coupon/redeem validates the coupon and pays the invoice via
 *      the same agentapi pay-invoice path the webhook flow uses.
 *
 * ## Security model — public redeem with an 8-digit numeric code
 *
 * The code space is only 10^8, so the public redeem endpoint is designed
 * to survive brute-force probing rather than rely on code entropy:
 *   • Uniform errors: every pre-claim failure (unknown code, expired, used,
 *     bad format) returns the same INVALID_COUPON body. Specific errors are
 *     only returned AFTER the caller has proven possession of a live code
 *     (successful CAS claim).
 *   • Per-IP rate limit, per-code failure lockout, and a global circuit
 *     breaker — all counted on the coupon Durable Object instance (strongly
 *     consistent; KV counters would race across isolates).
 *   • Codes come from crypto.getRandomValues with rejection sampling.
 *
 * ## State machine (single source of truth: coupon DO instance)
 *
 *   issued ──claim──▶ redeeming ──pre-pay checks ok──▶ paying ──▶ redeemed
 *      ▲                  │                              │
 *      └──rollback────────┘ (quote/amount/balance        └──▶ manual_review
 *         (no money moved)   failed — safe to retry)          (pay-invoice
 *                                                              failed or
 *                                                              ambiguous —
 *                                                              NEVER auto-
 *                                                              rolled back)
 *
 * Invariant: a coupon triggers at most ONE pay-invoice call. Once status
 * reaches `paying`, automatic rollback to `issued` is forbidden — a timeout
 * after the upstream actually paid would otherwise double-spend. Ambiguous
 * outcomes park in `manual_review` for an operator (see /admin/coupon/resolve).
 *
 * Expiry is enforced by the `expiresAt` field, never by destructive TTL —
 * expired/redeemed records must stay readable for support and audit.
 * Eligibility is frozen at claim time: a coupon that was valid when the CAS
 * claim succeeded is not failed later just because the clock passed expiresAt
 * mid-fulfillment.
 *
 * All coupon state lives on a DEDICATED AtomicStoreDO instance (named
 * "coupon"), not the "mppx" singleton — public brute-force traffic must not
 * contend with the payment replay-protection hot path.
 */

import type { Env } from '../index'
import type { ReadResponse, CommitResponse } from '../mpp/atomic-store-do'
import { extractPaymentLinkId } from './pay-invoice-admin'
import { parseUsdc, formatUsdc } from './create-invoice'
import { callAgentApiPayInvoice, reservedAtomic, FUNDER_WALLET } from './webhook'
import { getBaseUsdcBalance } from '../utils/base-usdc-balance'
import { sendDingTalkAlert } from '../utils/dingtalk'

// ── Tunables ─────────────────────────────────────────────────────────────────

// 12h (founder 2026-07-07): long enough that a Goofish buyer can redeem at
// their leisure, while the global circuit breaker (not the TTL) caps total
// brute-force attempts — at 500/h global, a 12h window allows at most 6000
// guesses network-wide (~0.06% hit chance with 10 live coupons in 10^8 space).
const DEFAULT_EXPIRES_MINUTES = 12 * 60
// Fat-finger guard on issuance. Goofish orders are typically $5–$50.
const MAX_FACE_VALUE_ATOMIC = 200_000_000n // $200
// A `redeeming` claim older than this is considered abandoned (worker died
// before reaching `paying`) and may be re-claimed. `paying` never auto-expires.
const REDEEMING_STALE_MS = 10 * 60 * 1000
// Public endpoints: attempts per IP per hour (redeem + status combined).
const IP_LIMIT_PER_HOUR = 20
// Failed attempts against one code before it locks (resets after LOCK_MS).
const CODE_FAIL_LIMIT = 5
const CODE_LOCK_MS = 60 * 60 * 1000
// Global attempts per hour across all IPs — circuit breaker against botnets.
const GLOBAL_LIMIT_PER_HOUR = 500

const QUOTE_INVOICE_URL = 'https://agentapi.rozo.ai/quote-invoice'

// ── Types ────────────────────────────────────────────────────────────────────

export type CouponStatus =
  | 'issued'
  | 'redeeming'
  | 'paying'
  | 'redeemed'
  | 'manual_review'
  | 'void'

export interface CouponRecord {
  code: string
  /** Face value as a decimal USD string, e.g. "20" / "20.5". */
  amountUsd: string
  /** Face value in atomic USDC units (6 decimals), stringified bigint. */
  amountAtomic: string
  status: CouponStatus
  issuedAt: string
  expiresAt: string
  /** Operator note: RMB payment proof / order reference. Never shown publicly. */
  paymentProof: string | null
  /** Set on claim. */
  redeemingAt: string | null
  /**
   * Unique id of the in-flight claim (crypto.randomUUID). Every transition
   * after the claim (rollback, paying, redeemed, manual_review) must verify
   * it still owns the claim — a stale re-claim or an admin resolve replaces
   * attemptId, which fences the previous request off the money path.
   */
  attemptId: string | null
  plId: string | null
  redeemedAt: string | null
  coinbaseResult: unknown | null
  failureReason: string | null
  events: Array<{ kind: string; at: string; detail?: unknown }>
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// The one public error body for every pre-claim failure. Anything more
// specific becomes a probing oracle for the 8-digit code space.
function invalidCoupon(): Response {
  return json(400, {
    error: 'INVALID_COUPON',
    message: 'Coupon is invalid, already used, or expired.',
  })
}

function rateLimited(): Response {
  return json(429, {
    error: 'RATE_LIMITED',
    message: 'Too many attempts. Please try again later.',
  })
}

// ── Durable Object CAS client (dedicated "coupon" instance) ──────────────────
//
// Speaks the same /read + /commit protocol as kv-atomic-store.ts but against
// its own DO instance so coupon state and rate counters are (a) strongly
// consistent and (b) isolated from the mppx payment path.

const DO_ORIGIN = 'https://atomic-store.internal'
const MAX_CAS_RETRIES = 5
// Hot shared counters (rl:global, rl:ip, funder-reserve) see genuine burst
// contention: every conflict means another request committed, so the system
// makes progress and a retry bound is only a safety net — but 5 is too tight
// for a public endpoint burst. Coupon-record keys keep the tight bound (a
// single code sees at most a handful of concurrent requests).
const MAX_COUNTER_CAS_RETRIES = 25

type CasChange<R> =
  | { op: 'set'; value: string; result: R }
  | { op: 'noop'; result: R }

function couponStub(env: Env) {
  return env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('coupon'))
}

async function doPost<T>(stub: DurableObjectStub, path: string, payload: unknown): Promise<T> {
  const resp = await stub.fetch(
    new Request(`${DO_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`coupon DO ${path} failed (${resp.status}): ${text}`)
  }
  return resp.json() as Promise<T>
}

async function casUpdate<R>(
  env: Env,
  key: string,
  fn: (current: string | null) => CasChange<R>,
  maxRetries: number = MAX_CAS_RETRIES,
): Promise<R> {
  const stub = couponStub(env)
  let { value, version } = await doPost<ReadResponse>(stub, '/read', { key })
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const change = fn(value)
    if (change.op === 'noop') return change.result
    const result = await doPost<CommitResponse>(stub, '/commit', {
      key,
      expectedVersion: version,
      op: 'set',
      value: change.value,
    })
    if (result.ok) return change.result
    value = result.value
    version = result.version
  }
  throw new Error(`coupon DO casUpdate(${key}): exhausted ${maxRetries} retries`)
}

async function casRead(env: Env, key: string): Promise<string | null> {
  const r = await doPost<ReadResponse>(couponStub(env), '/read', { key })
  return r.value
}

function couponKey(code: string) {
  return `coupon:${code}`
}

function parseRecord(raw: string | null): CouponRecord | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as CouponRecord
  } catch {
    return null
  }
}

// ── Rate limiting (DO-backed counters) ───────────────────────────────────────

interface CounterState {
  n: number
  windowStart: number
  lockedUntil?: number
}

function parseCounter(raw: string | null): CounterState {
  if (!raw) return { n: 0, windowStart: 0 }
  try {
    return JSON.parse(raw) as CounterState
  } catch {
    return { n: 0, windowStart: 0 }
  }
}

/**
 * Fixed-window counter on the coupon DO. Returns true when the caller is
 * within limit (and consumes one unit), false when over limit.
 */
async function bumpCounter(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now()
  return casUpdate<boolean>(
    env,
    key,
    (raw) => {
      const c = parseCounter(raw)
      const inWindow = now - c.windowStart < windowMs
      const n = inWindow ? c.n : 0
      const windowStart = inWindow ? c.windowStart : now
      if (n >= limit) return { op: 'noop', result: false }
      return { op: 'set', value: JSON.stringify({ n: n + 1, windowStart }), result: true }
    },
    MAX_COUNTER_CAS_RETRIES,
  )
}

// ── Atomic funder reservation (coupon-side) ─────────────────────────────────
//
// The webhook path's KV-based reserved counter is read-then-write and openly
// documents its race as acceptable for rare webhook concurrency. The public
// redeem endpoint cannot accept that: two valid coupons redeemed concurrently
// must not BOTH pass a balance check the pool can only cover once. So the
// coupon side does check-and-reserve in a single CAS on the coupon DO:
// the decision (balance - webhookReserved - couponReserved >= invoice) and
// the reservation insert commit atomically. Entries carry a lease so a
// worker death cannot leak a reservation forever (pay-invoice is a
// synchronous few-second call; anything older than the lease is dead).
//
// The webhook path keeps its own KV counter and doesn't see in-flight coupon
// reservations for the few seconds they exist — acceptable because agentapi
// pay-invoice re-checks the funder balance itself as the final gate.

const RESERVE_KEY = 'funder-reserve'
const RESERVE_LEASE_MS = 10 * 60 * 1000

interface ReserveState {
  entries: Record<string, { amt: string; at: number }>
}

function parseReserve(raw: string | null): ReserveState {
  if (!raw) return { entries: {} }
  try {
    const st = JSON.parse(raw) as ReserveState
    return st && typeof st.entries === 'object' && st.entries ? st : { entries: {} }
  } catch {
    return { entries: {} }
  }
}

/**
 * Atomically: prune expired leases, compute available balance, and (only if
 * sufficient) insert this attempt's reservation. Returns false when the pool
 * cannot cover the invoice.
 */
async function tryReserveFunds(
  env: Env,
  attemptId: string,
  invoiceAtomic: bigint,
  balance: bigint,
  webhookReserved: bigint,
): Promise<boolean> {
  const now = Date.now()
  return casUpdate<boolean>(
    env,
    RESERVE_KEY,
    (raw) => {
      const st = parseReserve(raw)
      for (const [k, v] of Object.entries(st.entries)) {
        if (now - v.at > RESERVE_LEASE_MS) delete st.entries[k]
      }
      let couponReserved = 0n
      for (const v of Object.values(st.entries)) {
        try {
          couponReserved += BigInt(v.amt)
        } catch {
          /* corrupt entry — ignore */
        }
      }
      const available = balance - webhookReserved - couponReserved
      if (available < invoiceAtomic) return { op: 'noop', result: false }
      st.entries[attemptId] = { amt: invoiceAtomic.toString(), at: now }
      return { op: 'set', value: JSON.stringify(st), result: true }
    },
    MAX_COUNTER_CAS_RETRIES,
  )
}

async function releaseFunds(env: Env, attemptId: string): Promise<void> {
  await casUpdate<null>(
    env,
    RESERVE_KEY,
    (raw) => {
      const st = parseReserve(raw)
      if (!(attemptId in st.entries)) return { op: 'noop', result: null }
      delete st.entries[attemptId]
      return { op: 'set', value: JSON.stringify(st), result: null }
    },
    MAX_COUNTER_CAS_RETRIES,
  )
}

/** Per-code failure lockout: count a failed attempt; report locked state. */
async function codeFailCheck(env: Env, code: string): Promise<{ locked: boolean }> {
  const now = Date.now()
  const locked = await casUpdate<boolean>(env, `rl:code:${code}`, (raw) => {
    const c = parseCounter(raw)
    if (c.lockedUntil && now < c.lockedUntil) return { op: 'noop', result: true }
    return { op: 'noop', result: false }
  })
  return { locked }
}

async function codeFailBump(env: Env, code: string): Promise<void> {
  const now = Date.now()
  await casUpdate<null>(
    env,
    `rl:code:${code}`,
    (raw) => {
      const c = parseCounter(raw)
      const inWindow = now - c.windowStart < CODE_LOCK_MS
      const n = (inWindow ? c.n : 0) + 1
      const next: CounterState = {
        n,
        windowStart: inWindow ? c.windowStart || now : now,
        ...(n >= CODE_FAIL_LIMIT ? { lockedUntil: now + CODE_LOCK_MS } : {}),
      }
      return { op: 'set', value: JSON.stringify(next), result: null }
    },
    MAX_COUNTER_CAS_RETRIES,
  )
}

/**
 * Gate shared by the public endpoints. Consumes per-IP + global budget.
 * Returns a Response to short-circuit with, or null to proceed.
 */
async function publicGate(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const hour = Math.floor(Date.now() / 3_600_000)

  // Fail closed: if the counters themselves error out (retry exhaustion
  // under extreme contention, DO hiccup), a public money endpoint must
  // reject rather than 500 — and certainly must not proceed unmetered.
  try {
    // Per-IP FIRST: a request rejected by its own IP quota must not consume
    // global budget, otherwise a single abusive IP could trip the circuit
    // breaker and 429 every legitimate user for the rest of the window.
    const ipOk = await bumpCounter(env, `rl:ip:${ip}`, IP_LIMIT_PER_HOUR, 3_600_000)
    if (!ipOk) return rateLimited()
  } catch (err) {
    console.warn(`[coupon] per-IP counter error (fail closed): ${err instanceof Error ? err.message : String(err)}`)
    return rateLimited()
  }

  try {
    const globalOk = await bumpCounter(env, `rl:global:${hour}`, GLOBAL_LIMIT_PER_HOUR, 3_600_000)
    if (!globalOk) {
      // Circuit breaker tripped — with per-IP checked first, reaching this
      // requires many distinct IPs (distributed brute-force). Alerting once
      // per window would need extra state; an extra alert is harmless, so
      // just fire best-effort on every tripped request.
      if (env.DINGTALK_ACCESS_TOKEN) {
        await sendDingTalkAlert(
          env.DINGTALK_ACCESS_TOKEN,
          `[MPP Router] 🚨 Coupon redeem global circuit breaker OPEN: >${GLOBAL_LIMIT_PER_HOUR} attempts this hour. Redemption paused for the window.`,
        )
      }
      return rateLimited()
    }
  } catch (err) {
    console.warn(`[coupon] global counter error (fail closed): ${err instanceof Error ? err.message : String(err)}`)
    return rateLimited()
  }

  return null
}

// ── Code generation ──────────────────────────────────────────────────────────

/**
 * 8 decimal digits from a CSPRNG. Rejection sampling: a raw uint32 mod 1e8
 * is biased (2^32 is not a multiple of 1e8); resample above the largest
 * multiple of 1e8 that fits in 2^32.
 */
export function generateCouponCode(): string {
  const LIMIT = 4_200_000_000 // floor(2^32 / 1e8) * 1e8
  // Statistically this loop runs once (rejection probability ≈ 2.2%).
  for (;;) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    if (buf[0] < LIMIT) return (buf[0] % 100_000_000).toString().padStart(8, '0')
  }
}

const CODE_RE = /^\d{8}$/

// ── Admin auth ───────────────────────────────────────────────────────────────
//
// Coupon issuance uses its own secret (ADMIN_TOKEN), deliberately NOT
// PAYINVOICE_ADMIN_SECRET: leaking the issuance key must not grant the
// ability to drive pay-invoice directly, and vice versa.

function adminAuthorized(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return json(500, { error: 'ADMIN_TOKEN is not configured' })
  }
  const secret = request.headers.get('x-admin-secret')?.trim()
  if (!secret || secret !== env.ADMIN_TOKEN) {
    return json(401, { error: 'Unauthorized' })
  }
  return null
}

// ── POST /admin/coupon/issue ─────────────────────────────────────────────────

export async function handleIssueCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const denied = adminAuthorized(request, env)
  if (denied) return denied

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const amountRaw = body?.amountUsd
  const amountStr =
    typeof amountRaw === 'number' ? amountRaw.toString() : String(amountRaw ?? '').trim()
  let amountAtomic: bigint
  try {
    amountAtomic = parseUsdc(amountStr)
  } catch {
    return json(400, { error: 'amountUsd must be a decimal USD amount, e.g. "20" or "20.50"' })
  }
  if (amountAtomic <= 0n) return json(400, { error: 'amountUsd must be > 0' })
  if (amountAtomic > MAX_FACE_VALUE_ATOMIC) {
    return json(400, {
      error: `amountUsd exceeds the ${formatUsdc(MAX_FACE_VALUE_ATOMIC)} USD per-coupon cap`,
    })
  }

  const expiresInMinutes =
    typeof body?.expiresInMinutes === 'number' && body.expiresInMinutes > 0
      ? Math.min(body.expiresInMinutes, 60 * 24 * 7) // hard cap: 7 days
      : DEFAULT_EXPIRES_MINUTES
  const paymentProof = typeof body?.paymentProof === 'string' ? body.paymentProof : null

  const now = Date.now()
  const record: CouponRecord = {
    code: '',
    amountUsd: formatUsdc(amountAtomic),
    amountAtomic: amountAtomic.toString(),
    status: 'issued',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInMinutes * 60_000).toISOString(),
    paymentProof,
    redeemingAt: null,
    attemptId: null,
    plId: null,
    redeemedAt: null,
    coinbaseResult: null,
    failureReason: null,
    events: [{ kind: 'issued', at: new Date(now).toISOString() }],
  }

  // Atomic create-if-absent; on the (unlikely) collision, regenerate.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCouponCode()
    record.code = code
    const created = await casUpdate<boolean>(env, couponKey(code), (current) => {
      if (current !== null) return { op: 'noop', result: false }
      return { op: 'set', value: JSON.stringify(record), result: true }
    })
    if (created) {
      return json(200, {
        ok: true,
        code,
        amountUsd: record.amountUsd,
        expiresAt: record.expiresAt,
      })
    }
  }
  return json(500, { error: 'Could not allocate a unique coupon code — retry' })
}

// ── POST /admin/coupon/resolve ───────────────────────────────────────────────
//
// Operator repair for stuck / expired coupons:
//   void          — invalidate (e.g. before re-issuing an expired coupon)
//   release       — put back to `issued` AFTER the operator has verified no
//                   money moved (check invoice-status / Coinbase first!)
//   mark_redeemed — operator confirmed the upstream payment did land

export async function handleResolveCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const denied = adminAuthorized(request, env)
  if (denied) return denied

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }
  const code = String(body?.code ?? '').trim()
  const action = String(body?.action ?? '').trim()
  const reason = typeof body?.reason === 'string' ? body.reason : null
  if (!CODE_RE.test(code)) return json(400, { error: 'code must be 8 digits' })
  if (!['void', 'release', 'mark_redeemed'].includes(action)) {
    return json(400, { error: "action must be one of: void, release, mark_redeemed" })
  }

  const outcome = await casUpdate<{ ok: boolean; error?: string; record?: CouponRecord }>(
    env,
    couponKey(code),
    (raw) => {
      const rec = parseRecord(raw)
      if (!rec) return { op: 'noop', result: { ok: false, error: 'not found' } }
      const at = new Date().toISOString()
      if (action === 'void') {
        rec.status = 'void'
        // Fence out any in-flight redeem request holding the old claim.
        rec.attemptId = null
      } else if (action === 'release') {
        if (!['manual_review', 'redeeming', 'paying'].includes(rec.status)) {
          return {
            op: 'noop',
            result: { ok: false, error: `cannot release from status=${rec.status}` },
          }
        }
        rec.status = 'issued'
        rec.redeemingAt = null
        rec.attemptId = null
        rec.plId = null
      } else {
        // mark_redeemed
        if (!['manual_review', 'paying', 'redeeming'].includes(rec.status)) {
          return {
            op: 'noop',
            result: { ok: false, error: `cannot mark_redeemed from status=${rec.status}` },
          }
        }
        rec.status = 'redeemed'
        rec.redeemedAt = at
        rec.attemptId = null
      }
      rec.events.push({ kind: `admin_${action}`, at, detail: reason ? { reason } : undefined })
      return { op: 'set', value: JSON.stringify(rec), result: { ok: true, record: rec } }
    },
  )

  if (!outcome.ok) return json(409, { error: outcome.error })
  return json(200, { ok: true, coupon: outcome.record })
}

// ── GET /admin/coupon/get ────────────────────────────────────────────────────

export async function handleAdminGetCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  const denied = adminAuthorized(request, env)
  if (denied) return denied

  const code = new URL(request.url).searchParams.get('code')?.trim() ?? ''
  if (!CODE_RE.test(code)) return json(400, { error: 'code must be 8 digits' })
  const rec = parseRecord(await casRead(env, couponKey(code)))
  if (!rec) return json(404, { error: 'not found' })
  return json(200, { ok: true, coupon: rec })
}

// ── GET /coupon/status ───────────────────────────────────────────────────────
//
// Public, but goes through the same gate as redeem — a status probe is just
// as much of a code oracle as a redeem attempt. Unknown code → uniform error.

export async function handleCouponStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })

  const limited = await publicGate(request, env)
  if (limited) return limited

  const code = new URL(request.url).searchParams.get('code')?.trim() ?? ''
  if (!CODE_RE.test(code)) return invalidCoupon()

  const { locked } = await codeFailCheck(env, code)
  if (locked) return invalidCoupon()

  const rec = parseRecord(await casRead(env, couponKey(code)))
  if (!rec || rec.status === 'void') {
    await codeFailBump(env, code)
    return invalidCoupon()
  }

  const expired = rec.status === 'issued' && Date.parse(rec.expiresAt) < Date.now()
  return json(200, {
    ok: true,
    code: rec.code,
    // manual_review is presented as processing: the user's money may already
    // be moving and an operator is on it — "failed" would be both alarming
    // and possibly wrong.
    status: expired
      ? 'expired'
      : rec.status === 'manual_review' || rec.status === 'paying'
        ? 'processing'
        : rec.status,
    amountUsd: rec.amountUsd,
    expiresAt: rec.expiresAt,
    redeemedAt: rec.redeemedAt,
  })
}

// ── POST /coupon/redeem ──────────────────────────────────────────────────────

export async function handleRedeemCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  }

  const limited = await publicGate(request, env)
  if (limited) return limited

  let body: any
  try {
    body = await request.json()
  } catch {
    return invalidCoupon()
  }
  const code = String(body?.code ?? '').trim()
  const urlRaw = String(body?.url ?? body?.link ?? body?.payment_link ?? '').trim()
  const plId = urlRaw.startsWith('pl_') && /^pl_[A-Za-z0-9_-]+$/.test(urlRaw)
    ? urlRaw
    : extractPaymentLinkId(urlRaw)

  if (!CODE_RE.test(code) || !plId) {
    // Bad format is indistinguishable from a bad code on purpose.
    return invalidCoupon()
  }

  const { locked } = await codeFailCheck(env, code)
  if (locked) return invalidCoupon()

  const nowIso = () => new Date().toISOString()
  // Fences every post-claim transition: only the request holding this id may
  // roll back, advance to paying, or finalize. A stale re-claim or an admin
  // resolve overwrites attemptId, cutting the previous request off before it
  // can move money.
  const attemptId = crypto.randomUUID()

  // Step 1 — CAS claim: issued → redeeming. Everything that can fail before
  // this point returns the uniform error; after a successful claim the caller
  // has proven possession of a live coupon and gets specific errors.
  type ClaimResult =
    | { kind: 'claimed'; rec: CouponRecord }
    | { kind: 'processing' }
    | { kind: 'already_redeemed'; rec: CouponRecord }
    | { kind: 'rejected' }

  const claim = await casUpdate<ClaimResult>(env, couponKey(code), (raw) => {
    const rec = parseRecord(raw)
    if (!rec) return { op: 'noop', result: { kind: 'rejected' } }

    const now = Date.now()
    if (rec.status === 'issued') {
      if (Date.parse(rec.expiresAt) < now) return { op: 'noop', result: { kind: 'rejected' } }
      rec.status = 'redeeming'
      rec.redeemingAt = nowIso()
      rec.attemptId = attemptId
      rec.plId = plId
      rec.events.push({ kind: 'claim', at: rec.redeemingAt, detail: { plId } })
      return { op: 'set', value: JSON.stringify(rec), result: { kind: 'claimed', rec } }
    }

    if (rec.status === 'redeeming') {
      const claimedAt = rec.redeemingAt ? Date.parse(rec.redeemingAt) : 0
      const stale = now - claimedAt > REDEEMING_STALE_MS
      if (stale) {
        // Abandoned claim (worker died before `paying`) — safe to re-claim:
        // no pay-invoice call was made under the previous claim. Taking over
        // attemptId fences the previous request out of all later transitions.
        rec.redeemingAt = nowIso()
        rec.attemptId = attemptId
        rec.plId = plId
        rec.events.push({ kind: 'reclaim', at: rec.redeemingAt, detail: { plId } })
        return { op: 'set', value: JSON.stringify(rec), result: { kind: 'claimed', rec } }
      }
      if (rec.plId === plId) return { op: 'noop', result: { kind: 'processing' } }
      return { op: 'noop', result: { kind: 'rejected' } }
    }

    if (rec.status === 'paying' || rec.status === 'manual_review') {
      // Money may be in flight — same plId gets "processing", anything else
      // is rejected. NEVER re-claim from these states.
      if (rec.plId === plId) return { op: 'noop', result: { kind: 'processing' } }
      return { op: 'noop', result: { kind: 'rejected' } }
    }

    if (rec.status === 'redeemed') {
      // Idempotent success for the same (code, plId) pair.
      if (rec.plId === plId) return { op: 'noop', result: { kind: 'already_redeemed', rec } }
      return { op: 'noop', result: { kind: 'rejected' } }
    }

    // void or unknown state
    return { op: 'noop', result: { kind: 'rejected' } }
  })

  if (claim.kind === 'rejected') {
    await codeFailBump(env, code)
    return invalidCoupon()
  }
  if (claim.kind === 'processing') {
    return json(200, {
      ok: true,
      status: 'processing',
      message: 'Redemption is in progress. Check /coupon/status shortly.',
    })
  }
  if (claim.kind === 'already_redeemed') {
    return json(200, {
      ok: true,
      status: 'redeemed',
      code,
      plId,
      amountUsd: claim.rec.amountUsd,
      redeemedAt: claim.rec.redeemedAt,
    })
  }

  const rec = claim.rec
  const faceAtomic = BigInt(rec.amountAtomic)

  // Helper: roll OUR claim back to `issued`. ONLY legal before `paying`, and
  // only if this request still owns the claim (attemptId match) — otherwise a
  // slow request could roll back a newer claim that took over after staleness.
  const rollbackToIssued = async (reason: string) => {
    await casUpdate<null>(env, couponKey(code), (raw) => {
      const r = parseRecord(raw)
      if (!r || r.status !== 'redeeming' || r.attemptId !== attemptId) {
        return { op: 'noop', result: null }
      }
      r.status = 'issued'
      r.redeemingAt = null
      r.attemptId = null
      r.plId = null
      r.events.push({ kind: 'rollback', at: nowIso(), detail: { reason } })
      return { op: 'set', value: JSON.stringify(r), result: null }
    })
  }

  // Step 2 — quote the invoice and enforce the exact-amount policy.
  let quote: any
  try {
    const quoteResp = await fetch(QUOTE_INVOICE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': env.PAYINVOICE_ADMIN_SECRET,
      },
      body: JSON.stringify({ payment_id: plId }),
    })
    if (!quoteResp.ok) {
      const status = quoteResp.status
      await rollbackToIssued(`quote ${status}`)
      if (status === 409 || status === 410) {
        return json(status, {
          error: 'LINK_USED_OR_EXPIRED',
          message: 'This payment link has already been used or has expired. Create a new payment link and try again — your coupon is still valid.',
        })
      }
      return json(502, {
        error: 'QUOTE_UNAVAILABLE',
        message: 'Could not verify the payment link right now. Your coupon is still valid — try again in a minute.',
      })
    }
    quote = await quoteResp.json()
  } catch {
    await rollbackToIssued('quote unreachable')
    return json(502, {
      error: 'QUOTE_UNAVAILABLE',
      message: 'Could not verify the payment link right now. Your coupon is still valid — try again in a minute.',
    })
  }

  let invoiceAtomic: bigint
  try {
    invoiceAtomic = parseUsdc(String(quote?.invoice?.amount ?? ''))
  } catch {
    await rollbackToIssued('quote amount unparseable')
    return json(502, {
      error: 'QUOTE_UNAVAILABLE',
      message: 'Could not verify the payment link right now. Your coupon is still valid — try again in a minute.',
    })
  }

  if (invoiceAtomic !== faceAtomic) {
    await rollbackToIssued(
      `amount mismatch: invoice ${invoiceAtomic} != face ${faceAtomic}`,
    )
    return json(400, {
      error: 'AMOUNT_MISMATCH',
      message: `This coupon is for exactly $${rec.amountUsd}, but the payment link is for $${formatUsdc(invoiceAtomic)}. Create a payment link for exactly $${rec.amountUsd} — your coupon is still valid.`,
      couponAmountUsd: rec.amountUsd,
      invoiceAmountUsd: formatUsdc(invoiceAtomic),
    })
  }

  // Step 3 — funder balance gate. The decision and the reservation commit in
  // ONE CAS (tryReserveFunds) so concurrent redemptions of different coupons
  // cannot both pass a check the pool only covers once. If balance is
  // unreadable, attempt anyway without a reservation — same philosophy as the
  // webhook path; agentapi re-checks the funder balance as the final gate.
  const balanceResult = await getBaseUsdcBalance(FUNDER_WALLET, env.BASE_RPC_URL)
  const balance = balanceResult.balance
  let reservedFunds = false
  if (balance !== null) {
    const webhookReserved = await reservedAtomic(env)
    reservedFunds = await tryReserveFunds(env, attemptId, invoiceAtomic, balance, webhookReserved)
    if (!reservedFunds) {
      await rollbackToIssued(
        `insufficient funder balance: balance ${balance}, webhookReserved ${webhookReserved} < invoice ${invoiceAtomic}`,
      )
      if (env.DINGTALK_ACCESS_TOKEN) {
        await sendDingTalkAlert(
          env.DINGTALK_ACCESS_TOKEN,
          `[MPP Router] 🚨 Coupon redeem BLOCKED: insufficient funder balance (${formatUsdc(balance)} USDC on hand) for invoice ${formatUsdc(invoiceAtomic)} USDC. Coupon ${code} rolled back to issued. Top up the funder wallet.`,
        )
      }
      return json(503, {
        error: 'TEMPORARILY_UNAVAILABLE',
        message: 'Redemption is temporarily unavailable. Your coupon is still valid — try again later.',
      })
    }
  }

  // Step 4 — point of no return: redeeming → paying. From here on, failure
  // NEVER rolls back to issued (the pay call may have succeeded upstream even
  // when we see an error). Ambiguity parks in manual_review + ops alert.
  //
  // The transition must be WON, not assumed: if an admin voided/released the
  // coupon (or a stale re-claim took over) while we were quoting / checking
  // balance, our claim is gone and we must NOT move money.
  const enteredPaying = await casUpdate<boolean>(env, couponKey(code), (raw) => {
    const r = parseRecord(raw)
    if (!r || r.status !== 'redeeming' || r.attemptId !== attemptId) {
      return { op: 'noop', result: false }
    }
    r.status = 'paying'
    r.events.push({ kind: 'paying', at: nowIso() })
    return { op: 'set', value: JSON.stringify(r), result: true }
  })
  if (!enteredPaying) {
    if (reservedFunds) await releaseFunds(env, attemptId)
    return json(409, {
      error: 'STATE_CHANGED',
      message: 'The coupon state changed while processing (it may have been voided or claimed elsewhere). Check /coupon/status.',
    })
  }

  let payResult: { ok: boolean; status: number; body: any }
  try {
    payResult = await callAgentApiPayInvoice(env, plId)
  } catch (err: any) {
    payResult = { ok: false, status: 0, body: { error: err?.message ?? 'fetch threw' } }
  }
  if (reservedFunds) await releaseFunds(env, attemptId)

  // Finalization guard: only finalize OUR paying claim. If an admin touched
  // the record mid-payment (resolve), do not overwrite their decision — the
  // payment still happened, so alert for a manual reconcile instead.
  const finalize = (mutate: (r: CouponRecord) => void) =>
    casUpdate<CouponRecord | null>(env, couponKey(code), (raw) => {
      const r = parseRecord(raw)
      if (!r || r.status !== 'paying' || r.attemptId !== attemptId) {
        return { op: 'noop', result: null }
      }
      mutate(r)
      return { op: 'set', value: JSON.stringify(r), result: r }
    })

  if (payResult.ok) {
    const finalRec = await finalize((r) => {
      r.status = 'redeemed'
      r.redeemedAt = nowIso()
      r.coinbaseResult = payResult.body
      r.events.push({ kind: 'pay_invoice_succeeded', at: r.redeemedAt!, detail: { status: payResult.status } })
    })
    if (!finalRec && env.DINGTALK_ACCESS_TOKEN) {
      await sendDingTalkAlert(
        env.DINGTALK_ACCESS_TOKEN,
        `[MPP Router] ⚠️ Coupon ${code} paid successfully but its record was modified mid-payment (admin resolve?). Reconcile manually: invoice ${plId} IS settled.`,
      )
    }
    return json(200, {
      ok: true,
      status: 'redeemed',
      code,
      plId,
      amountUsd: rec.amountUsd,
      redeemedAt: finalRec?.redeemedAt ?? nowIso(),
    })
  }

  // Failure after the pay attempt — ambiguous by definition. Park it.
  const parked = await finalize((r) => {
    r.status = 'manual_review'
    r.failureReason = `agentapi pay-invoice ${payResult.status}`
    r.events.push({
      kind: 'pay_invoice_failed',
      at: nowIso(),
      detail: { status: payResult.status, body: payResult.body },
    })
  })
  if (!parked && env.DINGTALK_ACCESS_TOKEN) {
    await sendDingTalkAlert(
      env.DINGTALK_ACCESS_TOKEN,
      `[MPP Router] ⚠️ Coupon ${code}: pay-invoice failed (${payResult.status}) AND the record was modified mid-payment. Reconcile ${plId} manually.`,
    )
  }
  if (env.DINGTALK_ACCESS_TOKEN) {
    await sendDingTalkAlert(
      env.DINGTALK_ACCESS_TOKEN,
      `[MPP Router] 🚨 Coupon redemption needs MANUAL REVIEW: pay-invoice returned ${payResult.status} for coupon ${code} / ${plId} (${rec.amountUsd} USD). Check invoice-status + Coinbase before releasing or marking redeemed (/admin/coupon/resolve).`,
    )
  }
  return json(200, {
    ok: true,
    status: 'processing',
    message: 'Redemption is being processed. If it does not complete within 10 minutes, contact support with your coupon code.',
  })
}
