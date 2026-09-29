/**
 * Feishu (Lark) alert transport for the Worker, via the ROZO app bot.
 *
 * The founder reads alerts in Feishu, not DingTalk (2026-09-29). This sends a
 * text message to one group chat using the app's tenant_access_token, the same
 * bot and chat the ainative `notify_feishu.py` script uses.
 *
 * Returns whether Feishu confirmed the message (code 0), so monitors that
 * persist "already alerted" state can commit only after a real delivery.
 */

import type { RedactedAlert } from './alert-redaction'

const FEISHU_API = 'https://open.feishu.cn/open-apis'
const TIMEOUT_MS = 10_000

export interface FeishuConfig {
  appId?: string
  appSecret?: string
  chatId?: string
}

export function feishuConfigured(cfg: FeishuConfig): boolean {
  return Boolean(cfg.appId && cfg.appSecret && cfg.chatId)
}

export async function sendFeishuAlertConfirmed(cfg: FeishuConfig, content: RedactedAlert): Promise<boolean> {
  if (!feishuConfigured(cfg)) return false
  try {
    const tokenRes = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const tokenBody = (await tokenRes.json().catch(() => null)) as { code?: number; tenant_access_token?: string } | null
    if (!tokenRes.ok || tokenBody?.code !== 0 || !tokenBody.tenant_access_token) {
      console.warn(`[feishu] token request failed: HTTP ${tokenRes.status} code=${tokenBody?.code ?? 'unknown'}`)
      return false
    }

    const res = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBody.tenant_access_token}`,
      },
      body: JSON.stringify({
        receive_id: cfg.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
    if (!res.ok || body?.code !== 0) {
      console.warn(`[feishu] send failed: HTTP ${res.status} code=${body?.code ?? 'unknown'} ${body?.msg ?? ''}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`[feishu] error: ${(err as Error).message}`)
    return false
  }
}
