/**
 * Coupon abuse-protection core (design: ainative/todos/20260722-mpprouter-
 * coupon-claim-security.md).
 *
 * Two storage tiers, deliberately separated:
 *
 *   • Durable Object ("coupon" AtomicStoreDO instance) — real-time, strongly
 *     consistent: rolling-window request counters, the global circuit-breaker
 *     state, and per-identifier failure freezes. Every pre-payment decision
 *     reads here so concurrent isolates cannot each independently decide
 *     "under the limit". Circuit state is durable, so it survives Worker
 *     restarts and only an authenticated admin action reopens it.
 *
 *   • Cloudflare D1 (MPPRouter-specific) — append-only historical audit of
 *     every redeem POST outcome, storing ONLY keyed HMAC digests. Never the
 *     Rozo Intents Supabase.
 *
 * This module owns the DO-side security keys (rw:*, cb:*, frz:*) and the D1
 * writer/pruner. It reuses the same casUpdate primitive as coupon.ts via the
 * injected `cas` client so all coupon-DO state is one linearizable domain.
 */

import type { Env } from '../index'

// ── Thresholds (design §"全局攻击熔断" / §"不要失败 5 次就永久作废") ──────────

// Rolling 1-minute window: the 21st request triggers stronger throttling +
// one DingTalk warning. (20 allowed, 21 warns.)
export const WARN_WINDOW_MS = 60_000
export const WARN_THRESHOLD = 20

// Rolling 10-minute window: the 101st request opens the global circuit.
// (100 allowed, 101 opens.)
export const CIRCUIT_WINDOW_MS = 10 * 60_000
export const CIRCUIT_THRESHOLD = 100

// Per-identifier failures before a temporary freeze.
export const FAIL_THRESHOLD = 5
// pair (code+paymentId) freeze duration.
export const PAIR_FREEZE_MS = 60 * 60_000 // 1h
// code / paymentId / ip identifier-level freeze (risk review, NOT a permanent
// void of a victim's coupon). Shorter than the pair freeze on purpose.
export const IDENTIFIER_FREEZE_MS = 30 * 60_000 // 30m
// Failure counters reset after this idle window if the threshold isn't reached.
export const FAIL_WINDOW_MS = 60 * 60_000 // 1h

// D1 retention: prune audit rows older than this on a sampled basis.
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000 // 30 days

// ── CAS client shape (injected from coupon.ts to share one DO domain) ────────

type CasChange<R> =
  | { op: 'set'; value: string; result: R }
  | { op: 'noop'; result: R }

export interface CasClient {
  casUpdate<R>(
    key: string,
    fn: (current: string | null) => CasChange<R>,
    maxRetries?: number,
  ): Promise<R>
  casRead(key: string): Promise<string | null>
}

const MAX_CAS_RETRIES = 25

// ── Rolling-window counter (timestamp ring, exact within the window) ─────────
//
// A fixed-window counter would let 2×threshold requests through across a window
// boundary. The design says "rolling", so we keep a bounded list of recent
// request timestamps and count those still inside the window. The list is
// pruned on every bump and hard-capped so a flood cannot grow DO storage
// unbounded — once we are already over the threshold, exact counts past the cap
// don't change the decision.

interface RollingState {
  ts: number[]
}

function parseRolling(raw: string | null): RollingState {
  if (!raw) return { ts: [] }
  try {
    const s = JSON.parse(raw) as RollingState
    return s && Array.isArray(s.ts) ? s : { ts: [] }
  } catch {
    return { ts: [] }
  }
}

const ROLLING_HARD_CAP = 2000

/**
 * Record one request in the rolling window and return how many requests
 * (including this one) fall inside `windowMs`. Single CAS = concurrency-safe:
 * two isolates cannot both read "20" and each think they're the 21st-and-only.
 */
async function bumpRolling(
  cas: CasClient,
  key: string,
  windowMs: number,
  now: number,
): Promise<number> {
  return cas.casUpdate<number>(
    key,
    (raw) => {
      const s = parseRolling(raw)
      const cutoff = now - windowMs
      let ts = s.ts.filter((t) => t > cutoff)
      ts.push(now)
      if (ts.length > ROLLING_HARD_CAP) ts = ts.slice(ts.length - ROLLING_HARD_CAP)
      return { op: 'set', value: JSON.stringify({ ts }), result: ts.length }
    },
    MAX_CAS_RETRIES,
  )
}

// ── Global circuit breaker (durable) ─────────────────────────────────────────

const CIRCUIT_KEY = 'cb:global'
const WARN_MARK_KEY = 'cb:warned' // once-per-window de-dupe for the 1-min warning

export interface CircuitState {
  open: boolean
  openedAt: number | null
  openedReason: string | null
  reopenedAt: number | null
}

function parseCircuit(raw: string | null): CircuitState {
  if (!raw) return { open: false, openedAt: null, openedReason: null, reopenedAt: null }
  try {
    const s = JSON.parse(raw) as CircuitState
    return s && typeof s.open === 'boolean'
      ? s
      : { open: false, openedAt: null, openedReason: null, reopenedAt: null }
  } catch {
    return { open: false, openedAt: null, openedReason: null, reopenedAt: null }
  }
}

