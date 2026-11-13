// POST /admin/coinbase-exec-gate/clear — the manual re-pay escape hatch.
//
// The Coinbase execution gate (coinbase-exec-gate.ts) is never released once a
// pay-invoice request was sent. When a human has decided an invoice must be
// paid again, they clear the gate HERE. Clearing must never race a pay-invoice
// request that is still in flight, so ALL of these must hold:
//
//   (a) the holder's own record is parked for a human:
//       - webhook holder: KV fulfillment record status is `manual_review` or
//         `failed_pay_invoice` (never paying / capture_pending /
//         pay_invoice_unknown / paid / payin_seen: an unknown outcome is only
//         clearable after the sweep has moved it to manual_review);
//       - coupon holder (`coupon:<code>:<attemptId>`): the coupon record is in
//         `manual_review` for this same attempt and link;
//   (b) Coinbase returns an explicitly recognized NOT-settled state
//       (v3: status exactly PAYMENT_SESSION_STATUS_CREATED; v1: numeric
//       usageCount < numeric maxUsage). Unknown / unreadable → refuse;
//   (c) the caller names `expectedHolder`, and the release is one CAS that only
//       clears when the stored holder still equals it.
//
// Also required: x-admin-secret, `evidence` (what was verified) and `clearedBy`.
// Every clear is appended to DO key `coinbase-pay-exec-clear-log:v1:<plId>` and
// recorded as an event on the KV fulfillment record (when one exists).
//
// Clearing the gate does not pay anything. The re-pay itself is a separate,
// deliberate step (see the runbook in the fulfillment techdoc).

import type { Env } from '../index'
import { casRead, casUpdate } from './stripe-atomic'
import { coinbaseExplicitlyUnsettled, readCoinbaseExecGate, releaseCoinbaseExecGate } from './coinbase-exec-gate'
import { casRead as couponCasRead, couponKey, parseRecord as parseCouponRecord } from './coupon'
import { fetchCoinbasePayment, isCoinbasePaymentId, loadRecord, saveRecordGuarded } from './webhook'
import { handOverCryptoClaim, readInvoiceClaim, type HandOverResult } from './invoice-claim'
import { ADMIN_PAY_HOLDER_RE, readAdminPayAttempt } from './pay-invoice-admin'
import { timingSafeEqualStr } from '../utils/timing-safe'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const MIN_EVIDENCE_CHARS = 20
const MAX_EVIDENCE_CHARS = 1000

const COUPON_HOLDER_RE = /^coupon:(\d{8}|\d{10}):(.+)$/
const WEBHOOK_CLEARABLE = new Set(['manual_review', 'failed_pay_invoice'])
// A manual pay whose outcome is unknown (request threw or 5xx) is clearable only
// after this long, mirroring the webhook rule that an unknown outcome waits for
// the sweep. Operational number, agent-set.
export const ADMIN_PAY_UNKNOWN_CLEAR_AFTER_MS = 60 * 60 * 1000

// Moved to coinbase-exec-gate.ts (coupon.ts needs it and coupon.ts is
// imported by this module); re-exported so existing importers keep working.
export { coinbaseExplicitlyUnsettled }

export function coinbaseExecGateClearLogKey(plId: string): string {
  return `coinbase-pay-exec-clear-log:v1:${plId}`
}

async function lastClearLogEntry(env: Env, plId: string): Promise<any | null> {
  const { value } = await casRead(env, coinbaseExecGateClearLogKey(plId))
  if (!value) return null
  try {
    const log = JSON.parse(value)
    return Array.isArray(log) && log.length ? log[log.length - 1] : null
  } catch {
    return null
  }
}

