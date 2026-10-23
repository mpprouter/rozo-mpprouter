// Emergency stop for checkout delivery: `admin stop checkout` / `admin resume checkout`.
//
// "Checkout delivery" = every path in this worker that makes the funder wallet
// pay a merchant invoice (Coinbase webhook settlement, Stripe Crypto webhook
// settlement, coupon redemption, UPI fulfillment, /admin/pay-invoice and the
// x402 pay-invoice bridge). Pay-in watching, Rozo order creation and read-only
// status lookups are NOT stopped.
//
// Design: ainative docs/design/20261023-admin-stop-resume-withdraw-checkout.zh.md
//
// The switch is one key on the linearizable AtomicStoreDO (same singleton as
// the Coinbase exec gate), read fresh on every delivery attempt, never cached.
//   - key absent            → running (never stopped; production default)
//   - {"paused": false,...} → running
//   - anything else, or a read error → PAUSED (fail closed)
//
// A delivery refused by the switch is left in a resumable state and indexed
// under BACKLOG_PREFIX so `resume` can re-drive it. Re-driving rebuilds the
// event from Rozo's own payment record (never from the caller) and goes through
// the unchanged settlement path, so the exec gate, cross-channel claim, funder
// balance check and daily caps all still apply.
//
// Resume is a conditional commit on the version the operator read: a stop that
// lands in between makes the resume fail instead of being overwritten.

import type { Env } from '../index'
import { casCommit, casRead, casScan, casUpdate } from './stripe-atomic'

export const CHECKOUT_CONTROL_KEY = 'checkout-control:v1'
export const CHECKOUT_BACKLOG_PREFIX = 'checkout-paused:v1:'
export const CHECKOUT_AUDIT_PREFIX = 'checkout-control-audit:v1:'

export interface CheckoutControlState {
  paused: boolean
  reason: string | null
  actor: string | null
  requestId: string | null
  at: string | null
}

export interface CheckoutControlRead {
  paused: boolean
  version: number
  state: CheckoutControlState | null
  /** Set when the value could not be read or parsed (then paused = true). */
  error: string | null
}

function parseState(raw: string | null): CheckoutControlState | 'absent' | 'corrupt' {
  if (raw === null || raw === '') return 'absent'
  try {
    const s = JSON.parse(raw) as Partial<CheckoutControlState>
    if (typeof s?.paused !== 'boolean') return 'corrupt'
    return {
      paused: s.paused,
      reason: typeof s.reason === 'string' ? s.reason : null,
      actor: typeof s.actor === 'string' ? s.actor : null,
      requestId: typeof s.requestId === 'string' ? s.requestId : null,
      at: typeof s.at === 'string' ? s.at : null,
    }
  } catch {
    return 'corrupt'
  }
}

