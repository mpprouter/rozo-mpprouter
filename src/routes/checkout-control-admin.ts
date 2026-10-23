// /admin/checkout-control — operator surface for the checkout emergency stop
// (checkout-control.ts). Driven by the shared `admin-control` skill in ainative
// (scripts/admin_control.py); never by the model directly.
//
//   GET  /admin/checkout-control
//        → switch state + version, refused-delivery backlog, Coinbase/Stripe
//          records in flight, and records that started paying after the stop.
//   POST /admin/checkout-control { action, reason, actor, request_id, expected_version? }
//        action = stop    → pause (idempotent)
//        action = resume  → un-pause only if the switch is still at
//                           expected_version; does NOT re-drive anything
//        action = replay  → re-drive up to REPLAY_MAX backlog entries through
//                           the unchanged settlement path (switch must be open)
//
// Auth: x-admin-secret = CHECKOUT_CONTROL_SECRET. Its own secret on purpose:
// it can stop and restart delivery but can never pay an invoice by itself.

import type { Env } from '../index'
import { casScan } from './stripe-atomic'
import { baseLinkIdOf } from '../mpp/contract-variant'
import {
  type BacklogEntry,
  appendCheckoutAudit,
  clearPausedDelivery,
  listPausedDeliveries,
  readCheckoutControl,
  resumeCheckout,
  stopCheckout,
} from './checkout-control'
import {
  type FulfillmentRecord,
  fetchRozoPaymentById,
  loadRecord,
  settleCoinbaseEvent,
} from './webhook'
import { handleStripeWebhookEvent, invoiceKeyFromOrderId, loadStripeRecordForStatus } from './stripe-fulfillment'

export const REPLAY_MAX = 20
const KV_PREFIX = 'invoice-fulfillment:'
const STRIPE_KV_PREFIX = 'invoice-fulfillment:v2:'
const STRIPE_DO_PREFIX = 'invoice-fulfillment:v2:stripe_crypto:'
// Bounded so a status call stays cheap; the result says when it was cut short.
const STATUS_MAX_RECORDS = 300
const MAX_LIST_PAGES = 5

const PRE_PAY = new Set(['payin_seen', 'failed_insufficient_balance'])
const STRIPE_PRE_PAY = new Set(['payin_seen', 'payout_seen', 'failed_insufficient_balance'])
const PAYIN_LIKE = new Set([
  'payment_payin_completed',
  'payment_payout_started',
  'payment_bridging',
  'payment_payout_review',
])

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export async function handleCheckoutControl(request: Request, env: Env): Promise<Response> {
  if (!env.CHECKOUT_CONTROL_SECRET) return json(500, { error: 'CHECKOUT_CONTROL_SECRET is not configured' })
  const provided = request.headers.get('x-admin-secret')?.trim() ?? ''
  if (!provided || !safeEqual(provided, env.CHECKOUT_CONTROL_SECRET)) return json(401, { error: 'Unauthorized' })

  if (request.method === 'GET') return json(200, await checkoutStatus(env))
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid JSON body' })
  }
  const action = text(body?.action, 20)
  const req = {
    reason: text(body?.reason, 500),
    actor: text(body?.actor, 100),
    requestId: text(body?.request_id, 100),
  }
  if (!req.reason || !req.actor || !req.requestId) {
    return json(400, { error: 'reason, actor and request_id are required' })
  }

  if (action === 'stop') {
    const r = await stopCheckout(env, req)
    const after = await readCheckoutControl(env)
    return json(200, {
      action,
      changed: r.changed,
      before: { paused: r.previous.paused, version: r.previous.version, error: r.previous.error },
      after,
      // The switch is read on every delivery attempt with no cache, so a
      // re-read showing paused means every later attempt sees it.
      verified: after.paused && after.error === null,
    })
  }

  if (action === 'resume') {
    const expected = body?.expected_version
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
      return json(400, { error: 'expected_version (integer from GET) is required for resume' })
    }
    const r = await resumeCheckout(env, req, expected)
    if (!r.ok) return json(409, { action, error: 'switch changed since expected_version; re-read and decide again', current: r.current })
    const after = await readCheckoutControl(env)
    return json(200, { action, changed: r.changed, after, verified: !after.paused })
  }

  if (action === 'replay') {
    const control = await readCheckoutControl(env)
    if (control.paused) return json(409, { action, error: 'checkout is paused; resume first', control })
    const results = await replayPausedDeliveries(env, req.requestId)
    await appendCheckoutAudit(env, 'replay', req, control, results.length > 0, new Date(), {
      results: results.map((r) => ({ ref: r.ref, outcome: r.outcome })),
    })
    const remaining = (await listPausedDeliveries(env)).length
    return json(200, { action, results, remaining })
  }

  return json(400, { error: 'action must be stop, resume or replay' })
}

