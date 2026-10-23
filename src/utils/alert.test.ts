import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendAlert, logAlert, severityOf, idempotencyKey, alertSinkConfigured, alertAudience } from './alert'
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
  it('archives and sends to Feishu, never DingTalk', async () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('alerts_log_insert') ? json({ inserted: true })
        : url.includes('tenant_access_token') ? json({ code: 0, tenant_access_token: 't' })
          : json({ code: 0 }))
    vi.stubGlobal('fetch', f)
    const ok = await sendAlert({ ...LOG, ...FEISHU, DINGTALK_ACCESS_TOKEN: 'd' }, redactForAlert('[MPP Router] ⚠️ low\nline two'))
    expect(ok).toBe(true)
    const logCall = f.mock.calls.find((c) => String(c[0]) === 'https://x.supabase.co/rest/v1/rpc/alerts_log_insert')!
    const body = JSON.parse(logCall[1]!.body as string)
    expect(body).toMatchObject({ p_secret: 'sec', p_service: 'mpprouter', p_severity: 'warning', p_title: '[MPP Router] ⚠️ low', p_body: 'line two' })
    expect(f.mock.calls.map((c) => String(c[0])).some((u) => u.includes('dingtalk'))).toBe(false)
  })

  it('still delivers when the log write fails', async () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('alerts_log_insert')) throw new Error('supabase down')
      return url.includes('tenant_access_token') ? json({ code: 0, tenant_access_token: 't' }) : json({ code: 0 })
    })
    vi.stubGlobal('fetch', f)
    expect(await sendAlert({ ...LOG, ...FEISHU }, redactForAlert('x'))).toBe(true)
  })

  it('falls back to DingTalk only without Feishu secrets', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ errcode: 0 }))
    vi.stubGlobal('fetch', f)
    expect(await sendAlert({ DINGTALK_ACCESS_TOKEN: 'd' }, redactForAlert('x'))).toBe(true)
    expect(String(f.mock.calls[0][0])).toContain('oapi.dingtalk.com')
  })

  it('counts the archive alone as a sink', () => {
    expect(alertSinkConfigured({})).toBe(false)
    expect(alertSinkConfigured(FEISHU)).toBe(true)
    expect(alertSinkConfigured(LOG)).toBe(true)
  })

  it('does not wait for a slow archive before delivering', async () => {
    let feishuStartedBeforeLogDone = false
    let logDone = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('alerts_log_insert')) { await new Promise((r) => setTimeout(r, 50)); logDone = true; return json({}) }
      if (url.includes('tenant_access_token')) feishuStartedBeforeLogDone = !logDone
      return json({ code: 0, tenant_access_token: 't' })
    }))
    expect(await sendAlert({ ...LOG, ...FEISHU }, redactForAlert('x'))).toBe(true)
    expect(feishuStartedBeforeLogDone).toBe(true)
  })
})

describe('logAlert', () => {
  it('skips without config and on non-2xx', async () => {
    expect(await logAlert({}, redactForAlert('x'))).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ message: 'bad secret' }, 401)))
    expect(await logAlert(LOG, redactForAlert('x'))).toBe(false)
  })
})

describe('Lark routing (Feishu CN app retired 2026-10-24)', () => {
  const LARK = { LARK_APP_ID: 'lark_app', LARK_APP_SECRET: 'ls', LARK_OPS_CHAT_ID: 'oc_ops', LARK_FOUNDER_CHAT_ID: 'oc_founder' }
  const capture = () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('alerts_log_insert') ? json({ inserted: true })
        : url.includes('tenant_access_token') ? json({ code: 0, tenant_access_token: 't' })
          : json({ code: 0 }))
    vi.stubGlobal('fetch', f)
    return f
  }
  const sent = (f: ReturnType<typeof capture>) => {
    const call = f.mock.calls.find((c) => String(c[0]).includes('/im/v1/messages'))!
    return { url: String(call[0]), chat: JSON.parse(call[1]!.body as string).receive_id }
  }

  it('prefers Lark over Feishu and sends machine alerts to Ops', async () => {
    const f = capture()
    expect(await sendAlert({ ...LARK, ...FEISHU }, redactForAlert('[MPP Router] Stripe fulfillment failed: x'))).toBe(true)
    const s = sent(f)
    expect(s.url.startsWith('https://open.larksuite.com/open-apis/')).toBe(true)
    expect(s.chat).toBe('oc_ops')
    expect(f.mock.calls.some((c) => String(c[0]).includes('open.feishu.cn'))).toBe(false)
  })

  it('sends founder-action alerts to Founder', async () => {
    const f = capture()
    await sendAlert(LARK, redactForAlert('[MPP Router] ⚠️ Funder balance below $200: $150.00\nWallet: w'))
    expect(sent(f).chat).toBe('oc_founder')
  })

  it('classifies only explicit founder-action first lines as founder', () => {
    expect(alertAudience('[MPP Router] 🚨 Funder balance below $50: $10.00')).toBe('founder')
    expect(alertAudience('[MPP Router] ⚠️ Funder balance dropped sharply: $190 → $90')).toBe('founder')
    expect(alertAudience('[MPP Router] ⚠️ Stellar gas sponsor low balance: 3 XLM')).toBe('founder')
    expect(alertAudience('[MPP Router] Funder balance improved to below $200: $180')).toBe('ops')
    expect(alertAudience('[MPP Router] ❓ Funder balance unreadable for 3 consecutive checks')).toBe('ops')
    expect(alertAudience('[MPP Router] ✅ Stellar gas sponsor recovered: 50 XLM')).toBe('ops')
    expect(alertAudience('[MPP Router] ⚠️ Tempo pool low balance: 1 USDC')).toBe('ops')
    expect(alertAudience('x\nFunder balance below $50')).toBe('ops')
  })

  it('falls back to legacy Feishu when the Lark chat for that audience is unset', async () => {
    const f = capture()
    await sendAlert({ LARK_APP_ID: 'a', LARK_APP_SECRET: 'b', LARK_FOUNDER_CHAT_ID: 'oc_founder', ...FEISHU }, redactForAlert('[MPP Router] invoice failed'))
    expect(sent(f).url.startsWith('https://open.feishu.cn/')).toBe(true)
  })

  it('counts Lark alone as a sink', () => {
    expect(alertSinkConfigured(LARK)).toBe(true)
  })
})
