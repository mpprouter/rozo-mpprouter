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
import { extractCoinbaseCheckoutId } from './pay-invoice-admin'
import { parseUsdc, formatUsdc } from './create-invoice'
import { callAgentApiPayInvoice, reservedAtomic, FUNDER_WALLET } from './webhook'
import { getBaseUsdcBalance } from '../utils/base-usdc-balance'
import { sendDingTalkAlert } from '../utils/dingtalk'
import { identifierKeys } from '../utils/redact'
import { verifyTurnstile } from './coupon-turnstile'
import {
  auditEvent,
  bumpFailure,
  checkFreezes,
  evaluateTraffic,
  readCircuit,
  maybePruneAudit,
  reopenCircuit,
  type AuditResult,
  type CasClient,
} from './coupon-security'
import { redactForAlert } from '../utils/alert-redaction'

// ── Tunables ─────────────────────────────────────────────────────────────────

// 12h (founder 2026-07-07): long enough that a Goofish buyer can redeem at
// their leisure, while the global circuit breaker (not the TTL) caps total
// brute-force attempts — at 500/h global, a 12h window allows at most 6000
// guesses network-wide (~0.06% hit chance with 10 live coupons in 10^8 space).
const DEFAULT_EXPIRES_MINUTES = 12 * 60
// Fat-finger guard on issuance. Goofish orders are typically $5–$50; raised to
// $1050 (founder 2026-08-06) so a single 1000-credit coupon (1000 × 1.05) fits.
const MAX_FACE_VALUE_ATOMIC = 1_050_000_000n // $1050
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
  /**
   * Partner-platform fields (ainative todos/20260807-coupon-reseller-platform.md).
   * NULL/absent on every coupon issued before 2026-08-07 and on everything the
   * admin path issues — readers must tolerate that.
   */
  partnerId?: string | null
  /** Op id of the debit that paid for this coupon. Reconcile matches on
   * partnerId + issueLedgerId together; "the key exists" alone would confirm a
   * collision with someone else's coupon. */
  issueLedgerId?: string | null
  /** Ledger entry that returned the money. Separate from issueLedgerId because
   * a coupon writes TWO ledger rows over its life (debit on issue, credit on
   * void/expiry) and one field would clobber the first with the second. */
  refundLedgerId?: string | null
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

