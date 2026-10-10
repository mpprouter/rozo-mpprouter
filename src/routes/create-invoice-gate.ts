/**
 * create-invoice-gate.ts — anti-abuse gate for the public create-invoice route.
 *
 * WHY THIS EXISTS (Boltz BTC-Lightning mainline hardening, 2026-07-23):
 * `handleCreateInvoice` is a PUBLIC, unauthenticated endpoint. Each Lightning
 * invoice it creates mints a REAL Boltz reverse swap upstream (a real on-chain
 * commitment). Without a throttle, a script can spray create-invoice and flood
 * us with orphan swaps / upstream load. Same-payment reuse is already handled in
 * create-invoice.ts (an existing order for the same link/order id is returned
 * with `reused:true`); this module adds the two missing pieces from the work
 * order: (1) a per-IP hourly rate limit and (2) a GLOBAL hourly creation circuit
 * breaker (botnet defence) that fires a DingTalk alert when it trips.
 *
 * Counters live on the SAME "coupon" ATOMIC_STORE Durable Object instance the
 * coupon abuse-protection uses, via its /read + /commit CAS protocol — one
 * strongly-consistent domain, no new binding. Keys are namespaced `ci:*` so they
 * never collide with coupon (`rl:*`) or payment state.
 *
 * FAIL-OPEN by design: the gate protects a create path, not money movement. If
 * the DO is unreachable we log and allow the request (a transient DO outage must
 * not take create-invoice down). Same-payment reuse + upstream idempotency remain
 * the real double-mint guards; this gate is a volume cap, not a correctness gate.
 */

import type { Env } from '../index'
import type { ReadResponse, CommitResponse } from '../mpp/atomic-store-do'
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'

// ── Tunables ─────────────────────────────────────────────────────────────────
// Since 2026-10-10 the per-buyer limit lives in rozo-intents-api (PR #643:
// tier0 10 / tier1 30 per IP per 10 min, 300 per IP per day, 120 per app per
// 10 min), keyed on the IP this Worker forwards in `x-rozo-client-hint`. This
// gate is only a coarse abuse backstop and must stay LOOSER than upstream so a
// buyer always meets the upstream tiers (and their 429 + Retry-After) first.
// Tier1 upstream is 180/hour, so the per-IP default sits above it.
// Tunable without a code change via wrangler [vars]:
//   CREATE_INVOICE_IP_LIMIT_PER_HOUR      per-IP creations per UTC clock hour
//   CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR  all-IP creations per UTC clock hour
//                                         (botnet circuit breaker + alert)
export const DEFAULT_IP_LIMIT_PER_HOUR = 200
export const DEFAULT_GLOBAL_LIMIT_PER_HOUR = 1500
const WINDOW_SECONDS = 60 * 60

export interface GateLimits {
  ipPerHour: number
  globalPerHour: number
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null) return fallback
  const trimmed = String(raw).trim()
  if (!/^[0-9]+$/.test(trimmed)) return fallback
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/** Limits from env, falling back to the code defaults on absent/malformed values. */
export function resolveGateLimits(env: Pick<Env, 'CREATE_INVOICE_IP_LIMIT_PER_HOUR' | 'CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR'>): GateLimits {
  return {
    ipPerHour: positiveInt(env.CREATE_INVOICE_IP_LIMIT_PER_HOUR, DEFAULT_IP_LIMIT_PER_HOUR),
    globalPerHour: positiveInt(env.CREATE_INVOICE_GLOBAL_LIMIT_PER_HOUR, DEFAULT_GLOBAL_LIMIT_PER_HOUR),
  }
}

/** Seconds until the current hour bucket rolls over (>= 1). */
export function secondsUntilWindowReset(now = Date.now()): number {
  const windowMs = WINDOW_SECONDS * 1000
  return Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000))
}

const DO_ORIGIN = 'https://atomic-store.internal'
const MAX_CAS_RETRIES = 25 // hot shared counters see burst contention; keep loose

export type GateDecision =
  | { ok: true }
  | {
      ok: false
      reason: 'ip_rate_limited' | 'global_circuit_open'
      limit: number
      retryAfterSeconds: number
    }

