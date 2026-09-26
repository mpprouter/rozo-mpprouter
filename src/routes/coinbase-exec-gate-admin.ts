// POST /admin/coinbase-exec-gate/clear — the manual re-pay escape hatch.
//
// The Coinbase execution gate (coinbase-exec-gate.ts) is never released once a
// pay-invoice request was sent. When a human has decided an invoice must be
// paid again (e.g. a `manual_review` record whose pay request never reached
// Coinbase), they clear the gate HERE, which:
//
//   - requires x-admin-secret (same gate as /admin/pay-invoice),
//   - requires `evidence` (what was verified) and `clearedBy` (who),
//   - re-reads Coinbase and REFUSES if the link/session is settled, or if
//     Coinbase cannot be read (no verification, no clear),
//   - appends an audit entry (DO key `coinbase-pay-exec-clear-log:v1:<plId>`)
//     and an event on the KV fulfillment record, then clears the gate.
//
// Clearing the gate does not pay anything. The re-pay itself is a separate,
// deliberate step (replay the payout webhook or /admin/pay-invoice).

import type { Env } from '../index'
import { casUpdate } from './stripe-atomic'
import { coinbaseExecGateKey, readCoinbaseExecGate } from './coinbase-exec-gate'
import {
  fetchCoinbasePayment,
  isCoinbasePaymentId,
  loadRecord,
  pickCoinbaseCallerSafe,
  saveRecordGuarded,
} from './webhook'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const MIN_EVIDENCE_CHARS = 20
const MAX_EVIDENCE_CHARS = 1000

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

  const holder = await readCoinbaseExecGate(env, plId)
  if (!holder) return json(200, { ok: true, changed: false, reason: 'gate not held', plId })

  // Verify against Coinbase right now. Settled → never allow a second pay.
  const raw = await fetchCoinbasePayment(plId)
  if (!raw) return json(502, { error: 'cannot read Coinbase status; refusing to clear without verification', plId })
  const safe = pickCoinbaseCallerSafe(raw)
  if (safe?.settled) {
    return json(409, { error: 'Coinbase reports this invoice as settled; the gate stays', plId, coinbaseStatus: safe.status })
  }

  const at = new Date().toISOString()
  const entry = { at, clearedBy, evidence, previousHolder: holder, coinbaseStatus: safe?.status ?? null }
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
  const cleared = await casUpdate<boolean>(env, coinbaseExecGateKey(plId), (cur) => {
    if (!cur) return { op: 'noop', result: false }
    return { op: 'set', value: '', result: true }
  })

  const rec = await loadRecord(env, plId)
  if (rec) {
    rec.events.push({ kind: 'exec_gate_cleared_by_admin', at, detail: entry })
    await saveRecordGuarded(env, plId, rec)
  }
  console.log(`[coinbase-exec-gate] cleared by admin: ${JSON.stringify({ plId, clearedBy, at, coinbaseStatus: entry.coinbaseStatus })}`)

  return json(200, { ok: true, changed: cleared, plId, clearedAt: at, coinbaseStatus: entry.coinbaseStatus })
}