/** Read the switch. Never throws: any failure reads as paused. */
export async function readCheckoutControl(env: Env): Promise<CheckoutControlRead> {
  try {
    const { value, version } = await casRead(env, CHECKOUT_CONTROL_KEY)
    const state = parseState(value)
    if (state === 'absent') return { paused: false, version, state: null, error: null }
    if (state === 'corrupt') return { paused: true, version, state: null, error: 'switch value unparseable' }
    return { paused: state.paused !== false, version, state, error: null }
  } catch (err) {
    return {
      paused: true,
      version: -1,
      state: null,
      error: `switch unreadable: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
    }
  }
}

/** True when checkout delivery must not start (paused, or switch unreadable). */
export async function checkoutDeliveryPaused(env: Env): Promise<boolean> {
  return (await readCheckoutControl(env)).paused
}

/** Body every refused synchronous entry point answers with (HTTP 503). */
export const CHECKOUT_PAUSED_BODY = {
  error: 'CHECKOUT_PAUSED',
  message: 'Checkout delivery is temporarily paused. Nothing was charged or paid; try again later.',
  retryable: true,
} as const

export function checkoutPausedResponse(): Response {
  return new Response(JSON.stringify(CHECKOUT_PAUSED_BODY), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '300' },
  })
}

// ── Backlog of deliveries the switch refused ────────────────────────────────

export type BacklogProvider = 'coinbase' | 'stripe'

export interface BacklogEntry {
  provider: BacklogProvider
  /** Coinbase: the pl_/paymentSession_ id. Stripe: the stripe_crypto_cpis_* order id. */
  ref: string
  rozoPaymentId: string | null
  eventType: string
  firstPausedAt: string
  lastPausedAt: string
  count: number
}

export function checkoutBacklogKey(ref: string): string {
  return `${CHECKOUT_BACKLOG_PREFIX}${ref}`
}

function parseBacklog(raw: string | null): BacklogEntry | null {
  if (!raw) return null
  try {
    const e = JSON.parse(raw) as BacklogEntry
    if ((e.provider === 'coinbase' || e.provider === 'stripe') && typeof e.ref === 'string') return e
    return null
  } catch {
    return null
  }
}

/**
 * Index a delivery the switch refused. Best effort: the order record itself
 * already stays in a resumable state, the index only lets `resume` find it.
 */
export async function recordPausedDelivery(
  env: Env,
  entry: { provider: BacklogProvider; ref: string; rozoPaymentId: string | null; eventType: string },
  now: Date = new Date(),
): Promise<void> {
  const at = now.toISOString()
  try {
    await casUpdate<true>(env, checkoutBacklogKey(entry.ref), (raw) => {
      const prev = parseBacklog(raw)
      const next: BacklogEntry = {
        provider: entry.provider,
        ref: entry.ref,
        rozoPaymentId: entry.rozoPaymentId ?? prev?.rozoPaymentId ?? null,
        eventType:
          // payout_completed is the stronger signal; never downgrade it.
          prev?.eventType === 'payment_payout_completed' ? prev.eventType : entry.eventType,
        firstPausedAt: prev?.firstPausedAt ?? at,
        lastPausedAt: at,
        count: (prev?.count ?? 0) + 1,
      }
      return { op: 'set', value: JSON.stringify(next), result: true }
    })
  } catch (err) {
    console.error(
      `[checkout-control] backlog index write failed for ${entry.ref}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Remove a backlog entry (empty value reads as absent, same as the exec gate). */
export async function clearPausedDelivery(env: Env, ref: string): Promise<void> {
  await casUpdate<true>(env, checkoutBacklogKey(ref), (raw) =>
    raw ? { op: 'set', value: '', result: true } : { op: 'noop', result: true },
  )
}

export async function listPausedDeliveries(env: Env): Promise<BacklogEntry[]> {
  const values = await casScan(env, CHECKOUT_BACKLOG_PREFIX)
  return values
    .map(parseBacklog)
    .filter((e): e is BacklogEntry => e !== null)
    .sort((a, b) => a.firstPausedAt.localeCompare(b.firstPausedAt))
}

// ── Stop / resume ───────────────────────────────────────────────────────────

export interface ControlRequest {
  reason: string
  actor: string
  requestId: string
}

export type StopResult = { changed: boolean; previous: CheckoutControlRead; state: CheckoutControlState }

/** Pause delivery. Idempotent: an already-paused switch is left untouched. */
export async function stopCheckout(env: Env, req: ControlRequest, now: Date = new Date()): Promise<StopResult> {
  const previous = await readCheckoutControl(env)
  const state: CheckoutControlState = {
    paused: true,
    reason: req.reason,
    actor: req.actor,
    requestId: req.requestId,
    at: now.toISOString(),
  }
  const result = await casUpdate<StopResult>(env, CHECKOUT_CONTROL_KEY, (raw) => {
    const cur = parseState(raw)
    // Already paused by an earlier stop: keep its who/why, write nothing.
    if (cur !== 'absent' && cur !== 'corrupt' && cur.paused) {
      return { op: 'noop', result: { changed: false, previous, state: cur } }
    }
    return { op: 'set', value: JSON.stringify(state), result: { changed: true, previous, state } }
  })
  await appendAudit(env, 'stop', req, previous, result.changed, now)
  return result
}

export type ResumeResult =
  | { ok: true; changed: boolean; state: CheckoutControlState | null }
  | { ok: false; conflict: true; current: CheckoutControlRead }

/**
 * Resume delivery, only if the switch is still at `expectedVersion` (the
 * version the operator looked at). Does not re-drive the backlog: that is
 * `replayPausedDeliveries`, reported separately.
 */
export async function resumeCheckout(
  env: Env,
  req: ControlRequest,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<ResumeResult> {
  const current = await readCheckoutControl(env)
  if (current.error) return { ok: false, conflict: true, current }
  if (!current.paused) {
    await appendAudit(env, 'resume', req, current, false, now)
    return { ok: true, changed: false, state: current.state }
  }
  if (current.version !== expectedVersion) return { ok: false, conflict: true, current }
  const state: CheckoutControlState = {
    paused: false,
    reason: req.reason,
    actor: req.actor,
    requestId: req.requestId,
    at: now.toISOString(),
  }
  const committed = await casCommit(env, CHECKOUT_CONTROL_KEY, expectedVersion, JSON.stringify(state))
  if (!committed) return { ok: false, conflict: true, current: await readCheckoutControl(env) }
  await appendAudit(env, 'resume', req, current, true, now)
  return { ok: true, changed: true, state }
}

async function appendAudit(
  env: Env,
  action: 'stop' | 'resume' | 'replay',
  req: ControlRequest,
  before: CheckoutControlRead,
  changed: boolean,
  now: Date,
  extra?: Record<string, unknown>,
): Promise<void> {
  const at = now.toISOString()
  const entry = {
    at,
    action,
    actor: req.actor,
    reason: req.reason,
    requestId: req.requestId,
    changed,
    before: { paused: before.paused, version: before.version, error: before.error },
    ...extra,
  }
  try {
    await casUpdate<true>(env, `${CHECKOUT_AUDIT_PREFIX}${at}:${req.requestId}`, () => ({
      op: 'set',
      value: JSON.stringify(entry),
      result: true,
    }))
  } catch (err) {
    console.error(`[checkout-control] audit write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export { appendAudit as appendCheckoutAudit }