// ── Replay ──────────────────────────────────────────────────────────────────

export type ReplayOutcome =
  | 'settled_path_ran' // the normal settlement ran; see `summary` for what it did
  | 'already_moved' // record left the pre-pay state; entry cleared, nothing sent
  | 'not_ready' // Rozo payment not in a payable status yet; entry kept
  | 'needs_human' // Rozo payment unreadable / mismatched / terminal elsewhere; entry kept
  | 'still_paused' // switch closed again mid-replay; entry kept

export interface ReplayResult {
  ref: string
  provider: BacklogEntry['provider']
  outcome: ReplayOutcome
  detail?: string
  summary?: Record<string, unknown>
}

export async function replayPausedDeliveries(env: Env, requestId: string): Promise<ReplayResult[]> {
  const entries = (await listPausedDeliveries(env)).slice(0, REPLAY_MAX)
  const out: ReplayResult[] = []
  for (const entry of entries) {
    try {
      out.push(await replayOne(env, entry, requestId))
    } catch (err) {
      out.push({
        ref: entry.ref,
        provider: entry.provider,
        outcome: 'needs_human',
        detail: `replay threw: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
      })
    }
  }
  return out
}

async function replayOne(env: Env, entry: BacklogEntry, requestId: string): Promise<ReplayResult> {
  const base = { ref: entry.ref, provider: entry.provider }

  if (entry.provider === 'coinbase') {
    const rec = await loadRecord(env, entry.ref)
    if (rec && !PRE_PAY.has(rec.status)) {
      await clearPausedDelivery(env, entry.ref, entry)
      return { ...base, outcome: 'already_moved', detail: `record status ${rec.status}` }
    }
  } else {
    const stripe = await loadStripeStatus(env, entry.ref)
    if (stripe && !STRIPE_PRE_PAY.has(stripe)) {
      await clearPausedDelivery(env, entry.ref, entry)
      return { ...base, outcome: 'already_moved', detail: `record status ${stripe}` }
    }
  }

  // The event is rebuilt from Rozo's own payment record, never from the caller.
  if (!entry.rozoPaymentId) return { ...base, outcome: 'needs_human', detail: 'no Rozo payment id on the entry' }
  const rozo = await fetchRozoPaymentById(env, entry.rozoPaymentId)
  if (!rozo || typeof rozo !== 'object') return { ...base, outcome: 'needs_human', detail: 'Rozo payment unreadable' }
  const orderId = typeof rozo.orderId === 'string' ? rozo.orderId : ''
  const matches = entry.provider === 'coinbase' ? baseLinkIdOf(orderId) === entry.ref : orderId === entry.ref
  if (!matches) return { ...base, outcome: 'needs_human', detail: 'Rozo payment orderId does not match the entry' }

  const status = typeof rozo.status === 'string' ? rozo.status : ''
  const eventType =
    status === 'payment_payout_completed'
      ? 'payment_payout_completed'
      : PAYIN_LIKE.has(status)
        ? 'payment_payin_completed'
        : null
  if (!eventType) {
    const settled = /expired|refund|failed|unpaid/.test(status)
    return { ...base, outcome: settled ? 'needs_human' : 'not_ready', detail: `Rozo status ${status || 'unknown'}` }
  }

  const eventId = `checkout-replay:${requestId}:${entry.ref}`
  const now = Date.now()
  let summary: Record<string, unknown>
  if (entry.provider === 'coinbase') {
    summary = await settleCoinbaseEvent(env, {
      eventId,
      eventType,
      plId: entry.ref,
      rozoPaymentId: entry.rozoPaymentId,
      evt: {
        event_id: eventId,
        type: eventType,
        data: {
          id: entry.rozoPaymentId,
          appId: rozo.appId,
          orderId,
          status,
          source: rozo.source,
          destination: rozo.destination,
        },
      },
      now,
    })
  } else {
    summary = await handleStripeWebhookEvent(
      env,
      {
        eventId,
        eventType,
        orderId: entry.ref,
        rozoPaymentId: entry.rozoPaymentId,
        invoiceAmountStr: rozo.destination?.amount ?? rozo.source?.amount ?? null,
      },
      new Date(now),
    )
  }

  if (summary.deferred === 'checkout_paused') return { ...base, outcome: 'still_paused', summary }
  // Any other answer means the normal path owns this order again (paid,
  // deferred for balance, in flight, terminal…); its own record, sweep and
  // alerts take it from here.
  await clearPausedDelivery(env, entry.ref, entry)
  return { ...base, outcome: 'settled_path_ran', summary }
}

async function loadStripeStatus(env: Env, orderId: string): Promise<string | null> {
  const rec = await loadStripeRecordForStatus(env, invoiceKeyFromOrderId(orderId))
  return rec?.status ?? null
}

// ── Status ──────────────────────────────────────────────────────────────────

interface InFlightRow {
  provider: 'coinbase' | 'stripe'
  ref: string
  status: string
  since: string | null
}

export async function checkoutStatus(env: Env): Promise<Record<string, unknown>> {
  const control = await readCheckoutControl(env)
  let backlog: BacklogEntry[] | null = null
  let backlogError: string | null = null
  try {
    backlog = await listPausedDeliveries(env)
  } catch (err) {
    backlogError = err instanceof Error ? err.message.slice(0, 200) : 'unknown'
  }

  // Since when the current pause applies (for "started paying after stop").
  const stoppedAt = control.paused && control.state?.at ? Date.parse(control.state.at) : null
  const inFlight: InFlightRow[] = []
  const startedAfterStop: InFlightRow[] = []
  let scanned = 0
  let truncated = false
  let scanError: string | null = null

  try {
    let cursor: string | undefined
    outer: for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await env.MPP_STORE.list({ prefix: KV_PREFIX, cursor })
      for (const k of res.keys) {
        if (k.name.startsWith(STRIPE_KV_PREFIX)) continue
        if (scanned >= STATUS_MAX_RECORDS) {
          truncated = true
          break outer
        }
        scanned++
        const plId = k.name.slice(KV_PREFIX.length)
        const rec: FulfillmentRecord | null = await loadRecord(env, plId)
        if (!rec) continue
        const row = { provider: 'coinbase' as const, ref: plId, status: rec.status, since: rec.payingAt ?? null }
        if (rec.status === 'paying' || rec.status === 'capture_pending') inFlight.push(row)
        const started = rec.payingAt ? Date.parse(rec.payingAt) : NaN
        if (stoppedAt !== null && Number.isFinite(started) && started >= stoppedAt) startedAfterStop.push(row)
      }
      if (res.list_complete) break
      cursor = res.cursor
      if (page === MAX_LIST_PAGES - 1) truncated = true
    }
    for (const raw of await casScan(env, STRIPE_DO_PREFIX)) {
      try {
        const r = JSON.parse(raw)
        if (r?.status === 'provider_paying' || r?.status === 'provider_submitted_ambiguous') {
          inFlight.push({ provider: 'stripe', ref: String(r.orderId ?? r.invoiceKey ?? '?'), status: r.status, since: null })
        }
      } catch {
        // skip unparseable rows
      }
    }
  } catch (err) {
    scanError = err instanceof Error ? err.message.slice(0, 200) : 'unknown'
  }

  return {
    checkout: {
      paused: control.paused,
      version: control.version,
      state: control.state,
      error: control.error,
    },
    backlog: backlog === null ? null : { count: backlog.length, entries: backlog },
    backlogError,
    inFlight: scanError ? null : inFlight,
    startedAfterStop: scanError || stoppedAt === null ? null : startedAfterStop,
    scan: { scanned, truncated, error: scanError },
  }
}
