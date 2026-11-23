// Delayed retry queue for Celo-sourced settlements (celo-finality.ts).
//
// Why: the Celo gate defers any funder payment until the payin block is
// finalized (~25 to 30 minutes on Celo). Rozo does not resend a webhook that
// was answered 200, so if both the payin and payout webhooks arrive before
// finality, nothing would ever re-drive the payment. Every Celo gate deferral
// therefore enqueues the order here, and the 2-minute cron re-runs the SAME
// settle path (settleCoinbaseEvent / handleStripeWebhookEvent /
// settleBitrefillFunderEvent), which re-checks the gate and pays only through
// the existing idempotent machinery (cross-channel claim + non-re-entrant exec
// gate + paying-before-call). This module never calls pay-invoice itself, and
// coinbase-sweep stays read-only.
//
// Storage: the ATOMIC_STORE Durable Object (casUpdate / casScan), the same
// linearizable store the checkout paused-delivery backlog (the other
// "re-drive a webhook later" queue) uses. One key per invoice ref under its
// own prefix, so this queue never shares a scan or a per-run limit with any
// other chain's work.
//
// Schedule: attempt n (0-based) runs CELO_RETRY_DELAY_MS(n) after the previous
// one: 2, 3, 4, 5, 5, 5 ... minutes. An entry older than CELO_RETRY_MAX_AGE_MS
// (3 h) that is still not paid alerts once ("needs a human") and is removed.
// While CELO_FULFILLMENT_PAUSED is not "off" entries are kept untouched: not
// re-driven, not aged out, not alerted. At most CELO_RETRY_MAX_PER_RUN due
// entries are re-driven per cron run (oldest due first).

import type { Env } from '../index'
import { alertSinkConfigured, sendAlert } from '../utils/alert'
import { redactForAlert } from '../utils/alert-redaction'
import { casRead, casScan, casUpdate } from './stripe-atomic'
import { celoFulfillmentPaused } from './celo-finality'

export const CELO_RETRY_PREFIX = 'celo-retry:v1:'
export const CELO_RETRY_MAX_AGE_MS = 3 * 60 * 60 * 1000
export const CELO_RETRY_MAX_PER_RUN = 10
const MIN = 60 * 1000

/** Delay before attempt `n` (0-based): 2, 3, 4, then 5 minutes. */
export function CELO_RETRY_DELAY_MS(n: number): number {
  return Math.min(2 + Math.max(0, n), 5) * MIN
}

export type CeloRetryProvider = 'coinbase' | 'stripe' | 'bitrefill'

export interface CeloRetryEntry {
  provider: CeloRetryProvider
  ref: string // Coinbase pl_*/paymentSession_*, Bitrefill id, or Stripe orderId
  rozoPaymentId: string | null
  eventType: string
  firstAt: string
  nextAt: string
  attempts: number
  lastReason: string | null
}

export function celoRetryKey(ref: string): string {
  return `${CELO_RETRY_PREFIX}${ref}`
}

function parseEntry(raw: string | null): CeloRetryEntry | null {
  if (!raw) return null
  try {
    const e = JSON.parse(raw) as CeloRetryEntry
    if (
      (e.provider === 'coinbase' || e.provider === 'stripe' || e.provider === 'bitrefill') &&
      typeof e.ref === 'string' &&
      typeof e.nextAt === 'string'
    ) {
      return e
    }
    return null
  } catch {
    return null
  }
}

/**
 * Add or reschedule a Celo deferral. Keeps the first-seen time (the 3 h clock),
 * never downgrades a payout event to a payin event, and schedules the next
 * attempt with backoff. Never throws: a failed write pages a human.
 */