export async function readCircuit(cas: CasClient): Promise<CircuitState> {
  return parseCircuit(await cas.casRead(CIRCUIT_KEY))
}

/** Open the circuit if not already open. Returns true iff THIS call opened it
 *  (so the caller alerts exactly once). Idempotent under concurrency. */
async function openCircuit(cas: CasClient, reason: string, now: number): Promise<boolean> {
  return cas.casUpdate<boolean>(
    CIRCUIT_KEY,
    (raw) => {
      const s = parseCircuit(raw)
      if (s.open) return { op: 'noop', result: false }
      const next: CircuitState = { open: true, openedAt: now, openedReason: reason, reopenedAt: null }
      return { op: 'set', value: JSON.stringify(next), result: true }
    },
    MAX_CAS_RETRIES,
  )
}

/** Authenticated admin reopen. Returns the prior state so the caller can audit
 *  whether it was actually open. Only this path may clear the circuit — a
 *  Worker restart does NOT, because state is durable in the DO.
 *
 *  Also resets the rolling-window request counters: without this, the same
 *  flood still recorded in the 10-min window would immediately re-trip the
 *  breaker the instant it is reopened, making recovery impossible. Clearing the
 *  windows gives the operator a clean slate to resume from. */
export async function reopenCircuit(cas: CasClient, now: number): Promise<CircuitState> {
  const empty = JSON.stringify({ ts: [] })
  await cas.casUpdate<null>('rw:10m', () => ({ op: 'set', value: empty, result: null }), MAX_CAS_RETRIES)
  await cas.casUpdate<null>('rw:1m', () => ({ op: 'set', value: empty, result: null }), MAX_CAS_RETRIES)
  return cas.casUpdate<CircuitState>(
    CIRCUIT_KEY,
    (raw) => {
      const prior = parseCircuit(raw)
      const next: CircuitState = {
        open: false,
        openedAt: null,
        openedReason: null,
        reopenedAt: now,
      }
      return { op: 'set', value: JSON.stringify(next), result: prior }
    },
    MAX_CAS_RETRIES,
  )
}

/** Once-per-1-min-window de-dupe for the warning DingTalk. Returns true iff
 *  this call is the first to cross the warn threshold in the current window. */
async function markWarned(cas: CasClient, now: number): Promise<boolean> {
  return cas.casUpdate<boolean>(
    WARN_MARK_KEY,
    (raw) => {
      const last = raw ? Number(raw) : 0
      if (now - last < WARN_WINDOW_MS) return { op: 'noop', result: false }
      return { op: 'set', value: String(now), result: true }
    },
    MAX_CAS_RETRIES,
  )
}

// ── Global traffic gate (called on EVERY redeem POST, before payment work) ───

export type TrafficDecision =
  | { action: 'proceed'; warnFired: boolean }
  | { action: 'circuit_open'; justOpened: boolean }

/**
 * Count this request in both rolling windows and decide. Circuit is checked
 * FIRST (durable) so an already-open breaker blocks before any counting cost
 * and stays blocked across isolates/restarts.
 */
export async function evaluateTraffic(cas: CasClient, now: number): Promise<TrafficDecision> {
  const circuit = await readCircuit(cas)
  if (circuit.open) {
    return { action: 'circuit_open', justOpened: false }
  }

  // Count in the 10-min window first: if this request opens the circuit we
  // want the circuit signal to win over the 1-min warning.
  const tenMinCount = await bumpRolling(cas, 'rw:10m', CIRCUIT_WINDOW_MS, now)
  if (tenMinCount > CIRCUIT_THRESHOLD) {
    const justOpened = await openCircuit(cas, `>${CIRCUIT_THRESHOLD} redeem POSTs in 10 min`, now)
    return { action: 'circuit_open', justOpened }
  }

  const oneMinCount = await bumpRolling(cas, 'rw:1m', WARN_WINDOW_MS, now)
  let warnFired = false
  if (oneMinCount > WARN_THRESHOLD) {
    warnFired = await markWarned(cas, now)
  }
  return { action: 'proceed', warnFired }
}

// ── Per-identifier failure freezes ───────────────────────────────────────────

interface FreezeState {
  n: number
  windowStart: number
  frozenUntil?: number
}

function parseFreeze(raw: string | null): FreezeState {
  if (!raw) return { n: 0, windowStart: 0 }
  try {
    return JSON.parse(raw) as FreezeState
  } catch {
    return { n: 0, windowStart: 0 }
  }
}

function freezeKey(kind: string, hash: string): string {
  return `frz:${kind}:${hash}`
}

/** True iff this identifier is currently frozen. Read-only (no mutation). */
async function isFrozen(cas: CasClient, kind: string, hash: string, now: number): Promise<boolean> {
  const s = parseFreeze(await cas.casRead(freezeKey(kind, hash)))
  return !!s.frozenUntil && now < s.frozenUntil
}

