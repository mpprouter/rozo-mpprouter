/**
 * One alert exit for the router: log the alert, then deliver it.
 *
 * 2026-09-29, founder: alerts go to Feishu (where they are read), not
 * DingTalk, and every alert must also be saved. So each alert is
 *   1. written to `ainative_cloud_alerts_log` (Rozo Intents Supabase) through
 *      the restricted `alerts_log_insert` RPC, the same sink rozo-intents-api,
 *      withdraw-loop and withdraw-v3 already use, BEFORE delivery, so an alert
 *      that fails to send is still on record; and
 *   2. sent to Feishu via the app bot. DingTalk is used only when the Feishu
 *      secrets are unset, so a config gap means "wrong channel", not silence.
 *
 * Never throws. Logging is bounded by a short deadline and cannot block or
 * fail the delivery.
 */

import type { RedactedAlert } from './alert-redaction'
import { sendDingTalkAlertConfirmed } from './dingtalk'
import { feishuConfigured, sendFeishuAlertConfirmed } from './feishu'

export interface AlertEnv {
  DINGTALK_ACCESS_TOKEN?: string
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
  FEISHU_ALERT_CHAT_ID?: string
  /** Rozo Intents Supabase project URL, e.g. https://<ref>.supabase.co */
  ALERT_LOG_SUPABASE_URL?: string
  /** That project's anon key (the RPC is callable by anon, gated by the secret). */
  ALERT_LOG_SUPABASE_ANON_KEY?: string
  /** Vault secret `ainative_alerts_log_rpc_secret`, checked inside the RPC. */
  ALERTS_LOG_RPC_SECRET?: string
}

export const ALERT_SERVICE = 'mpprouter'
export const ALERT_LOG_TIMEOUT_MS = 3_000

export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical'

// Same markers as rozo-intents-api shared/alert-log.ts, so the severity column
// means the same thing whichever service wrote the row.
const ERROR_MARKERS = /🚨|\berror\b|\bfailed\b|\bstuck\b|\bmismatch\b|\bcritical\b/i
const WARNING_MARKERS = /⚠️|\bheld\b|\bskipped\b|\babandoned\b|\buncertain\b|\blow\b/i

export function severityOf(content: string): AlertSeverity {
  const head = content.split('\n').slice(0, 10).join('\n')
  if (ERROR_MARKERS.test(head)) return 'error'
  if (WARNING_MARKERS.test(head)) return 'warning'
  return 'info'
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Minute-bucketed so a retry of the same alert is one row, as upstream. */
export async function idempotencyKey(title: string, body: string, now: Date): Promise<string> {
  return `${ALERT_SERVICE}|${now.toISOString().slice(0, 16)}|${(await sha256Hex(`${title}\n${body}`)).slice(0, 16)}`
}

export function alertChannelConfigured(env: AlertEnv): boolean {
  return feishuConfigured(feishuOf(env)) || Boolean(env.DINGTALK_ACCESS_TOKEN)
}

function feishuOf(env: AlertEnv) {
  return { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, chatId: env.FEISHU_ALERT_CHAT_ID }
}

/** Write the alert to ainative_cloud_alerts_log. Never throws; false if not saved. */
export async function logAlert(env: AlertEnv, content: RedactedAlert, now = new Date()): Promise<boolean> {
  const url = env.ALERT_LOG_SUPABASE_URL
  const anon = env.ALERT_LOG_SUPABASE_ANON_KEY
  const secret = env.ALERTS_LOG_RPC_SECRET
  if (!url || !anon || !secret) {
    console.warn('[alert-log] ALERT_LOG_SUPABASE_URL / ALERT_LOG_SUPABASE_ANON_KEY / ALERTS_LOG_RPC_SECRET unset, alert not saved')
    return false
  }
  const text = String(content)
  const [title, ...rest] = text.split('\n')
  const body = rest.join('\n')
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/alerts_log_insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({
        p_secret: secret,
        p_service: ALERT_SERVICE,
        p_severity: severityOf(text),
        p_title: title,
        p_body: body,
        p_idempotency_key: await idempotencyKey(title, body, now),
      }),
      signal: AbortSignal.timeout(ALERT_LOG_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[alert-log] insert failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`[alert-log] insert error (non-fatal): ${(err as Error).message}`)
    return false
  }
}

/**
 * Log, then deliver. Returns true only if a channel confirmed delivery, so
 * monitors that persist "already alerted" state can commit on it.
 */
export async function sendAlert(env: AlertEnv, content: RedactedAlert): Promise<boolean> {
  await logAlert(env, content)
  const feishu = feishuOf(env)
  if (feishuConfigured(feishu)) return sendFeishuAlertConfirmed(feishu, content)
  if (env.DINGTALK_ACCESS_TOKEN) {
    console.warn('[alert] Feishu secrets unset, falling back to DingTalk')
    return sendDingTalkAlertConfirmed(env.DINGTALK_ACCESS_TOKEN, content)
  }
  console.warn('[alert] no alert channel configured, alert logged only')
  return false
}