export async function enqueueCeloRetry(
  env: Env,
  entry: { provider: CeloRetryProvider; ref: string; rozoPaymentId: string | null; eventType: string; reason: string },
  now: Date = new Date(),
): Promise<boolean> {
  const at = now.toISOString()
  try {
    await casUpdate<true>(env, celoRetryKey(entry.ref), (raw) => {
      const prev = parseEntry(raw)
      const attempts = prev ? prev.attempts + 1 : 0
      const next: CeloRetryEntry = {
        provider: entry.provider,
        ref: entry.ref,
        rozoPaymentId: entry.rozoPaymentId ?? prev?.rozoPaymentId ?? null,
        eventType: prev?.eventType === 'payment_payout_completed' ? prev.eventType : entry.eventType,
        firstAt: prev?.firstAt ?? at,
        nextAt: new Date(now.getTime() + CELO_RETRY_DELAY_MS(attempts)).toISOString(),
        attempts,
        lastReason: entry.reason.slice(0, 200),
      }
      return { op: 'set', value: JSON.stringify(next), result: true }
    })
    return true
  } catch (err) {
    console.error(`[celo-retry] enqueue failed for ${entry.ref}: ${err instanceof Error ? err.message : String(err)}`)
    if (alertSinkConfigured(env)) {
      await sendAlert(
        env,
        redactForAlert(
          `[MPP Router] ⚠️ Celo payin deferred but NOT queued for retry: ${entry.provider} ${entry.ref} (Rozo ${entry.rozoPaymentId ?? 'unknown'}). ` +
            'Nothing was paid. Re-drive it by hand (resend the webhook) once the payin block is finalized.',
        ),
      ).catch(() => false)
    }
    return false
  }
}

/** Remove the entry; with `seen`, only if it was not rescheduled meanwhile. */
export async function clearCeloRetry(env: Env, ref: string, seen?: CeloRetryEntry): Promise<boolean> {
  return casUpdate<boolean>(env, celoRetryKey(ref), (raw) => {
    if (!raw) return { op: 'noop', result: true }
    if (seen) {
      const cur = parseEntry(raw)
      if (cur && (cur.attempts !== seen.attempts || cur.nextAt !== seen.nextAt)) return { op: 'noop', result: false }
    }
    return { op: 'set', value: '', result: true }
  })
}

/** The current entry for `ref`, or null (absent or cleared). */
export async function readCeloRetry(env: Env, ref: string): Promise<CeloRetryEntry | null> {
  const r = await casRead(env, celoRetryKey(ref))
  return parseEntry(r.value)
}

export async function listCeloRetries(env: Env): Promise<CeloRetryEntry[]> {
  const values = await casScan(env, CELO_RETRY_PREFIX)
  return values.map(parseEntry).filter((e): e is CeloRetryEntry => e !== null)
}

/** One re-drive through the normal settle path. Returns its summary. */
export type CeloRedrive = (env: Env, entry: CeloRetryEntry, eventId: string) => Promise<Record<string, unknown>>

export interface CeloRetryRunResult {
  ref: string
  outcome: 'paused_kept' | 'not_due' | 'gave_up' | 'still_deferred' | 'handed_back' | 'error'
  detail?: string
}

/**
 * Cron entry point. Never throws. Re-drives due entries through `redrive`
 * (the normal settle path). A summary still deferred by the Celo gate was
 * already rescheduled by that path (enqueueCeloRetry). A summary marked
 * `celoRetryKeep` (record still pre-pay, nobody paged) or an unreadable order
 * is rescheduled here. Anything else (paid, in flight, terminal, a human
 * paged, or the checkout-pause backlog owns it) removes the entry.
 */
