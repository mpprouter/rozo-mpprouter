/**
 * DingTalk Notification Utility for Cloudflare Workers.
 *
 * Adapted from rozo-intents-api/supabase/functions/shared/dingtalk.ts
 * for the Workers environment (no Deno.env — env is passed explicitly).
 *
 * All sends are fire-and-forget: errors are logged but never thrown,
 * so alert failures can't break the request path.
 */

const DINGTALK_WEBHOOK_URL = 'https://oapi.dingtalk.com/robot/send'

interface DingTalkTextMessage {
  msgtype: 'text'
  text: { content: string }
}

export async function sendDingTalkAlert(
  accessToken: string,
  content: string,
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