function couponStub(env: Env) {
  return env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('coupon'))
}

async function doPost<T>(env: Env, path: string, payload: unknown): Promise<T> {
  const resp = await couponStub(env).fetch(
    new Request(`${DO_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`create-invoice gate DO ${path} failed (${resp.status}): ${text}`)
  }
  return resp.json() as Promise<T>
}

/** Current hour bucket key suffix (UTC), so a counter auto-resets each hour. */
function hourBucket(now = Date.now()): string {
  return String(Math.floor(now / (WINDOW_SECONDS * 1000)))
}

interface Counter {
  count: number
  /** Bucket this counter belongs to; a new hour resets to 0. */
  bucket: string
}

function parseCounter(raw: string | null, bucket: string): Counter {
  if (!raw) return { count: 0, bucket }
  try {
    const c = JSON.parse(raw) as Counter
    if (c && typeof c.count === 'number' && c.bucket === bucket) return c
  } catch {
    // fall through to a fresh counter
  }
  return { count: 0, bucket }
}

/**
 * Atomically increment a bucketed counter and return the post-increment value.
 * CAS loop against the DO; on exhaustion throws (caller fails open).
 */
async function bumpCounter(env: Env, key: string, bucket: string): Promise<number> {
  let { value, version } = await doPost<ReadResponse>(env, '/read', { key })
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const cur = parseCounter(value, bucket)
    const next: Counter = { count: cur.count + 1, bucket }
    const result = await doPost<CommitResponse>(env, '/commit', {
      key,
      expectedVersion: version,
      op: 'set',
      value: JSON.stringify(next),
    })
    if (result.ok) return next.count
    value = result.value
    version = result.version
  }
  throw new Error(`create-invoice gate bumpCounter(${key}): exhausted ${MAX_CAS_RETRIES} retries`)
}

/**
 * Client IP as Cloudflare reports it. Only `CF-Connecting-IP` is trusted: the
 * Cloudflare edge sets it on every request that reaches this Worker and
 * overwrites any client-supplied value, whereas `X-Forwarded-For` / `X-Real-IP`
 * pass through from the client untouched and would let one host rotate
 * "IPs" at will. Absent only outside Cloudflare (local dev, tests).
 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || 'unknown'
}

/**
 * Gate a create-invoice request. Returns { ok:true } to proceed, or a rejection
 * reason. Fail-OPEN on any DO error (logged). Order: global breaker first (one
 * read+bump), then per-IP — an already-tripped global cap short-circuits before
 * spending per-IP work, and a single hot IP can't exhaust the global budget for
 * everyone (its own per-IP cap stops it first).
 */
export async function checkCreateInvoiceGate(request: Request, env: Env): Promise<GateDecision> {
  const now = Date.now()
  const bucket = hourBucket(now)
  const limits = resolveGateLimits(env)
  try {
    const globalCount = await bumpCounter(env, `ci:global:${bucket}`, bucket)
    if (globalCount > limits.globalPerHour) {
      // Fire the alert exactly once at the crossing to avoid alert spam.
      if (globalCount === limits.globalPerHour + 1 && alertSinkConfigured(env)) {
        await sendAlert(env,
          redactForAlert(`[MPP Router] 🚨 create-invoice global circuit breaker OPEN: >${limits.globalPerHour} invoice creations this hour. New invoice creation paused for the window.`),
        )
      }
      return {
        ok: false,
        reason: 'global_circuit_open',
        limit: limits.globalPerHour,
        retryAfterSeconds: secondsUntilWindowReset(now),
      }
    }

    const ip = clientIp(request)
    const ipCount = await bumpCounter(env, `ci:ip:${ip}:${bucket}`, bucket)
    if (ipCount > limits.ipPerHour) {
      return {
        ok: false,
        reason: 'ip_rate_limited',
        limit: limits.ipPerHour,
        retryAfterSeconds: secondsUntilWindowReset(now),
      }
    }

    return { ok: true }
  } catch (err) {
    // Fail OPEN: a DO outage must not take create-invoice down.
    console.warn(
      `[create-invoice] abuse gate DO error (failing open): ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: true }
  }
}
