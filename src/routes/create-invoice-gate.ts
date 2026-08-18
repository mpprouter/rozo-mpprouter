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
import { sendDingTalkAlert } from '../utils/dingtalk'
import { redactForAlert } from '../utils/alert-redaction'

// ── Tunables ─────────────────────────────────────────────────────────────────
// Per-IP invoice creations per hour. A real payer creates one (occasionally a
// few on retries); 30/hr is generous for humans, tight for a spray script.
const IP_LIMIT_PER_HOUR = 30
// Global creations per hour across ALL IPs — circuit breaker against a botnet
// spread over many IPs (each of which stays under the per-IP cap).
const GLOBAL_LIMIT_PER_HOUR = 600
const WINDOW_SECONDS = 60 * 60

const DO_ORIGIN = 'https://atomic-store.internal'
const MAX_CAS_RETRIES = 25 // hot shared counters see burst contention; keep loose

export type GateDecision =
  | { ok: true }
  | { ok: false; reason: 'ip_rate_limited' | 'global_circuit_open' }

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

/** Best-effort client IP from Cloudflare headers. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

/**
 * Gate a create-invoice request. Returns { ok:true } to proceed, or a rejection
 * reason. Fail-OPEN on any DO error (logged). Order: global breaker first (one
 * read+bump), then per-IP — an already-tripped global cap short-circuits before
 * spending per-IP work, and a single hot IP can't exhaust the global budget for
 * everyone (its own per-IP cap stops it first).
 */
export async function checkCreateInvoiceGate(request: Request, env: Env): Promise<GateDecision> {
  const bucket = hourBucket()
  try {
    const globalCount = await bumpCounter(env, `ci:global:${bucket}`, bucket)
    if (globalCount > GLOBAL_LIMIT_PER_HOUR) {
      // Fire the alert exactly once at the crossing to avoid alert spam.
      if (globalCount === GLOBAL_LIMIT_PER_HOUR + 1 && env.DINGTALK_ACCESS_TOKEN) {
        await sendDingTalkAlert(
          env.DINGTALK_ACCESS_TOKEN,
          redactForAlert(`[MPP Router] 🚨 create-invoice global circuit breaker OPEN: >${GLOBAL_LIMIT_PER_HOUR} invoice creations this hour. New invoice creation paused for the window.`),
        )
      }
      return { ok: false, reason: 'global_circuit_open' }
    }

    const ip = clientIp(request)
    const ipCount = await bumpCounter(env, `ci:ip:${ip}:${bucket}`, bucket)
    if (ipCount > IP_LIMIT_PER_HOUR) {
      return { ok: false, reason: 'ip_rate_limited' }
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
