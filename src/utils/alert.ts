/**
 * One alert exit for the router: log the alert, then deliver it.
 *
 * 2026-09-29, founder: alerts go to Feishu (where they are read), not
 * DingTalk, and every alert must also be saved. So each alert is
 *   1. written to `ainative_cloud_alerts_log` (Rozo Intents Supabase) through
 *      the restricted `alerts_log_insert` RPC, the same sink rozo-intents-api,
 *      withdraw-loop and withdraw-v3 already use, BEFORE delivery, so an alert
 *      that fails to send is still on record; and
 *   2. sent to the Lark international "Rozo Alerts" bot (2026-10-24: the
 *      Feishu CN app is retired). Chat by audience: alerts that need the
 *      founder to act (top up the funder wallet, gas sponsor) go to Rozo
 *      Founder, everything else to Rozo Ops. Legacy Feishu is used only when
 *      the Lark secrets are unset, then DingTalk, so a config gap means
 *      "wrong channel", not silence.
 *
 * Never throws. Logging is bounded by a short deadline and cannot block or
 * fail the delivery.
 */

import type { RedactedAlert } from './alert-redaction'
import { sendDingTalkAlertConfirmed } from './dingtalk'
import { feishuConfigured, LARK_API, sendFeishuAlertConfirmed, type FeishuConfig } from './feishu'

export interface AlertEnv {
  DINGTALK_ACCESS_TOKEN?: string
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
  FEISHU_ALERT_CHAT_ID?: string
  LARK_APP_ID?: string
  LARK_APP_SECRET?: string
  LARK_OPS_CHAT_ID?: string
  LARK_FOUNDER_CHAT_ID?: string
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

/**
 * True when an alert would go anywhere: a delivery channel or the archive.
 * Call sites guard on this (not on a channel alone) so a Feishu/DingTalk
 * config outage still leaves the alert in ainative_cloud_alerts_log.
 */
export function alertSinkConfigured(env: AlertEnv): boolean {
  // Lark counts only with the Ops chat: Ops is the default audience, so a
  // Founder-only Lark config would pass the guard yet drop most alerts.
  return feishuConfigured(larkOf(env, 'ops'))
    || feishuConfigured(feishuOf(env))
    || Boolean(env.DINGTALK_ACCESS_TOKEN)
    || Boolean(env.ALERT_LOG_SUPABASE_URL && env.ALERT_LOG_SUPABASE_ANON_KEY && env.ALERTS_LOG_RPC_SECRET)
}

function feishuOf(env: AlertEnv): FeishuConfig {
  return { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, chatId: env.FEISHU_ALERT_CHAT_ID }
}

export type AlertAudience = 'ops' | 'founder'

function larkOf(env: AlertEnv, audience: AlertAudience): FeishuConfig {
  return {
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    // A founder alert with no Founder chat set goes to Ops rather than nowhere.
    chatId: audience === 'founder' ? (env.LARK_FOUNDER_CHAT_ID || env.LARK_OPS_CHAT_ID) : env.LARK_OPS_CHAT_ID,
    apiBase: LARK_API,
  }
}

/**
 * First-line markers of alerts that ask the founder to act (moving money is
 * founder-only, L3). Everything else is an ops alert. Founder rule 2026-10-24:
 * "不重要的就是 ops，重要的就是 founder".
 */
const FOUNDER_FIRST_LINE: readonly RegExp[] = [
  // funder-balance-watch: entering a low band, or a sharp drop below $200.
  // "improved" and "unreadable" are informational and stay in ops.
  /Funder balance (?!improved\b|unreadable\b)/i,
  // coupon.ts: redemption blocked until the funder wallet is topped up.
  /insufficient funder balance/i,
  // x402payer/reconcile.ts: funder holds less than the x402 ledger liability.
  /funder short by/i,
  // stellar-gas-balance: the sponsor needs an XLM top-up.
  /Stellar gas sponsor low balance/i,
]

export function alertAudience(content: string): AlertAudience {
  const first = content.split('\n', 1)[0] ?? ''
  return FOUNDER_FIRST_LINE.some((re) => re.test(first)) ? 'founder' : 'ops'
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
 * Archive and deliver. Returns true only if a channel confirmed delivery, so
 * monitors that persist "already alerted" state can commit on it.
 */
export async function sendAlert(env: AlertEnv, content: RedactedAlert): Promise<boolean> {
  // Archive and delivery run concurrently: a slow Supabase must never delay
  // the operational alert (codex review). logAlert never rejects.
  const [, delivered] = await Promise.all([logAlert(env, content), deliver(env, content)])
  return delivered
}

async function deliver(env: AlertEnv, content: RedactedAlert): Promise<boolean> {
  // Each configured channel is tried in order until one confirms, so a Lark
  // outage (or an unset chat) still reaches a fallback when one exists.
  const audience = alertAudience(String(content))
  let tried = false
  const lark = larkOf(env, audience)
  if (feishuConfigured(lark)) {
    tried = true
    if (await sendFeishuAlertConfirmed(lark, content)) return true
    console.warn(`[alert] Lark ${audience} delivery failed, trying fallbacks`)
  }
  const feishu = feishuOf(env)
  if (feishuConfigured(feishu)) {
    tried = true
    if (await sendFeishuAlertConfirmed(feishu, content)) return true
  }
  if (env.DINGTALK_ACCESS_TOKEN) {
    tried = true
    if (await sendDingTalkAlertConfirmed(env.DINGTALK_ACCESS_TOKEN, content)) return true
  }
  if (!tried) console.warn('[alert] no delivery channel configured, alert archived only')
  return false
}