export async function runCeloRetries(
  env: Env,
  redrive: CeloRedrive,
  now: Date = new Date(),
): Promise<CeloRetryRunResult[]> {
  const out: CeloRetryRunResult[] = []
  let entries: CeloRetryEntry[]
  try {
    entries = await listCeloRetries(env)
  } catch (err) {
    console.warn(`[celo-retry] scan failed: ${err instanceof Error ? err.message : String(err)}`)
    return out
  }
  if (entries.length === 0) return out

  // Paused: keep everything as is. No re-drive, no ageing out, no alert.
  if (celoFulfillmentPaused(env)) {
    return entries.map((e) => ({ ref: e.ref, outcome: 'paused_kept' as const }))
  }

  const nowMs = now.getTime()
  const due = entries
    .filter((e) => Date.parse(e.nextAt) <= nowMs)
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
  for (const e of entries) if (!due.includes(e)) out.push({ ref: e.ref, outcome: 'not_due' })

  for (const entry of due.slice(0, CELO_RETRY_MAX_PER_RUN)) {
    try {
      const first = Date.parse(entry.firstAt)
      const expired = Number.isFinite(first) && nowMs - first > CELO_RETRY_MAX_AGE_MS
      // Always re-drive first, even past the 3 h limit: the settle path re-runs
      // the gate and pays only through the idempotent machinery, so a payin
      // that finalized while Celo was paused (the queue does not age while
      // paused, but firstAt keeps counting) is still paid on the first run
      // after resume instead of being dropped unchecked.
      const eventId = `celo-retry:${entry.ref}:${entry.attempts + 1}:${crypto.randomUUID()}`
      const summary = await redrive(env, entry, eventId)
      const stillDeferred = summary?.deferred === 'celo_finality'
      const keep = summary?.deferred === 'rozo_unreadable' || summary?.celoRetryKeep === true
      if ((stillDeferred || keep) && expired) {
        // Past the limit and still not paid: drop the entry only once the
        // alert is out. A failed alert keeps it and tries again next run.
        if (await alertGaveUp(env, { ...entry, lastReason: String(summary?.reason ?? entry.lastReason ?? '') || null })) {
          // The re-drive above may have rescheduled the entry itself; clear
          // the version read now, so a reschedule by anyone after this read
          // is kept rather than deleted.
          const cur = await readCeloRetry(env, entry.ref)
          if (cur) await clearCeloRetry(env, entry.ref, cur)
          out.push({ ref: entry.ref, outcome: 'gave_up' })
        } else {
          await enqueueCeloRetry(env, { ...entry, reason: entry.lastReason ?? 'give-up alert not delivered' }, now)
          out.push({ ref: entry.ref, outcome: 'error', detail: 'give-up alert not delivered; kept' })
        }
        continue
      }
      if (stillDeferred) {
        out.push({ ref: entry.ref, outcome: 'still_deferred', detail: String(summary.reason ?? '') })
        continue
      }
      // Not paid and nothing else owns it yet (order unreadable, binding not
      // verifiable right now, funder short on a payin event, daily cap...):
      // keep it, with backoff, until it is paid or the 3 h limit alerts.
      if (keep) {
        const why = String(summary.reason ?? summary.deferred ?? summary.celoRetryRecordStatus ?? 'not paid yet')
        await enqueueCeloRetry(env, { ...entry, reason: why }, now)
        out.push({ ref: entry.ref, outcome: 'still_deferred', detail: why })
        continue
      }
      // Version-checked: if anything rescheduled this entry meanwhile (a
      // concurrent cron run or webhook deferral after a balance / cap
      // setback), keep it; the next run re-drives and decides again.
      const cleared = await clearCeloRetry(env, entry.ref, entry)
      out.push({ ref: entry.ref, outcome: cleared ? 'handed_back' : 'still_deferred', detail: cleared ? JSON.stringify(summary).slice(0, 200) : 'rescheduled meanwhile; kept' })
    } catch (err) {
      // Keep the entry and push it back; the next run retries.
      await enqueueCeloRetry(env, { ...entry, reason: 'retry threw' }, now).catch(() => false)
      out.push({ ref: entry.ref, outcome: 'error', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' })
    }
  }
  return out
}

/**
 * True once the alert is delivered. With no alert channel at all it is never
 * true: a console line is not a hand-off, so the entry stays queued (and keeps
 * being re-driven, still through the gate) until an alert can go out.
 */
async function alertGaveUp(env: Env, e: CeloRetryEntry): Promise<boolean> {
  const text = [
    '[MPP Router] 🚨 Celo payin NOT paid after 3 hours of retries: needs a human',
    `Invoice: ${e.provider} ${e.ref}, Rozo payment ${(e.rozoPaymentId ?? '?').slice(0, 8)}`,
    `First deferred: ${e.firstAt}, attempts: ${e.attempts + 1}`,
    `Last reason: ${e.lastReason ?? 'unknown'}`,
    'Nothing was paid. Check the payin on Celo (finalized? same block hash on two RPCs? Transfer matches the order?). Pay by hand only after it is verified, or refund the payer.',
  ].join('\n')
  try {
    if (!alertSinkConfigured(env)) {
      console.error(`[celo-retry] give-up alert NOT SENT (no alert channel), entry kept for ${e.ref}: ${text}`)
      return false
    }
    return await sendAlert(env, redactForAlert(text))
  } catch (err) {
    console.warn(`[celo-retry] give-up alert error: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
