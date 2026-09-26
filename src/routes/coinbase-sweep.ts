// Cron reconciliation for Coinbase invoice fulfillments (webhook.ts records).
//
// Side effects: rewrites KV fulfillment records, sends DingTalk alerts, and
// reports delivery to Rozo (POST /payments/<id>/delivered). It NEVER calls
// pay-invoice: a stuck or ambiguous payment is resolved by READING Coinbase,
// and anything that would need a second payment goes to a human.
//
// Per record (≤ SWEEP_MAX_RECORDS acted on per run):
//   1. capture_pending, or paying for > 10 min (payingAt): read Coinbase.
//      settled → paid. failed/expired, or still pending > 30 min after
//      payingAt → manual_review + one alert. Query failure → no state change;
//      one alert only if queries keep failing for > 30 min.
//   2. payin_seen / failed_insufficient_balance whose Rozo payment is
//      payment_payout_completed while the Coinbase link is unsettled and
//      unexpired for > 10 min → one "stuck" alert (the payout webhook was
//      probably never delivered). No payment.
//   3. paid and not yet reported as delivered, Coinbase settled → report to
//      Rozo. Only HTTP 200 marks it reported; one alert after 5 failures.

import type { Env } from '../index'
import { sendDingTalkAlert } from '../utils/dingtalk'
import { redactForAlert } from '../utils/alert-redaction'
import {
  type FulfillmentRecord,
  fetchCoinbasePayment,
  fetchRozoPaymentById,
  deliveredReportEnabled,
  isCoinbasePaymentId,
  loadRecord,
  maskAddresses,
  pickCoinbaseCallerSafe,
  reportDeliveredToRozo,
  saveRecordGuarded,
} from './webhook'

const KV_PREFIX = 'invoice-fulfillment:'
// Stripe records live under a provider-qualified namespace; never ours.
const STRIPE_PREFIX = 'invoice-fulfillment:v2:'
export const SWEEP_MAX_RECORDS = 20
const MAX_LIST_PAGES = 5

const MIN = 60 * 1000
const PAYING_STALE_MS = 10 * MIN
const PENDING_GIVE_UP_MS = 30 * MIN
const QUERY_FAIL_ALERT_MS = 30 * MIN
const STUCK_ALERT_MS = 10 * MIN
// Payin-side records are only watched for a day; after that they are either
// resolved, alerted, or not ours to chase.
const STUCK_WATCH_WINDOW_MS = 24 * 60 * MIN
export const DELIVERED_MAX_ATTEMPTS = 5

type Action = 'confirm' | 'stuck' | 'deliver'

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function firstEventMs(rec: FulfillmentRecord): number | null {
  let min: number | null = null
  for (const e of rec.events ?? []) {
    const t = ms(e.at)
    if (t !== null && (min === null || t < min)) min = t
  }
  return min
}

function lastEventMs(rec: FulfillmentRecord): number | null {
  let max: number | null = null
  for (const e of rec.events ?? []) {
    const t = ms(e.at)
    if (t !== null && (max === null || t > max)) max = t
  }
  return max
}

// payingAt is the fixed anchor. Records written before it existed fall back
// to the last event time.
function payingSinceMs(rec: FulfillmentRecord): number | null {
  return ms(rec.payingAt ?? null) ?? lastEventMs(rec)
}

function classify(env: Env, rec: FulfillmentRecord, now: number): Action | null {
  if (rec.status === 'capture_pending') return 'confirm'
  if (rec.status === 'paying') {
    const since = payingSinceMs(rec)
    return since !== null && now - since > PAYING_STALE_MS ? 'confirm' : null
  }
  if (rec.status === 'payin_seen' || rec.status === 'failed_insufficient_balance') {
    if (rec.alertedStuck || !rec.rozoPaymentId) return null
    const first = firstEventMs(rec)
    if (first !== null && now - first > STUCK_WATCH_WINDOW_MS) return null
    return 'stuck'
  }
  if (rec.status === 'paid') {
    if (!deliveredReportEnabled(env) || rec.deliveredReported || !rec.rozoPaymentId) return null
    if ((rec.deliveredReportAttempts ?? 0) >= DELIVERED_MAX_ATTEMPTS) return null
    return 'deliver'
  }
  return null
}

// v1 preApprovalExpiry is unix seconds (string); v3 expiresAt is ISO.
function expiryMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

const COINBASE_FAILED_RE = /FAILED|EXPIRED|CANCEL|VOID|REFUND/

