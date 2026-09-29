import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendFeishuAlertConfirmed, feishuConfigured } from './feishu'
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
})
