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
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'

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

/** Read a switch key. Never throws: any failure reads as paused. */
async function readSwitch(env: Env, key: string): Promise<CheckoutControlRead> {
  try {
    const { value, version } = await casRead(env, key)
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

/** Read the delivery switch. Never throws: any failure reads as paused. */
export async function readCheckoutControl(env: Env): Promise<CheckoutControlRead> {
  return readSwitch(env, CHECKOUT_CONTROL_KEY)
}

/** True when checkout delivery must not start (paused, or switch unreadable). */
export async function checkoutDeliveryPaused(env: Env): Promise<boolean> {
  return (await readCheckoutControl(env)).paused
}

// ── Intake switch: stop NEW merchant-invoice orders (G1) ───────────────────
//
// `admin stop checkout-intake` / `admin resume checkout-intake`. Independent
// of the delivery switch above: stopping intake never touches delivery or the
// backlog replay of orders already paid, and stopping delivery never touches
// intake. Read by every order-creating entry point for a funder-paid merchant
// invoice (create-invoice Coinbase / Stripe / rozotest, the TRON / TON alpha
// option, the UPI resolve) before anything is created upstream. Same value
// format and the same fail-closed reading as the delivery switch: absent =
// accepting orders (production default), corrupt or unreadable = paused.
// Design: ainative docs/design/20261122-stop-new-openrouter-orders-switch.zh.md

export const CHECKOUT_INTAKE_KEY = 'checkout-intake:v1'

export async function readCheckoutIntake(env: Env): Promise<CheckoutControlRead> {
  return readSwitch(env, CHECKOUT_INTAKE_KEY)
}

/** True when no new merchant-invoice order may be created. */
export async function checkoutIntakePaused(env: Env): Promise<boolean> {
  return (await readCheckoutIntake(env)).paused
}

export const CHECKOUT_INTAKE_PAUSED_CODE = 'CHECKOUT_INTAKE_PAUSED'
const CHECKOUT_INTAKE_PAUSED_MESSAGE =
  'New checkout orders are temporarily paused. Nothing was created or charged. ' +
  'Orders you already paid are not affected. Please try again later.'

/** Body a refused create answers with (HTTP 503). `error` is the message, like the other create errors. */
export const CHECKOUT_INTAKE_PAUSED_BODY = {
  error: CHECKOUT_INTAKE_PAUSED_MESSAGE,
  code: CHECKOUT_INTAKE_PAUSED_CODE,
  message: CHECKOUT_INTAKE_PAUSED_MESSAGE,
  retryable: true,
} as const

export function checkoutIntakePausedResponse(): Response {
  return new Response(JSON.stringify(CHECKOUT_INTAKE_PAUSED_BODY), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '300' },
  })
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
 * Index a delivery the switch refused. The order record itself already stays
 * in a resumable state; the index is how `resume` finds it, so a failed write
 * pages a human instead of passing silently (the sender will not retry).
 */
export async function recordPausedDelivery(
  env: Env,
  entry: { provider: BacklogProvider; ref: string; rozoPaymentId: string | null; eventType: string },
  now: Date = new Date(),
): Promise<boolean> {
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
    return true
  } catch (err) {
    console.error(
      `[checkout-control] backlog index write failed for ${entry.ref}: ${err instanceof Error ? err.message : String(err)}`,
    )
    if (alertSinkConfigured(env)) {
      await sendAlert(
        env,
        redactForAlert(
          `[MPP Router] ⚠️ Checkout paused an order but could not index it: ${entry.provider} ${entry.ref} (Rozo ${entry.rozoPaymentId ?? 'unknown'}). ` +
            'The order is safe in its pre-pay state, but `admin resume checkout` will not replay it. Re-drive it by hand after resume.',
        ),
      ).catch(() => false)
    }
    return false
  }
}

/**
 * Remove a backlog entry (empty value reads as absent, same as the exec gate).
 * With `seen`, only the exact entry that was read is removed: an order paused
 * again while it was being replayed keeps its fresh entry.
 */
export async function clearPausedDelivery(env: Env, ref: string, seen?: BacklogEntry): Promise<boolean> {
  return casUpdate<boolean>(env, checkoutBacklogKey(ref), (raw) => {
    if (!raw) return { op: 'noop', result: true }
    if (seen) {
      const cur = parseBacklog(raw)
      if (cur && (cur.lastPausedAt !== seen.lastPausedAt || cur.count !== seen.count)) {
        return { op: 'noop', result: false }
      }
    }
    return { op: 'set', value: '', result: true }
  })
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
  return stopSwitch(env, CHECKOUT_CONTROL_KEY, 'stop', req, now)
}

/** Stop new orders. Idempotent like stopCheckout; delivery is not touched. */
export async function stopCheckoutIntake(env: Env, req: ControlRequest, now: Date = new Date()): Promise<StopResult> {
  return stopSwitch(env, CHECKOUT_INTAKE_KEY, 'stop_intake', req, now)
}

async function stopSwitch(
  env: Env,
  key: string,
  action: AuditAction,
  req: ControlRequest,
  now: Date,
): Promise<StopResult> {
  const previous = await readSwitch(env, key)
  const state: CheckoutControlState = {
    paused: true,
    reason: req.reason,
    actor: req.actor,
    requestId: req.requestId,
    at: now.toISOString(),
  }
  const result = await casUpdate<StopResult>(env, key, (raw) => {
    const cur = parseState(raw)
    // Already paused by an earlier stop: keep its who/why, but write it back
    // with the latest stop request so the version moves on. A resume prepared
    // from a version read before this stop then fails (409) instead of
    // overriding the newer stop intent.
    if (cur !== 'absent' && cur !== 'corrupt' && cur.paused) {
      const rewritten = { ...cur, lastStopAt: now.toISOString(), lastStopRequestId: req.requestId }
      return { op: 'set', value: JSON.stringify(rewritten), result: { changed: false, previous, state: cur } }
    }
    return { op: 'set', value: JSON.stringify(state), result: { changed: true, previous, state } }
  })
  await appendAudit(env, action, req, previous, result.changed, now)
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
  return resumeSwitch(env, CHECKOUT_CONTROL_KEY, 'resume', req, expectedVersion, now)
}

/** Accept new orders again, only at `expectedVersion`. Nothing to replay. */
export async function resumeCheckoutIntake(
  env: Env,
  req: ControlRequest,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<ResumeResult> {
  return resumeSwitch(env, CHECKOUT_INTAKE_KEY, 'resume_intake', req, expectedVersion, now)
}

async function resumeSwitch(
  env: Env,
  key: string,
  action: AuditAction,
  req: ControlRequest,
  expectedVersion: number,
  now: Date,
): Promise<ResumeResult> {
  const current = await readSwitch(env, key)
  if (current.error) return { ok: false, conflict: true, current }
  if (!current.paused) {
    await appendAudit(env, action, req, current, false, now)
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
  const committed = await casCommit(env, key, expectedVersion, JSON.stringify(state))
  if (!committed) return { ok: false, conflict: true, current: await readSwitch(env, key) }
  await appendAudit(env, action, req, current, true, now)
  return { ok: true, changed: true, state }
}

type AuditAction = 'stop' | 'resume' | 'replay' | 'stop_intake' | 'resume_intake'

async function appendAudit(
  env: Env,
  action: AuditAction,
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