export async function casUpdate<R>(
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

export async function casRead(env: Env, key: string): Promise<string | null> {
  const r = await doPost<ReadResponse>(couponStub(env), '/read', { key })
  return r.value
}

/**
 * Adapt the coupon-DO CAS primitives into the CasClient interface consumed by
 * coupon-security.ts, so all security counters/circuit/freeze state live on the
 * SAME "coupon" DO instance as the coupon records — one linearizable domain.
 */
function casClient(env: Env): CasClient {
  return {
    casUpdate: (key, fn, maxRetries) => casUpdate(env, key, fn, maxRetries),
    casRead: (key) => casRead(env, key),
  }
}

// Circuit-open / degraded response. Deliberately distinct wording from the
// per-code uniform error: this is a service-wide pause, not a statement about
// any particular code (design §"熔断期间统一返回").
function serviceUnavailable(): Response {
  return json(503, {
    error: 'TEMPORARILY_UNAVAILABLE',
    message: 'Redemption is temporarily unavailable. Please try again later.',
  })
}

export function couponKey(code: string) {
  return `coupon:${code}`
}

export function parseRecord(raw: string | null): CouponRecord | null {
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
          redactForAlert(`[MPP Router] 🚨 Coupon redeem global circuit breaker OPEN: >${GLOBAL_LIMIT_PER_HOUR} attempts this hour. Redemption paused for the window.`),
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
  // 2026-08-07 (founder): widened 8 -> 10 digits. Live-coupon count scales the
  // brute-force hit rate linearly (see ainative
  // todos/20260807-coupon-reseller-platform.md §9.2), and the partner platform
  // multiplies how many coupons are live at once. 10^8 -> 10^10 drops the 12h
  // hit chance at ~100 live coupons from 0.6% to 0.006%.
  //
  // A single Uint32 CANNOT back a 10-digit space: 2^32 ≈ 4.29e9 < 1e10, so
  // `% 1e10` on one uint32 would make more than half the codes unreachable
  // (you cannot get more entropy out than the source has). Draw 64 bits.
  //
  // UX cost of the longer code is ~0: since 2026-07-07 operators hand out a
  // claimUrl (?code= prefills the field), so nobody types the digits.
  for (;;) {
    const buf = new Uint32Array(2)
    crypto.getRandomValues(buf)
    const n = (BigInt(buf[0]) << 32n) | BigInt(buf[1])
    // Rejection sampling against the largest multiple of SPACE that fits in
    // 2^64 — an unbiased draw. Rejection probability ≈ 1.7e-9.
    if (n < CODE_SAMPLE_LIMIT) return (n % CODE_SPACE).toString().padStart(10, '0')
  }
}

const CODE_SPACE = 10_000_000_000n // 10^10
const CODE_SAMPLE_LIMIT = (2n ** 64n / CODE_SPACE) * CODE_SPACE

// Accepts BOTH lengths during (and after) the migration: 8-digit codes issued
// before 2026-08-07 stay redeemable until they expire (max 7 days out), while
// every newly issued code is 10 digits. Shared by redeem, /admin/coupon/get and
// /admin/coupon/resolve — changing it here covers all three.
//
// Both lengths take the SAME lookup path and return the SAME invalidCoupon()
// body on every pre-claim failure, so the length split adds no oracle. Timing
// parity is explicitly NOT a goal (founder 2026-08-07: exposure is a few
// hundred USD; no side-channel hardening).
export const CODE_RE = /^(?:\d{8}|\d{10})$/

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
      ? Math.min(body.expiresInMinutes, 60 * 24 * 14) // hard cap: 14 days (2026-08-07)
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
        // 2026-07-07 founder request: hand operators a clickable link instead
        // of a bare 8-digit code, so the redeem page can look the coupon up by
        // ?code= and show its face value + one-tap redeem (see claim.html).
        // Hardcoded prod domain, deliberately not an env var — this is a
        // public-facing marketing domain, not an infra endpoint.
        // 2026-07-12 founder request: drop the utm_source/utm_medium params.
        // Goofish is the only channel handing these out, so the attribution
        // tags add no signal and just make the link longer / harder to copy
        // out of the Feishu message. Keep the URL as short as possible.
        claimUrl: `https://open.rozo.ai/claim?code=${code}`,
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
  if (!CODE_RE.test(code)) return json(400, { error: 'code must be 8 or 10 digits' })
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
  if (!CODE_RE.test(code)) return json(400, { error: 'code must be 8 or 10 digits' })
  const rec = parseRecord(await casRead(env, couponKey(code)))
  if (!rec) return json(404, { error: 'not found' })
  return json(200, { ok: true, coupon: rec })
}

// NOTE: the public GET /coupon/status handler was REMOVED (design 20260722).
// Status-by-code is a brute-force oracle for the 8-digit space — it leaked
// amount / existence / expiry / used-state before any redemption. Operators
// inspect coupons via the authenticated /admin/coupon/get; the redeem POST
// returns terminal status inline for the redeeming user.

// ── POST /coupon/redeem ──────────────────────────────────────────────────────