export async function handleCoinbaseExecGateClear(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!env.PAYINVOICE_ADMIN_SECRET) return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  const callerSecret = request.headers.get('x-admin-secret')?.trim()
  if (!callerSecret || !timingSafeEqualStr(callerSecret, env.PAYINVOICE_ADMIN_SECRET)) return json(401, { error: 'Unauthorized' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid JSON body' })
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'expected a JSON object' })

  const plId = typeof body.plId === 'string' ? body.plId.trim() : ''
  if (!isCoinbasePaymentId(plId)) return json(400, { error: 'plId must be a pl_* or paymentSession_* id' })
  const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : ''
  if (evidence.length < MIN_EVIDENCE_CHARS || evidence.length > MAX_EVIDENCE_CHARS) {
    return json(400, { error: `evidence must be ${MIN_EVIDENCE_CHARS}-${MAX_EVIDENCE_CHARS} characters describing what was verified` })
  }
  const clearedBy = typeof body.clearedBy === 'string' ? body.clearedBy.trim() : ''
  if (!clearedBy || clearedBy.length > 100) return json(400, { error: 'clearedBy is required (who verified)' })

  const expectedHolder = typeof body.expectedHolder === 'string' ? body.expectedHolder.trim() : ''
  if (!expectedHolder) return json(400, { error: 'expectedHolder is required (the holder you verified)' })

  const holder = await readCoinbaseExecGate(env, plId)
  if (!holder) {
    // Read-back for a clear whose response was lost: the gate is already free
    // and the invoice claim is still parked on the re-pay ref the last clear
    // logged. No pay ran under that ref (it would hold the gate again), so the
    // same ref is returned instead of leaving the claim on a ref nobody knows.
    const last = await lastClearLogEntry(env, plId)
    const claim = await readInvoiceClaim(env, plId)
    if (
      last &&
      typeof last.repayRef === 'string' &&
      last.previousHolder?.holder === expectedHolder &&
      claim?.channel === 'crypto' &&
      claim.ref === last.repayRef
    ) {
      return json(200, { ok: true, changed: false, reason: 'already cleared; re-pay ref unused', plId, repayRef: last.repayRef })
    }
    return json(200, { ok: true, changed: false, reason: 'gate not held', plId })
  }
  if (holder.holder !== expectedHolder) {
    return json(409, { error: 'gate holder does not match expectedHolder', plId, holder: holder.holder })
  }

  // (a) The holder's record must be parked for a human, never in flight.
  const couponMatch = COUPON_HOLDER_RE.exec(expectedHolder)
  if (couponMatch) {
    const [, code, attemptId] = couponMatch
    const coupon = parseCouponRecord(await couponCasRead(env, couponKey(code)))
    if (!coupon || coupon.status !== 'manual_review' || coupon.attemptId !== attemptId || coupon.plId !== plId) {
      return json(409, {
        error: 'coupon record is not in manual_review for this attempt and link; refusing to clear',
        plId,
        couponStatus: coupon?.status ?? null,
      })
    }
  } else if (ADMIN_PAY_HOLDER_RE.test(expectedHolder)) {
    // Manual /admin/pay-invoice holder: its own attempt record must exist for
    // this holder and be a definite failure, or an unknown outcome old enough.
    // An attempt record that is missing or names another ref means this
    // holder's "sent" marker was never written, so its request never went out
    // (the marker is written before the fetch). That case, like an unknown
    // outcome, waits until the gate is old enough that no request taken under
    // it can still be running.
    const attempt = await readAdminPayAttempt(env, plId)
    const ownAttempt = !!attempt && attempt.ref === expectedHolder
    const age = ownAttempt ? Date.now() - Date.parse(attempt!.at) : Date.now() - Date.parse(holder.at)
    const parked = ownAttempt
      ? attempt!.status === 'failed' ||
        ((attempt!.status === 'unknown' || attempt!.status === 'sent') && age >= ADMIN_PAY_UNKNOWN_CLEAR_AFTER_MS)
      : age >= ADMIN_PAY_UNKNOWN_CLEAR_AFTER_MS
    if (!parked) {
      return json(409, {
        error: 'manual pay attempt is not a definite failure (or an unknown outcome older than 1 h); refusing to clear',
        plId,
        attemptStatus: attempt?.status ?? null,
      })
    }
  } else {
    const rec = await loadRecord(env, plId)
    if (!rec || !WEBHOOK_CLEARABLE.has(rec.status)) {
      return json(409, {
        error: 'fulfillment record must be manual_review or failed_pay_invoice; refusing to clear',
        plId,
        recordStatus: rec?.status ?? null,
      })
    }
  }

  // (b) Coinbase must explicitly say NOT settled. Unreadable → 502, anything
  // not explicitly recognized as unsettled (incl. settled) → 409.
  const raw = await fetchCoinbasePayment(plId)
  if (!raw) return json(502, { error: 'cannot read Coinbase status; refusing to clear without verification', plId })
  const unsettled = coinbaseExplicitlyUnsettled(raw)
  if (!unsettled) {
    return json(409, {
      error: 'Coinbase status is settled or not recognized as unsettled; the gate stays',
      plId,
      coinbaseStatus: typeof raw.status === 'string' ? raw.status : null,
    })
  }

  // (c) Verified recovery path for a manual /admin/pay-invoice re-pay: the
  // per-invoice claim taken by the failed manual attempt would otherwise refuse
  // every later payment for good. Hand that crypto claim to a fresh re-pay ref;
  // /admin/pay-invoice accepts it as `repay_ref`. Only for admin-pay holders:
  // a coupon re-pay (release + redeem) and a webhook record re-enter their own
  // claim, so theirs is left untouched. A UPI claim is never taken over.
  // Order: hand over, log, then release the gate. A crash before the release
  // leaves the gate held, so a retry of this clear redoes every step; a crash
  // or lost response after it is answered by the read-back above.
  const isAdminPayHolder = ADMIN_PAY_HOLDER_RE.test(expectedHolder)
  const repayRef = `admin-repay:${crypto.randomUUID()}`
  const handover: HandOverResult | null = isAdminPayHolder ? await handOverCryptoClaim(env, plId, repayRef) : null

  const at = new Date().toISOString()
  const entry = {
    at,
    clearedBy,
    evidence,
    previousHolder: holder,
    coinbaseStatus: unsettled,
    repayRef: handover?.ok ? repayRef : null,
    previousClaim: handover ? (handover.ok ? handover.previous : handover.holder) : null,
  }
  await casUpdate<null>(env, coinbaseExecGateClearLogKey(plId), (cur) => {
    let log: unknown[] = []
    try {
      const parsed = cur ? JSON.parse(cur) : []
      if (Array.isArray(parsed)) log = parsed
    } catch {
      /* corrupt log: start fresh, the new entry is still recorded */
    }
    log.push(entry)
    return { op: 'set', value: JSON.stringify(log), result: null }
  })

  // (d) Single CAS: clears only if the stored holder still equals expectedHolder.
  const cleared = await releaseCoinbaseExecGate(env, plId, expectedHolder)
  if (!cleared) return json(409, { error: 'gate holder changed during the request; gate not released', plId })

  const rec = await loadRecord(env, plId)
  if (rec) {
    rec.events.push({ kind: 'exec_gate_cleared_by_admin', at, detail: entry })
    await saveRecordGuarded(env, plId, rec)
  }
  console.log(`[coinbase-exec-gate] cleared by admin: ${JSON.stringify({ plId, clearedBy, at, coinbaseStatus: entry.coinbaseStatus })}`)

  return json(200, {
    ok: true,
    changed: cleared,
    plId,
    clearedAt: at,
    coinbaseStatus: entry.coinbaseStatus,
    repayRef: entry.repayRef,
    ...(handover && !handover.ok ? { claimHeldBy: handover.holder.channel } : {}),
  })
}
