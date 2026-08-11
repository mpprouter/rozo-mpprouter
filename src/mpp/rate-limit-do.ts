/**
 * Per-service daily rate cap, enforced BEFORE payment. Protects a
 * router-held upstream credential (Mercury MVP) from being exhausted by
 * router-side traffic — a double wall on top of whatever cap the upstream
 * itself enforces on the token.
 *
 * Copied from the fixed-window DO CAS counter pattern in
 * `src/routes/coupon.ts:273-313` (`bumpCounter` / `casUpdate`), but kept
 * as its own small module rather than importing from `coupon.ts` — this
 * has nothing to do with coupons and shouldn't couple to that file's
 * internals. Uses the same `ATOMIC_STORE` Durable Object binding (a
 * different `idFromName` gives it a separate DO instance / storage, so
 * the two counters never collide).
 *
 * Key layout: `ratelimit:<serviceId>:<yyyy-mm-dd>` (UTC fixed window,
 * per `route.id`'s service prefix — callers pass the full key).
 */

import type { Env } from '../index'
import type { ReadResponse, CommitResponse } from './atomic-store-do'

const DO_ORIGIN = 'https://rate-limit-do.internal'
const MAX_CAS_RETRIES = 25

function rateLimitStub(env: Env) {
  return env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('ratelimit'))
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
    throw new Error(`rate-limit DO ${path} failed (${resp.status}): ${text}`)
  }
  return resp.json() as Promise<T>
}

interface CounterState {
  n: number
  day: string
}

function parseCounter(raw: string | null): CounterState {
  if (!raw) return { n: 0, day: '' }
  try {
    return JSON.parse(raw) as CounterState
  } catch {
    return { n: 0, day: '' }
  }
}

/** UTC `yyyy-mm-dd` for the fixed daily window. */
export function utcDateKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export interface DailyLimitResult {
  ok: boolean
  /** Calls used so far today, including this one if `ok`. */
  used: number
  limit: number
}

/**
 * Read-only peek at the fixed-window daily counter — never consumes a
 * slot. Used for the unpaid/handshake leg (e.g. the initial 402 probe,
 * before any payment credential has been presented) so unauthenticated
 * spam can fail fast on an already-exhausted cap WITHOUT burning real
 * allowance meant for paid calls. Callers on the paid leg must still call
 * `checkAndBumpDailyLimit` right before the upstream call to actually
 * consume a slot.
 */
export async function peekDailyLimit(
  env: Env,
  key: string,
  perDay: number,
  now: number = Date.now(),
): Promise<DailyLimitResult> {
  const day = utcDateKey(now)
  const stub = rateLimitStub(env)
  const { value } = await doPost<ReadResponse>(stub, '/read', { key })
  const c = parseCounter(value)
  const used = c.day === day ? c.n : 0
  return { ok: used < perDay, used, limit: perDay }
}

/**
 * Atomically check-and-increment a fixed-window daily counter. Returns
 * `{ok:false}` (and does NOT consume a slot) when the caller is already
 * at `perDay`. No payment should be taken when this returns `ok:false`.
 */
export async function checkAndBumpDailyLimit(
  env: Env,
  key: string,
  perDay: number,
  now: number = Date.now(),
): Promise<DailyLimitResult> {
  const day = utcDateKey(now)
  const stub = rateLimitStub(env)
  let { value, version } = await doPost<ReadResponse>(stub, '/read', { key })
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const c = parseCounter(value)
    const inWindow = c.day === day
    const used = inWindow ? c.n : 0
    if (used >= perDay) {
      return { ok: false, used, limit: perDay }
    }
    const nextN = used + 1
    const result = await doPost<CommitResponse>(stub, '/commit', {
      key,
      expectedVersion: version,
      op: 'set',
      value: JSON.stringify({ n: nextN, day }),
    })
    if (result.ok) {
      return { ok: true, used: nextN, limit: perDay }
    }
    value = result.value
    version = result.version
  }
  throw new Error(`rate-limit DO checkAndBumpDailyLimit(${key}): exhausted ${MAX_CAS_RETRIES} retries`)
}

/** Seconds until the next UTC midnight, for the 429 `Retry-After` header. */
export function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const d = new Date(now)
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0)
  return Math.max(1, Math.ceil((nextMidnight - now) / 1000))
}