export async function handleRedeemCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })

  // Redaction requires the HMAC key. Fail closed on a money endpoint if it is
  // not configured — we must never write a plaintext-derivable audit row.
  if (!env.COUPON_HASH_SECRET) {
    return json(500, { error: 'COUPON_HASH_SECRET is not configured' })
  }

  const cas = casClient(env)
  const now = Date.now()
  const requestId = crypto.randomUUID()
  const ip = request.headers.get('cf-connecting-ip')

  // Parse the body up-front so every branch (including malformed) can be
  // audited with whatever identifiers were present. Never trust a client to
  // extract the payment id — always re-extract server-side.
  let body: any = null
  try {
    body = await request.json()
  } catch {
    /* malformed — audited below as such */
  }
  const code = String(body?.code ?? '').trim()
  const turnstileToken = typeof body?.turnstileToken === 'string' ? body.turnstileToken : null
  const urlRaw = String(body?.url ?? body?.link ?? body?.payment_link ?? '').trim()
  const plId =
    /^(?:pl_[A-Za-z0-9_-]+|paymentSession_[A-Za-z0-9_-]+)$/.test(urlRaw)
      ? urlRaw
      : extractCoinbaseCheckoutId(urlRaw)

  const validCode = CODE_RE.test(code) ? code : null
  const ids = await identifierKeys(env.COUPON_HASH_SECRET, {
    code: validCode,
    paymentId: plId,
    ip,
  })

  // Every outcome flows through here: write ONE redacted audit row (and, for a
  // failure, bump the per-identifier freeze counters) then return the response.
  let turnstilePassed = false
  const done = async (
    resp: Response,
    result: AuditResult,
    failureReason: string | null,
  ): Promise<Response> => {
    await auditEvent(env, {
      requestId,
      createdAt: now,
      result,
      failureReason,
      codeHash: ids.code,
      paymentIdHash: ids.paymentId,
      pairHash: ids.pair,
      ipPrefixHash: ids.ipPrefix,
      turnstilePassed,
    })
    if (result === 'failure') {
      await bumpFailure(cas, ids, now).catch(() => {})
    }
    await maybePruneAudit(env, now).catch(() => {})
    return resp
  }

  if (!env.PAYINVOICE_ADMIN_SECRET) {
    // Config error — audit as rejected (no identifier freeze; not the user's fault).
    return done(json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' }), 'rejected', 'not_configured')
  }

  // ── Already-open circuit blocks FIRST (durable, survives restarts) ──
  // A read-only short-circuit before any counting or per-IP work: an open
  // breaker must stop every request regardless of source, and rejected-
  // while-open requests are audited.
  try {
    if ((await readCircuit(cas)).open) {
      return done(serviceUnavailable(), 'rejected', 'circuit_open')
    }
  } catch (err) {
    console.warn(`[coupon] circuit read error (fail closed): ${err instanceof Error ? err.message : String(err)}`)
    return done(serviceUnavailable(), 'rejected', 'circuit_read_error')
  }

  // ── Per-IP + hourly-global budget FIRST (existing gate) ──
  // P1 (codex 2026-07-22): the global rolling-window count must run only for
  // requests that PASS their per-IP quota. Otherwise a single IP could send
  // 101 POSTs and open the global breaker alone — a service-wide DoS. Gating
  // the global counter behind per-IP (max IP_LIMIT_PER_HOUR = 20/IP/hr) means
  // tripping the 101/10-min global threshold genuinely requires many distinct
  // IPs (a real distributed attack), not one abuser.
  const limited = await publicGate(request, env)
  if (limited) return done(limited, 'rejected', 'rate_limited')

  // ── Global rolling-window gate (counts every per-IP-allowed POST across all
  //    IPs, before any payment work). Opens the circuit / fires the warning. ──
  let traffic
  try {
    traffic = await evaluateTraffic(cas, now)
  } catch (err) {
    console.warn(`[coupon] traffic gate error (fail closed): ${err instanceof Error ? err.message : String(err)}`)
    return done(serviceUnavailable(), 'rejected', 'traffic_gate_error')
  }
  if (traffic.action === 'circuit_open') {
    if (traffic.justOpened && env.DINGTALK_ACCESS_TOKEN) {
      // Alert carries only volume/window/time — never a code, payment id, or link.
      await sendDingTalkAlert(
        env.DINGTALK_ACCESS_TOKEN,
        redactForAlert(`[MPP Router] 🚨 Coupon redeem GLOBAL CIRCUIT OPEN at ${new Date(now).toISOString()}: >100 per-IP-allowed redeem POSTs in 10 min across many IPs. Automatic redemption STOPPED until an operator reopens it (POST /admin/coupon/circuit/reopen).`),
      )
    }
    return done(serviceUnavailable(), 'rejected', 'circuit_open')
  }
  if (traffic.warnFired && env.DINGTALK_ACCESS_TOKEN) {
    await sendDingTalkAlert(
      env.DINGTALK_ACCESS_TOKEN,
      redactForAlert(`[MPP Router] ⚠️ Coupon redeem traffic spike at ${new Date(now).toISOString()}: >20 per-IP-allowed redeem POSTs in 1 min. Throttling tightened; watching for the 10-min circuit threshold.`),
    )
  }

  // ── Turnstile (server-verified, before any payment work) ──
  const turnstile = await verifyTurnstile(env, turnstileToken, ip)
  if (turnstile.ok) {
    turnstilePassed = true
  } else if (turnstile.reason !== 'notConfigured') {
    // Configured but token missing/forged/replayed/wrong host-or-action →
    // uniform failure. `notConfigured` (staged rollout) falls through.
    return done(invalidCoupon(), 'failure', `turnstile_${turnstile.reason}`)
  }

  if (!validCode || !plId) {
    // Bad format is indistinguishable from a bad code on purpose. No code freeze
    // when the code itself was malformed (ids.code is null); ip freeze still bumps.
    return done(invalidCoupon(), 'failure', 'malformed')
  }

  // ── Per-identifier temporary freezes (pair / code / paymentId / ip) ──
  const frozen = await checkFreezes(cas, ids, now)
  if (frozen) {
    return done(invalidCoupon(), 'rejected', `frozen_${frozen}`)
  }

  const { locked } = await codeFailCheck(env, code)
  if (locked) return done(invalidCoupon(), 'failure', 'code_locked')

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
    return done(invalidCoupon(), 'failure', 'claim_rejected')
  }
  if (claim.kind === 'processing') {
    return done(
      json(200, {
        ok: true,
        status: 'processing',
        message: 'Redemption is in progress. Check /coupon/status shortly.',
      }),
      'rejected',
      'in_progress',
    )
  }
  if (claim.kind === 'already_redeemed') {
    return done(
      json(200, {
        ok: true,
        status: 'redeemed',
        code,
        plId,
        amountUsd: claim.rec.amountUsd,
        redeemedAt: claim.rec.redeemedAt,
      }),
      'success',
      'already_redeemed',
    )
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
        return done(
          json(status, {
            error: 'LINK_USED_OR_EXPIRED',
            message: 'This payment link has already been used or has expired. Create a new payment link and try again — your coupon is still valid.',
          }),
          'failure',
          'link_used_or_expired',
        )
      }
      return done(
        json(502, {
          error: 'QUOTE_UNAVAILABLE',
          message: 'Could not verify the payment link right now. Your coupon is still valid — try again in a minute.',
        }),
        'rejected',
        'quote_unavailable',
      )
    }
    quote = await quoteResp.json()
  } catch {
    await rollbackToIssued('quote unreachable')
    return done(
      json(502, {
        error: 'QUOTE_UNAVAILABLE',
        message: 'Could not verify the payment link right now. Your coupon is still valid — try again in a minute.',
      }),
      'rejected',
      'quote_unreachable',
    )
  }

  let invoiceAtomic: bigint
  try {
    invoiceAtomic = parseUsdc(String(quote?.invoice?.amount ?? ''))
  } catch {
    await rollbackToIssued('quote amount unparseable')
    return done(
      json(502, {
        error: 'QUOTE_UNAVAILABLE',
        message: 'Could not verify the payment link right now. Your coupon is still valid — try again in a minute.',
      }),
      'rejected',
      'quote_unparseable',
    )
  }

  if (invoiceAtomic !== faceAtomic) {
    await rollbackToIssued(
      `amount mismatch: invoice ${invoiceAtomic} != face ${faceAtomic}`,
    )
    return done(
      json(400, {
        error: 'AMOUNT_MISMATCH',
        message: `This coupon is for exactly $${rec.amountUsd}, but the payment link is for $${formatUsdc(invoiceAtomic)}. Create a payment link for exactly $${rec.amountUsd} — your coupon is still valid.`,
        couponAmountUsd: rec.amountUsd,
        invoiceAmountUsd: formatUsdc(invoiceAtomic),
      }),
      'failure',
      'amount_mismatch',
    )
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
    // Founder decision 2026-08-27: do not count webhook reservations against
    // coupon redemptions — the best-effort counter drifts (leaked $75.22 and
    // blocked a valid $525 redeem). Coupon-vs-coupon CAS still applies below;
    // agentapi re-checks the real funder balance as the final gate.
    const webhookReserved = 0n
    reservedFunds = await tryReserveFunds(env, attemptId, invoiceAtomic, balance, webhookReserved)
    if (!reservedFunds) {
      await rollbackToIssued(
        `insufficient funder balance: balance ${balance}, webhookReserved ${webhookReserved} < invoice ${invoiceAtomic}`,
      )
      if (env.DINGTALK_ACCESS_TOKEN) {
        await sendDingTalkAlert(
          env.DINGTALK_ACCESS_TOKEN,
          redactForAlert(`[MPP Router] 🚨 Coupon redeem BLOCKED: insufficient funder balance (${formatUsdc(balance)} USDC on hand) for invoice ${formatUsdc(invoiceAtomic)} USDC. Coupon ${code} rolled back to issued. Top up the funder wallet.`),
        )
      }
      return done(
        json(503, {
          error: 'TEMPORARILY_UNAVAILABLE',
          message: 'Redemption is temporarily unavailable. Your coupon is still valid — try again later.',
        }),
        'rejected',
        'insufficient_funds',
      )
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
    return done(
      json(409, {
        error: 'STATE_CHANGED',
        message: 'The coupon state changed while processing (it may have been voided or claimed elsewhere). Check /coupon/status.',
      }),
      'rejected',
      'state_changed',
    )
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
        redactForAlert(`[MPP Router] ⚠️ Coupon ${code} paid successfully but its record was modified mid-payment (admin resolve?). Reconcile manually: invoice ${plId} IS settled.`),
      )
    }
    return done(
      json(200, {
        ok: true,
        status: 'redeemed',
        code,
        plId,
        amountUsd: rec.amountUsd,
        redeemedAt: finalRec?.redeemedAt ?? nowIso(),
      }),
      'success',
      'redeemed',
    )
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
      redactForAlert(`[MPP Router] ⚠️ Coupon ${code}: pay-invoice failed (${payResult.status}) AND the record was modified mid-payment. Reconcile ${plId} manually.`),
    )
  }
  if (env.DINGTALK_ACCESS_TOKEN) {
    await sendDingTalkAlert(
      env.DINGTALK_ACCESS_TOKEN,
      redactForAlert(`[MPP Router] 🚨 Coupon redemption needs MANUAL REVIEW: pay-invoice returned ${payResult.status} for coupon ${code} / ${plId} (${rec.amountUsd} USD). Check invoice-status + Coinbase before releasing or marking redeemed (/admin/coupon/resolve).`),
    )
  }
  return done(
    json(200, {
      ok: true,
      status: 'processing',
      message: 'Redemption is being processed. If it does not complete within 10 minutes, contact support with your coupon code.',
    }),
    'rejected',
    'manual_review',
  )
}

