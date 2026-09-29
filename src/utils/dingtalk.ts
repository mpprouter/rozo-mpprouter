/**
 * DingTalk Notification Utility for Cloudflare Workers.
 *
 * Adapted from rozo-intents-api/supabase/functions/shared/dingtalk.ts
 * for the Workers environment (no Deno.env — env is passed explicitly).
 *
 * All sends are fire-and-forget: errors are logged but never thrown,
 * so alert failures can't break the request path.
 */

import type { RedactedAlert } from './alert-redaction'

const DINGTALK_WEBHOOK_URL = 'https://oapi.dingtalk.com/robot/send'

interface DingTalkTextMessage {
  msgtype: 'text'
  text: { content: string }
}

/**
 * `content` is a `RedactedAlert`, not a `string`. Only `redactForAlert` can
 * produce that type, so there is no call site — present or future — that can
 * reach this transport with unredacted text. See `utils/alert-redaction.ts`
 * (threat `Info.1`).
 */
export async function sendDingTalkAlert(
  accessToken: string,
  content: RedactedAlert,
): Promise<void> {
  try {
    const url = `${DINGTALK_WEBHOOK_URL}?access_token=${accessToken}`
    const message: DingTalkTextMessage = {
      msgtype: 'text',
      text: { content },
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    })
    if (!res.ok) {
      console.warn(`[dingtalk] send failed: ${res.status} ${res.statusText}`)
    }
  } catch (err: any) {
    console.warn(`[dingtalk] error: ${err.message}`)
  }
}

/**
 * Same transport, but reports whether DingTalk accepted the message instead
 * of swallowing the outcome. For monitors that persist "already alerted"
 * state: they must only commit after a confirmed send, or a failed delivery
 * is recorded as delivered and never retried.
 */
export async function sendDingTalkAlertConfirmed(
  accessToken: string,
  content: RedactedAlert,
): Promise<boolean> {
  try {
    const res = await fetch(`${DINGTALK_WEBHOOK_URL}?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } } satisfies DingTalkTextMessage),
    })
    if (!res.ok) {
      console.warn(`[dingtalk] send failed: ${res.status} ${res.statusText}`)
      return false
    }
    // DingTalk answers HTTP 200 with a non-zero errcode for rejected messages
    // (bad token, keyword filter, rate limit).
    const body = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null
    if (!body || body.errcode !== 0) {
      console.warn(`[dingtalk] rejected: errcode=${body?.errcode ?? 'unknown'} ${body?.errmsg ?? ''}`)
      return false
    }
    return true
  } catch (err: any) {
    console.warn(`[dingtalk] error: ${err.message}`)
    return false
  }
}
