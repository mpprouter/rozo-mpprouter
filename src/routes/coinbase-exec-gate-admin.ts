// POST /admin/coinbase-exec-gate/clear — the manual re-pay escape hatch.
//
// The Coinbase execution gate (coinbase-exec-gate.ts) is never released once a
// pay-invoice request was sent. When a human has decided an invoice must be
// paid again, they clear the gate HERE. Clearing must never race a pay-invoice
// request that is still in flight, so ALL of these must hold:
//
//   (a) the holder's own record is parked for a human:
//       - webhook holder: KV fulfillment record status is `manual_review` or
//         `failed_pay_invoice` (never paying / capture_pending / paid / payin_seen);
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
import { casUpdate } from './stripe-atomic'
import { readCoinbaseExecGate, releaseCoinbaseExecGate } from './coinbase-exec-gate'
import { casRead as couponCasRead, couponKey, parseRecord as parseCouponRecord } from './coupon'
import { fetchCoinbasePayment, isCoinbasePaymentId, loadRecord, saveRecordGuarded } from './webhook'

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

/**
 * Explicit NOT-settled recognition from the raw public Coinbase object.
 * Returns the status label when recognized as unsettled, null otherwise
 * (settled, unknown, empty or unparseable — all refuse).
 */
export function coinbaseExplicitlyUnsettled(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.paymentSessionId === 'string') {
    return raw.status === 'PAYMENT_SESSION_STATUS_CREATED' ? raw.status : null
  }
  const used = raw.usageCount
  const max = raw.maxUsage
  if (typeof used === 'number' && typeof max === 'number' && Number.isFinite(used) && Number.isFinite(max) && used < max) {
    return `v1 usage ${used}/${max}`
  }
  return null
}

export function coinbaseExecGateClearLogKey(plId: string): string {
  return `coinbase-pay-exec-clear-log:v1:${plId}`
}

export async function handleCoinbaseExecGateClear(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!env.PAYINVOICE_ADMIN_SECRET) return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  const callerSecret = request.headers.get('x-admin-secret')?.trim()
  if (!callerSecret || callerSecret !== env.PAYINVOICE_ADMIN_SECRET) return json(401, { error: 'Unauthorized' })

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
  if (!holder) return json(200, { ok: true, changed: false, reason: 'gate not held', plId })
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

  // (c) Single CAS: clears only if the stored holder still equals expectedHolder.
  const cleared = await releaseCoinbaseExecGate(env, plId, expectedHolder)
  if (!cleared) return json(409, { error: 'gate holder changed during the request; nothing cleared', plId })

  const at = new Date().toISOString()
  const entry = { at, clearedBy, evidence, previousHolder: holder, coinbaseStatus: unsettled }
  await casUpdate<null>(env, coinbaseExecGateClearLogKey(plId), (cur) => {
    let log: unknown[] = []
    try {
      const parsed = cur ? JSON.parse(cur) : []
      if (Array.isArray(parsed)) log = parsed
    } catch {
      /* corrupt log — start fresh, the new entry is still recorded */
    }
    log.push(entry)
    return { op: 'set', value: JSON.stringify(log), result: null }
  })
  const rec = await loadRecord(env, plId)
  if (rec) {
    rec.events.push({ kind: 'exec_gate_cleared_by_admin', at, detail: entry })
    await saveRecordGuarded(env, plId, rec)
  }
  console.log(`[coinbase-exec-gate] cleared by admin: ${JSON.stringify({ plId, clearedBy, at, coinbaseStatus: entry.coinbaseStatus })}`)

  return json(200, { ok: true, changed: cleared, plId, clearedAt: at, coinbaseStatus: entry.coinbaseStatus })
}