// ── POST /admin/coupon/circuit/reopen ────────────────────────────────────────
//
// Authenticated recovery for the global circuit breaker. A Worker restart does
// NOT clear the breaker (state is durable in the coupon DO); only this
// authenticated action does, and the recovery is audited.

export async function handleReopenCircuit(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const denied = adminAuthorized(request, env)
  if (denied) return denied

  const cas = casClient(env)
  const now = Date.now()
  const prior = await reopenCircuit(cas, now)

  // Audit the recovery with a redacted IP prefix (no code/payment id involved).
  if (env.COUPON_HASH_SECRET) {
    const ids = await identifierKeys(env.COUPON_HASH_SECRET, {
      ip: request.headers.get('cf-connecting-ip'),
    })
    await auditEvent(env, {
      requestId: crypto.randomUUID(),
      createdAt: now,
      result: 'rejected',
      failureReason: prior.open ? 'admin_circuit_reopen' : 'admin_circuit_reopen_noop',
      codeHash: null,
      paymentIdHash: null,
      pairHash: null,
      ipPrefixHash: ids.ipPrefix,
      turnstilePassed: false,
    })
  }

  if (env.DINGTALK_ACCESS_TOKEN) {
    await sendDingTalkAlert(
      env.DINGTALK_ACCESS_TOKEN,
      redactForAlert(`[MPP Router] ✅ Coupon redeem circuit REOPENED by admin at ${new Date(now).toISOString()} (was ${prior.open ? 'OPEN' : 'already closed'}). Automatic redemption resumed.`),
    )
  }

  return json(200, { ok: true, wasOpen: prior.open, reopenedAt: new Date(now).toISOString() })
}