/**
 * Check every identifier freeze for an incoming attempt. Returns the first
 * frozen dimension (for audit labeling) or null when clear. `pair` is checked
 * first because it's the most specific and least collateral-prone.
 */
export async function checkFreezes(
  cas: CasClient,
  ids: { code: string | null; paymentId: string | null; pair: string | null; ipPrefix: string },
  now: number,
): Promise<null | 'pair' | 'code' | 'paymentId' | 'ip'> {
  if (ids.pair && (await isFrozen(cas, 'pair', ids.pair, now))) return 'pair'
  if (ids.code && (await isFrozen(cas, 'code', ids.code, now))) return 'code'
  if (ids.paymentId && (await isFrozen(cas, 'pid', ids.paymentId, now))) return 'paymentId'
  if (await isFrozen(cas, 'ip', ids.ipPrefix, now)) return 'ip'
  return null
}

async function bumpFreeze(
  cas: CasClient,
  kind: string,
  hash: string,
  freezeMs: number,
  now: number,
): Promise<void> {
  await cas.casUpdate<null>(
    freezeKey(kind, hash),
    (raw) => {
      const s = parseFreeze(raw)
      // If already frozen, don't extend/reset — an attacker shouldn't be able
      // to indefinitely prolong a victim identifier's freeze by hammering it.
      if (s.frozenUntil && now < s.frozenUntil) return { op: 'noop', result: null }
      const inWindow = now - s.windowStart < FAIL_WINDOW_MS
      const n = (inWindow ? s.n : 0) + 1
      const next: FreezeState = {
        n,
        windowStart: inWindow ? s.windowStart || now : now,
        ...(n >= FAIL_THRESHOLD ? { frozenUntil: now + freezeMs } : {}),
      }
      return { op: 'set', value: JSON.stringify(next), result: null }
    },
    MAX_CAS_RETRIES,
  )
}

/**
 * Record ONE failed attempt against every identifier dimension. Five failures
 * on a (code+paymentId) pair freeze the pair for 1h; five on a bare code /
 * paymentId / ip freeze that dimension for a shorter risk-review window. These
 * are TEMPORARY freezes — they never permanently void a coupon (only success,
 * expiry, or an authenticated admin action does that).
 */
export async function bumpFailure(
  cas: CasClient,
  ids: { code: string | null; paymentId: string | null; pair: string | null; ipPrefix: string },
  now: number,
): Promise<void> {
  const jobs: Promise<void>[] = []
  if (ids.pair) jobs.push(bumpFreeze(cas, 'pair', ids.pair, PAIR_FREEZE_MS, now))
  if (ids.code) jobs.push(bumpFreeze(cas, 'code', ids.code, IDENTIFIER_FREEZE_MS, now))
  if (ids.paymentId) jobs.push(bumpFreeze(cas, 'pid', ids.paymentId, IDENTIFIER_FREEZE_MS, now))
  jobs.push(bumpFreeze(cas, 'ip', ids.ipPrefix, IDENTIFIER_FREEZE_MS, now))
  await Promise.all(jobs)
}

// ── D1 audit writer + pruner ─────────────────────────────────────────────────

export type AuditResult = 'success' | 'failure' | 'rejected'

export interface AuditEvent {
  requestId: string
  createdAt: number
  result: AuditResult
  failureReason: string | null
  codeHash: string | null
  paymentIdHash: string | null
  pairHash: string | null
  ipPrefixHash: string
  turnstilePassed: boolean
}

/**
 * Append one audit row. Never throws — an audit-write failure must not break
 * (or, worse, roll back) a redemption. Best-effort, logged, swallowed.
 * When no D1 binding is configured (e.g. a staged rollout before the DB is
 * provisioned) this is a silent no-op so the redeem path keeps working.
 */
export async function auditEvent(env: Env, ev: AuditEvent): Promise<void> {
  const db = env.COUPON_SECURITY_DB
  if (!db) return
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO coupon_security_events
           (request_id, created_at, result, failure_reason,
            code_hash, payment_id_hash, pair_hash, ip_prefix_hash, turnstile_passed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        ev.requestId,
        ev.createdAt,
        ev.result,
        ev.failureReason,
        ev.codeHash,
        ev.paymentIdHash,
        ev.pairHash,
        ev.ipPrefixHash,
        ev.turnstilePassed ? 1 : 0,
      )
      .run()
  } catch (err) {
    console.warn(`[coupon-security] audit write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Bounded retention: delete rows older than AUDIT_RETENTION_MS. Sampled (~1%)
 * so the common redeem path doesn't pay for a DELETE, but the table still can't
 * grow without bound. Best-effort, never throws.
 */
export async function maybePruneAudit(env: Env, now: number, sample = Math.random()): Promise<void> {
  const db = env.COUPON_SECURITY_DB
  if (!db) return
  if (sample >= 0.01) return
  try {
    await db
      .prepare(`DELETE FROM coupon_security_events WHERE created_at < ?1`)
      .bind(now - AUDIT_RETENTION_MS)
      .run()
  } catch (err) {
    console.warn(`[coupon-security] audit prune failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
