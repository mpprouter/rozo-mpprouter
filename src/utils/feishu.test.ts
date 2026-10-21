import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendFeishuAlertConfirmed, feishuConfigured, larkFounderConfig, LARK_API } from './feishu'
import { redactForAlert } from './alert-redaction'

const cfg = { appId: 'cli_x', appSecret: 's', chatId: 'oc_x' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

afterEach(() => vi.unstubAllGlobals())

describe('sendFeishuAlertConfirmed', () => {
  it('needs all three settings', () => {
    expect(feishuConfigured({ ...cfg, chatId: undefined })).toBe(false)
    expect(feishuConfigured(cfg)).toBe(true)
  })

  it('returns true only when Feishu answers code 0', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, tenant_access_token: 't' }))
      .mockResolvedValueOnce(json({ code: 0 }))
    vi.stubGlobal('fetch', f)
    expect(await sendFeishuAlertConfirmed(cfg, redactForAlert('hi'))).toBe(true)
    const [, init] = f.mock.calls[1]
    expect(JSON.parse(init.body).receive_id).toBe('oc_x')
    expect(JSON.parse(JSON.parse(init.body).content).text).toBe('hi')
  })

  it('treats a token failure or a non-zero send code as not delivered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ code: 10003 })))
    expect(await sendFeishuAlertConfirmed(cfg, redactForAlert('hi'))).toBe(false)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ code: 0, tenant_access_token: 't' }))
      .mockResolvedValueOnce(json({ code: 230002, msg: 'bot not in chat' })))
    expect(await sendFeishuAlertConfirmed(cfg, redactForAlert('hi'))).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network')))
    expect(await sendFeishuAlertConfirmed(cfg, redactForAlert('hi'))).toBe(false)
  })

  it('defaults to open.feishu.cn and uses the Lark host when apiBase is set', async () => {
    const f = vi.fn(async (..._args: any[]) => json({ code: 0, tenant_access_token: 't' }))
    vi.stubGlobal('fetch', f)
    await sendFeishuAlertConfirmed(cfg, redactForAlert('hi'))
    expect(String(f.mock.calls[0][0])).toMatch(/^https:\/\/open\.feishu\.cn\//)
    expect(String(f.mock.calls[1][0])).toMatch(/^https:\/\/open\.feishu\.cn\//)
    f.mockClear()
    const lark = larkFounderConfig({ LARK_APP_ID: 'cli_l', LARK_APP_SECRET: 's', LARK_FOUNDER_CHAT_ID: 'oc_f' })
    expect(await sendFeishuAlertConfirmed(lark, redactForAlert('hi'))).toBe(true)
    expect(String(f.mock.calls[0][0])).toBe(`${LARK_API}/auth/v3/tenant_access_token/internal`)
    expect(String(f.mock.calls[1][0])).toBe(`${LARK_API}/im/v1/messages?receive_id_type=chat_id`)
    expect(JSON.parse((f.mock.calls[1] as any[])[1].body).receive_id).toBe('oc_f')
  })
})
