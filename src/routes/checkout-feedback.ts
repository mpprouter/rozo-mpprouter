// Checkout post-payment feedback (ainative todos/20261003-checkout-post-success-feedback.zh.md).
//
// After the merchant's invoice is settled, checkout.rozo.ai asks one optional
// open question ("Besides OpenRouter, what else would you like to buy with
// your existing wallet?"). This module is its server side:
//
//   1. Submission credential. create-invoice responses carry `feedbackToken`,
//      an HMAC of the Rozo payment id under CHECKOUT_FEEDBACK_TOKEN_SECRET.
//      Only whoever created (or re-created) the order with the merchant
//      invoice link receives it; a bare payment id is not enough to submit.
//   2. POST /v1/services/rozo-agent-api/checkout-feedback validates token,
//      text and live merchant settlement, then writes ONE row to D1. The row
//      is both the durable feedback record and its pending notification job,
//      so saving and queueing are a single atomic write. One row per order:
//      repeats return the existing feedback_id and never queue a second job.
//   3. The cron drains pending rows to Feishu, claiming each row first and
//      passing feedback_id as Feishu's dedup uuid. Failures stay queued with
//      backoff. Quiet hours (23:00-06:00 Asia/Singapore, ceo-alert-policy)
//      hold delivery; the feedback itself is already saved.
//
// Never logs or returns the free text beyond the caller's own echo; never
// sends it to analytics.

import type { Env } from '../index'
import { resolveMerchantSettlement, type MerchantSettlement } from './webhook'
import { redactForAlert } from '../utils/alert-redaction'
import { feishuConfigured, sendFeishuAlertConfirmed } from '../utils/feishu'

export const FEEDBACK_PATH = '/v1/services/rozo-agent-api/checkout-feedback'
export const FEEDBACK_MAX_CHARS = 1000
const MAX_BODY_BYTES = 16 * 1024
const ALLOWED_LOCALES = new Set(['en', 'zh', 'es', 'pt', 'ru', 'ja', 'ko', 'fr', 'de', 'hi', 'id'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const NOTIFY_MAX_ATTEMPTS = 8
const NOTIFY_BATCH = 10
// A `sending` claim older than this is treated as a crashed attempt.
const NOTIFY_CLAIM_STALE_MS = 5 * 60 * 1000

type FeedbackEnv = Pick<
  Env,
  'COUPON_SECURITY_DB' | 'CHECKOUT_FEEDBACK_TOKEN_SECRET' | 'FEISHU_APP_ID' | 'FEISHU_APP_SECRET' | 'FEISHU_ALERT_CHAT_ID'
>

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// ── submission token ─────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function feedbackTokenFor(secret: string | undefined, rozoPaymentId: string): Promise<string | null> {
  if (!secret || !rozoPaymentId) return null
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`checkout-feedback:v1:${rozoPaymentId}`))
  return b64url(new Uint8Array(sig))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Adds `feedbackToken` to a successful create-invoice JSON response that names
 * a rozoPaymentId. Any other response (errors, non-JSON, no secret configured)
 * passes through untouched, so this can never break invoice creation.
 */