function coinbaseFailedOrExpired(safe: any, now: number): string | null {
  const status = typeof safe?.status === 'string' ? safe.status : ''
  if (COINBASE_FAILED_RE.test(status)) return `coinbase status ${status}`
  const exp = expiryMs(safe?.preApprovalExpiry)
  if (exp !== null && exp < now) return 'coinbase link/session expired'
  return null
}

function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '?'
}

function fmtUsdc(atomic: string | null | undefined): string {
  if (!atomic) return '?'
  try {
    return (Number(BigInt(atomic)) / 1e6).toFixed(2)
  } catch {
    return '?'
  }
}

// Never throws. Masked: addresses first-6/last-4, Rozo id first 8 chars.
async function sendSweepAlert(env: Env, lines: string[]): Promise<void> {
  try {
    const text = maskAddresses([...lines, `At: ${new Date().toISOString()}`].join('\n'))
    if (!env.DINGTALK_ACCESS_TOKEN) {
      console.warn(`[coinbase-sweep] alert SKIPPED (DINGTALK_ACCESS_TOKEN not set): ${text}`)
      return
    }
    await sendDingTalkAlert(env.DINGTALK_ACCESS_TOKEN, redactForAlert(text))
  } catch (err) {
    console.warn(
      `[coinbase-sweep] alert error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function header(rec: FulfillmentRecord, plId: string): string {
  return `Invoice: ${plId} (${fmtUsdc(rec.invoiceAmountAtomic)} USDC), Rozo payment ${shortId(rec.rozoPaymentId)}`
}

async function confirmFromCoinbase(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  const nowIso = new Date(now).toISOString()
  const raw = await fetchCoinbasePayment(plId)
  if (!raw) {
    // Query failure: never change state on missing information.
    if (!rec.coinbaseQueryFailingSince) rec.coinbaseQueryFailingSince = nowIso
    const since = ms(rec.coinbaseQueryFailingSince) ?? now
    if (now - since > QUERY_FAIL_ALERT_MS && !rec.alertedQueryFailing) {
      rec.alertedQueryFailing = true
      await sendSweepAlert(env, [
        `[MPP Router] ⚠️ Coinbase status query failing for > 30 min (record ${rec.status})`,
        header(rec, plId),
        'Cannot confirm whether the invoice was captured. No action taken; check Coinbase manually.',
      ])
    }
    await saveRecordGuarded(env, plId, rec)
    return
  }
  rec.coinbaseQueryFailingSince = null
  const safe = pickCoinbaseCallerSafe(raw)
  if (safe?.settled) {
    const from = rec.status
    rec.status = 'paid'
    rec.paidAt = rec.paidAt ?? nowIso
    rec.events.push({ kind: 'sweep_coinbase_settled', at: nowIso, detail: { from, coinbase_status: safe.status } })
    const saved = await saveRecordGuarded(env, plId, rec)
    if (saved.status === 'paid') await reportDelivered(env, plId, saved, now)
    return
  }
  const failed = coinbaseFailedOrExpired(safe, now)
  const since = payingSinceMs(rec)
  const timedOut = since !== null && now - since > PENDING_GIVE_UP_MS
  if (failed || timedOut) {
    const reason = failed ?? `coinbase still ${safe?.status ?? 'unknown'} > 30 min after pay request`
    const from = rec.status
    rec.status = 'manual_review'
    rec.failureReason = reason
    rec.events.push({ kind: 'sweep_manual_review', at: nowIso, detail: { from, reason, coinbase_status: safe?.status ?? null } })
    const alert = !rec.alertedManualReview
    rec.alertedManualReview = true
    await saveRecordGuarded(env, plId, rec)
    if (alert) {
      await sendSweepAlert(env, [
        '[MPP Router] 🚨 Invoice NOT delivered: pay request sent but Coinbase did not capture',
        header(rec, plId),
        `Coinbase status: ${safe?.status ?? 'unknown'}; was ${from}`,
        `Reason: ${reason}`,
        'The pay request was already sent, so this is NEVER retried automatically. Decide re-pay or refund by hand (runbook: invoice-fulfillment techdoc §manual re-pay).',
      ])
    }
    return
  }
  // Still pending inside the 30-minute window: persist the cleared query
  // failure marker only.
  await saveRecordGuarded(env, plId, rec)
}

async function checkStuck(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  const rozo = await fetchRozoPaymentById(env, rec.rozoPaymentId as string)
  if (!rozo || rozo.status !== 'payment_payout_completed') return
  const raw = await fetchCoinbasePayment(plId)
  if (!raw) return
  const safe = pickCoinbaseCallerSafe(raw)
  if (safe?.settled || coinbaseFailedOrExpired(safe, now)) return
  const nowIso = new Date(now).toISOString()
  const payoutAt = ms(rozo.destination?.confirmedAt ?? null)
  if (!rec.stuckSince) rec.stuckSince = nowIso
  const since = payoutAt ?? ms(rec.stuckSince) ?? now
  if (now - since <= STUCK_ALERT_MS) {
    await saveRecordGuarded(env, plId, rec)
    return
  }
  rec.alertedStuck = true
  rec.events.push({ kind: 'sweep_stuck_alert', at: nowIso, detail: { record_status: rec.status, coinbase_status: safe?.status ?? null } })
  await saveRecordGuarded(env, plId, rec)
  await sendSweepAlert(env, [
    '[MPP Router] 🚨 Invoice NOT delivered: Rozo payout completed but the Coinbase invoice is unpaid',
    header(rec, plId),
    `Router state: ${rec.status}; Coinbase: ${safe?.status ?? 'unknown'}`,
    'The payout webhook was likely never delivered. No automatic payment is made; resend the payout webhook or pay by hand.',
  ])
}

async function reportDelivered(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  if (!rec.rozoPaymentId || rec.deliveredReported || !deliveredReportEnabled(env)) return
  const nowIso = new Date(now).toISOString()
  const rep = await reportDeliveredToRozo(env, rec.rozoPaymentId, plId)
  if (rep.ok) {
    rec.deliveredReported = true
    rec.events.push({ kind: 'delivered_reported', at: nowIso, detail: { status: rep.status } })
    await saveRecordGuarded(env, plId, rec)
    return
  }
  rec.deliveredReportAttempts = (rec.deliveredReportAttempts ?? 0) + 1
  rec.events.push({ kind: 'delivered_report_failed', at: nowIso, detail: { status: rep.status } })
  const giveUp = rec.deliveredReportAttempts >= DELIVERED_MAX_ATTEMPTS && !rec.alertedDeliveredGiveUp
  if (giveUp) rec.alertedDeliveredGiveUp = true
  await saveRecordGuarded(env, plId, rec)
  if (giveUp) {
    await sendSweepAlert(env, [
      `[MPP Router] ⚠️ Delivery report to Rozo failed ${rec.deliveredReportAttempts} times (last HTTP ${rep.status})`,
      header(rec, plId),
      'The invoice IS paid on Coinbase; only the Rozo delivered marker is missing.',
    ])
  }
}

async function deliverIfSettled(env: Env, plId: string, rec: FulfillmentRecord, now: number): Promise<void> {
  if (!deliveredReportEnabled(env)) return
  const raw = await fetchCoinbasePayment(plId)
  if (!raw) return
  const safe = pickCoinbaseCallerSafe(raw)
  if (!safe?.settled) return
  await reportDelivered(env, plId, rec, now)
}

/**
 * Cron entry point. Never throws (it rides the shared scheduled() handler).
 */
export async function sweepCoinbaseFulfillments(
  env: Env,
  now: number = Date.now(),
): Promise<{ scanned: number; acted: number }> {
  let scanned = 0
  let acted = 0
  try {
    // Collect candidates first so money-state work (confirm, deliver) is never
    // starved by payin-side watch records.
    const candidates: Array<{ plId: string; rec: FulfillmentRecord; action: Action }> = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await env.MPP_STORE.list({ prefix: KV_PREFIX, cursor })
      for (const k of res.keys) {
        if (k.name.startsWith(STRIPE_PREFIX)) continue
        const plId = k.name.slice(KV_PREFIX.length)
        if (!isCoinbasePaymentId(plId)) continue
        scanned++
        const rec = await loadRecord(env, plId)
        if (!rec) continue
        const action = classify(env, rec, now)
        if (action) candidates.push({ plId, rec, action })
      }
      if (res.list_complete) break
      cursor = (res as { cursor?: string }).cursor
      if (!cursor) break
    }
    const rank: Record<Action, number> = { confirm: 0, deliver: 1, stuck: 2 }
    candidates.sort((x, y) => rank[x.action] - rank[y.action])
    for (const { plId, rec, action } of candidates.slice(0, SWEEP_MAX_RECORDS)) {
      acted++
      try {
        if (action === 'confirm') await confirmFromCoinbase(env, plId, rec, now)
        else if (action === 'stuck') await checkStuck(env, plId, rec, now)
        else await deliverIfSettled(env, plId, rec, now)
      } catch (err) {
        console.warn(
          `[coinbase-sweep] ${plId} ${action} error (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  } catch (err) {
    console.warn(
      `[coinbase-sweep] sweep error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return { scanned, acted }
}
