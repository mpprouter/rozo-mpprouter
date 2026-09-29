import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendAlert, logAlert, severityOf, idempotencyKey, alertChannelConfigured } from './alert'
import { redactForAlert } from './alert-redaction'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const LOG = { ALERT_LOG_SUPABASE_URL: 'https://x.supabase.co', ALERT_LOG_SUPABASE_ANON_KEY: 'anon', ALERTS_LOG_RPC_SECRET: 'sec' }
const FEISHU = { FEISHU_APP_ID: 'cli', FEISHU_APP_SECRET: 's', FEISHU_ALERT_CHAT_ID: 'oc' }

afterEach(() => vi.unstubAllGlobals())

describe('severity and idempotency', () => {
  it('classifies like rozo-intents-api', () => {
    expect(severityOf('[MPP Router] 🚨 breaker open')).toBe('error')
    expect(severityOf('[MPP Router] ⚠️ Tempo pool low balance')).toBe('warning')
    expect(severityOf('[MPP Router] ✅ monitor online')).toBe('info')
  })
  it('is stable within a minute', async () => {
    const a = await idempotencyKey('t', 'b', new Date('2026-09-29T01:00:05Z'))
    const b = await idempotencyKey('t', 'b', new Date('2026-09-29T01:00:55Z'))
    expect(a).toBe(b)
    expect(a.startsWith('mpprouter|2026-09-29T01:00|')).toBe(true)
  })
})

describe('sendAlert', () => {
  it('logs first, then sends to Feishu, never DingTalk', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ inserted: true }))
      .mockResolvedValueOnce(json({ code: 0, tenant_access_token: 't' }))
      .mockResolvedValueOnce(json({ code: 0 }))
    vi.stubGlobal('fetch', f)
    const ok = await sendAlert({ ...LOG, ...FEISHU, DINGTALK_ACCESS_TOKEN: 'd' }, redactForAlert('[MPP Router] ⚠️ low\nline two'))
    expect(ok).toBe(true)
    expect(f.mock.calls[0][0]).toBe('https://x.supabase.co/rest/v1/rpc/alerts_log_insert')
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body).toMatchObject({ p_secret: 'sec', p_service: 'mpprouter', p_severity: 'warning', p_title: '[MPP Router] ⚠️ low', p_body: 'line two' })
    expect(f.mock.calls.map((c) => String(c[0])).some((u) => u.includes('dingtalk'))).toBe(false)
  })

  it('still delivers when the log write fails', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('supabase down'))
      .mockResolvedValueOnce(json({ code: 0, tenant_access_token: 't' }))
      .mockResolvedValueOnce(json({ code: 0 }))
    vi.stubGlobal('fetch', f)
    expect(await sendAlert({ ...LOG, ...FEISHU }, redactForAlert('x'))).toBe(true)
  })

  it('falls back to DingTalk only without Feishu secrets', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ errcode: 0 }))
    vi.stubGlobal('fetch', f)
    expect(await sendAlert({ DINGTALK_ACCESS_TOKEN: 'd' }, redactForAlert('x'))).toBe(true)
    expect(String(f.mock.calls[0][0])).toContain('oapi.dingtalk.com')
  })

  it('reports no channel', () => {
    expect(alertChannelConfigured({})).toBe(false)
    expect(alertChannelConfigured(FEISHU)).toBe(true)
  })
})

describe('logAlert', () => {
  it('skips without config and on non-2xx', async () => {
    expect(await logAlert({}, redactForAlert('x'))).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ message: 'bad secret' }, 401)))
    expect(await logAlert(LOG, redactForAlert('x'))).toBe(false)
  })
})