export async function withFeedbackToken(response: Response, env: FeedbackEnv): Promise<Response> {
  try {
    if (response.status !== 200 || !env.CHECKOUT_FEEDBACK_TOKEN_SECRET) return response
    if (!(response.headers.get('Content-Type') || '').includes('application/json')) return response
    const body = (await response.clone().json()) as Record<string, unknown> | null
    const rpid = body && typeof body.rozoPaymentId === 'string' ? body.rozoPaymentId : null
    if (!rpid) return response
    const token = await feedbackTokenFor(env.CHECKOUT_FEEDBACK_TOKEN_SECRET, rpid)
    if (!token) return response
    return new Response(JSON.stringify({ ...body, feedbackToken: token }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch {
    return response
  }
}

// ── text validation ──────────────────────────────────────────────────────────

export type TextVerdict = { ok: true; text: string } | { ok: false; code: 'EMPTY' | 'TOO_LONG' | 'INVALID_TEXT' | 'SENSITIVE_INPUT' }

// Things a buyer must not paste into a wish list: they would end up in a
// founder notification and an internal table. Rejected (not silently masked)
// so the buyer can edit and resend.
const SENSITIVE_PATTERNS: RegExp[] = [
  /payments\.coinbase\.com|commerce\.coinbase\.com|crypto\.stripe\.com|checkout\.stripe\.com|\b(pl|paymentSession)_[A-Za-z0-9]{6,}/i, // payment links
  /\b0x[0-9a-fA-F]{40}\b/, // EVM address
  /\b(?:0x)?[0-9a-fA-F]{64}\b/, // hex private key / tx hash
  /\b[GCMS][A-Z2-7]{55}\b/, // Stellar address or secret seed
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/, // Solana / base58 address
  /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/, // Tron address
  /\b(bc1|lnbc|lntb)[0-9a-z]{20,}/i, // BTC address / Lightning invoice
  /\b(seed|mnemonic|recovery)[\s_-]*(phrase|words?)\b|private[\s_-]*key|助记词|私钥/i,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email
  /(?:\+?\d[\s-]?){9,}/, // phone-like digit run
  /\bcoupon\b|兑换码|优惠码/i,
]

export function validateFeedbackText(raw: unknown): TextVerdict {
  if (typeof raw !== 'string') return { ok: false, code: 'EMPTY' }
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (!text) return { ok: false, code: 'EMPTY' }
  if ([...text].length > FEEDBACK_MAX_CHARS) return { ok: false, code: 'TOO_LONG' }
  // Control characters (other than newline/tab) and markup-looking input.
  if (/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/.test(text)) return { ok: false, code: 'INVALID_TEXT' }
  if (/<\s*[A-Za-z/!?]/.test(text)) return { ok: false, code: 'INVALID_TEXT' }
  for (const re of SENSITIVE_PATTERNS) if (re.test(text)) return { ok: false, code: 'SENSITIVE_INPUT' }
  return { ok: true, text }
}

// ── notification content ─────────────────────────────────────────────────────

/** Neutralise anything Feishu text messages would interpret: <at> tags and @all. */
export function neutraliseForFeishu(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›').replace(/@/g, '＠')
}

export interface FeedbackRow {
  feedback_id: string
  payment_id: string
  merchant: string | null
  text: string
  locale: string | null
  created_at: number
  settlement_status: string
  settlement_checked_at: number
  notification_status: string
  notification_attempts: number
}

export function buildFeedbackNotification(row: FeedbackRow) {
  const lines = [
    '[Checkout 用户反馈] 用户付款成功后的开放反馈（不是告警，无需拍板）',
    `反馈 ID: ${row.feedback_id}`,
    `时间: ${new Date(row.created_at).toISOString()}`,
    `商家: ${neutraliseForFeishu(row.merchant || 'unknown')}`,
    `内部订单 (Rozo payment id): ${row.payment_id}`,
    `语言: ${row.locale || 'unknown'}`,
    `结算核验: ${row.settlement_status} @ ${new Date(row.settlement_checked_at).toISOString()}`,
    '原文:',
    neutraliseForFeishu(row.text),
  ]
  return redactForAlert(lines.join('\n'))
}

// ── quiet hours (ceo-alert-policy: 23:00-06:00 Asia/Singapore) ───────────────

export function inQuietHours(nowMs: number): boolean {
  const sgtHour = new Date(nowMs + 8 * 3600 * 1000).getUTCHours()
  return sgtHour >= 23 || sgtHour < 6
}

// ── persistence ──────────────────────────────────────────────────────────────

const SELECT_COLS =
  'feedback_id, payment_id, merchant, text, locale, created_at, settlement_status, settlement_checked_at, notification_status, notification_attempts'

async function findByPayment(db: D1Database, paymentId: string): Promise<FeedbackRow | null> {
  return (await db.prepare(`SELECT ${SELECT_COLS} FROM checkout_feedback WHERE payment_id = ?`).bind(paymentId).first()) as FeedbackRow | null
}

function newFeedbackId(): string {
  const b = new Uint8Array(12)
  crypto.getRandomValues(b)
  return 'fb_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

// ── submit handler ───────────────────────────────────────────────────────────

/** Reads at most `maxBytes` of the body; null (and the stream cancelled) past it. */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') || '0')
  if (declared > maxBytes) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(buf)
}

export interface FeedbackDeps {
  now?: () => number
  resolveSettlement?: (env: Env, rozoId: string) => Promise<MerchantSettlement>
  send?: typeof sendFeishuAlertConfirmed
}

export async function handleCheckoutFeedback(
  request: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
  deps: FeedbackDeps = {},
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
  const db = env.COUPON_SECURITY_DB
  if (!db || !env.CHECKOUT_FEEDBACK_TOKEN_SECRET) return json(503, { ok: false, error: 'FEEDBACK_UNAVAILABLE' })
  const now = deps.now ?? Date.now

  let body: any
  try {
    const raw = await readBodyCapped(request, MAX_BODY_BYTES)
    if (raw === null) return json(413, { ok: false, error: 'TOO_LARGE' })
    body = JSON.parse(raw)
  } catch {
    return json(400, { ok: false, error: 'INVALID_JSON' })
  }
  const paymentId = typeof body?.rozo_payment_id === 'string' ? body.rozo_payment_id.trim().toLowerCase() : ''
  const token = typeof body?.feedback_token === 'string' ? body.feedback_token : ''
  if (!UUID_RE.test(paymentId) || !token) return json(400, { ok: false, error: 'INVALID_REQUEST' })
  const expected = await feedbackTokenFor(env.CHECKOUT_FEEDBACK_TOKEN_SECRET, paymentId)
  if (!expected || !timingSafeEqual(expected, token)) return json(403, { ok: false, error: 'INVALID_TOKEN' })

  // Idempotent: a repeat (double click, reload, timeout retry) gets the saved
  // result and never a second notification job, whatever text it carries.
  const existing = await findByPayment(db, paymentId)
  if (existing) return json(200, { ok: true, feedback_id: existing.feedback_id, duplicate: true })

  const verdict = validateFeedbackText(body?.text)
  if (!verdict.ok) return json(422, { ok: false, error: verdict.code, max_chars: FEEDBACK_MAX_CHARS })
  const locale = typeof body?.locale === 'string' && ALLOWED_LOCALES.has(body.locale) ? body.locale : null

  let settlement: MerchantSettlement
  try {
    settlement = await (deps.resolveSettlement ?? resolveMerchantSettlement)(env, paymentId)
  } catch {
    return json(502, { ok: false, error: 'SETTLEMENT_CHECK_FAILED' })
  }
  if (!settlement.found) return json(404, { ok: false, error: 'PAYMENT_NOT_FOUND' })
  if (!settlement.settled) return json(409, { ok: false, error: 'NOT_SETTLED' })

  const ts = now()
  const feedbackId = newFeedbackId()
  await db
    .prepare(
      `INSERT INTO checkout_feedback (feedback_id, payment_id, merchant, text, locale, created_at,
         settlement_status, settlement_checked_at, notification_status, notification_attempts, notification_next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0)
       ON CONFLICT(payment_id) DO NOTHING`,
    )
    .bind(feedbackId, paymentId, settlement.merchant, verdict.text, locale, ts, settlement.status, ts)
    .run()
  // Read back: a concurrent submit may have won the UNIQUE(payment_id) race.
  const saved = await findByPayment(db, paymentId)
  if (!saved) return json(500, { ok: false, error: 'SAVE_FAILED' })
  const duplicate = saved.feedback_id !== feedbackId

  if (!duplicate && ctx) {
    ctx.waitUntil(drainCheckoutFeedbackNotifications(env, { now, send: deps.send, onlyFeedbackId: saved.feedback_id }))
  }
  return json(200, { ok: true, feedback_id: saved.feedback_id, duplicate })
}

// ── notification drain (cron + best-effort immediate attempt) ────────────────

export function notifyBackoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 * 60 * 1000 * 2 ** Math.max(0, attempts - 1))
}

export async function drainCheckoutFeedbackNotifications(
  env: FeedbackEnv,
  opts: { now?: () => number; send?: typeof sendFeishuAlertConfirmed; onlyFeedbackId?: string } = {},
): Promise<{ sent: number; failed: number; skipped: string | null }> {
  const out = { sent: 0, failed: 0, skipped: null as string | null }
  try {
    const db = env.COUPON_SECURITY_DB
    if (!db) return { ...out, skipped: 'no_db' }
    const now = opts.now ?? Date.now
    const cfg = { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, chatId: env.FEISHU_ALERT_CHAT_ID }
    if (!feishuConfigured(cfg)) return { ...out, skipped: 'feishu_unconfigured' }
    if (inQuietHours(now())) return { ...out, skipped: 'quiet_hours' }
    const send = opts.send ?? sendFeishuAlertConfirmed

    const t0 = now()
    const due = await db
      .prepare(
        `SELECT feedback_id FROM checkout_feedback
          WHERE notification_attempts < ?
            AND ((notification_status IN ('pending', 'failed') AND notification_next_attempt_at <= ?)
              OR (notification_status = 'sending' AND notification_claimed_at < ?))
            ${opts.onlyFeedbackId ? 'AND feedback_id = ?' : ''}
          ORDER BY created_at LIMIT ?`,
      )
      .bind(
        ...[NOTIFY_MAX_ATTEMPTS, t0, t0 - NOTIFY_CLAIM_STALE_MS],
        ...(opts.onlyFeedbackId ? [opts.onlyFeedbackId] : []),
        NOTIFY_BATCH,
      )
      .all<{ feedback_id: string }>()

    for (const { feedback_id } of due.results ?? []) {
      const claimAt = now()
      // Claim: only one worker (cron run or immediate attempt) may send a row.
      const claim = await db
        .prepare(
          `UPDATE checkout_feedback
              SET notification_status = 'sending', notification_claimed_at = ?, notification_attempts = notification_attempts + 1
            WHERE feedback_id = ? AND notification_attempts < ?
              AND ((notification_status IN ('pending', 'failed') AND notification_next_attempt_at <= ?)
                OR (notification_status = 'sending' AND notification_claimed_at < ?))`,
        )
        .bind(claimAt, feedback_id, NOTIFY_MAX_ATTEMPTS, claimAt, claimAt - NOTIFY_CLAIM_STALE_MS)
        .run()
      if (!claim.meta || claim.meta.changes !== 1) continue
      const row = (await db.prepare(`SELECT ${SELECT_COLS} FROM checkout_feedback WHERE feedback_id = ?`).bind(feedback_id).first()) as FeedbackRow | null
      if (!row) continue

      let ok = false
      try {
        ok = await send(cfg, buildFeedbackNotification(row), { uuid: row.feedback_id })
      } catch {
        ok = false
      }
      const doneAt = now()
      if (ok) {
        await db
          .prepare(`UPDATE checkout_feedback SET notification_status = 'sent', notified_at = ?, notification_last_error = NULL WHERE feedback_id = ?`)
          .bind(doneAt, feedback_id)
          .run()
        out.sent++
      } else {
        const exhausted = row.notification_attempts >= NOTIFY_MAX_ATTEMPTS
        await db
          .prepare(
            `UPDATE checkout_feedback SET notification_status = ?, notification_next_attempt_at = ?, notification_last_error = ? WHERE feedback_id = ?`,
          )
          .bind(exhausted ? 'abandoned' : 'failed', doneAt + notifyBackoffMs(row.notification_attempts), 'feishu_send_failed', feedback_id)
          .run()
        out.failed++
      }
    }
  } catch (err) {
    console.warn(`[checkout-feedback] drain error: ${(err as Error).message}`)
  }
  return out
}
