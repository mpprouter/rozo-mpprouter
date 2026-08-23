import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleProxySpy } = vi.hoisted(() => ({ handleProxySpy: vi.fn() }))
vi.mock('../src/routes/proxy', () => ({ handleProxy: handleProxySpy }))

import { classifyFacadeStatus, handleChatCompletions, handleModels } from '../src/routes/chat-completions'
import type { Env } from '../src/index'

function context(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext
}

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request('https://apiserver.mpprouter.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('OpenAI chat completions facade', () => {
  beforeEach(() => handleProxySpy.mockReset())

  it('lists only currently paid-verified models', async () => {
    const response = handleModels()
    const body = await response.json() as { data: Array<{ id: string }> }
    expect(body.data.map(model => model.id)).toEqual(['deepseek-v4-flash'])
  })

  it('rejects unknown models before the payment proxy', async () => {
    const response = await handleChatCompletions(
      request({ model: 'made-up-model', messages: [] }), {} as Env, context(),
    )
    expect(response.status).toBe(400)
    expect(handleProxySpy).not.toHaveBeenCalled()
  })

  it('rejects streaming before the payment proxy', async () => {
    const response = await handleChatCompletions(
      request({ model: 'deepseek-v4-flash', messages: [], stream: true }), {} as Env, context(),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'stream_not_supported' } })
    expect(handleProxySpy).not.toHaveBeenCalled()
  })

  it('rewrites the alias to the selected paid route without changing the body', async () => {
    handleProxySpy.mockResolvedValue(new Response('{}', { status: 402 }))
    const original = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }], tools: [] }
    const response = await handleChatCompletions(request(original), {} as Env, context())
    const proxied = handleProxySpy.mock.calls[0][0] as Request
    expect(new URL(proxied.url).pathname).toBe('/v1/services/deepseek/chat')
    expect(await proxied.json()).toEqual(original)
    expect(response.status).toBe(402)
    expect(response.headers.get('X-MPPRouter-Provider')).toBe('deepseek')
  })

  it('drops OpenAI Bearer placeholders but preserves payment headers', async () => {
    handleProxySpy.mockResolvedValue(new Response('{}', { status: 402 }))
    await handleChatCompletions(
      request(
        { model: 'deepseek-v4-flash', messages: [] },
        { Authorization: 'Bearer x402', 'Payment-Signature': 'signed-payload', 'X-Request-Id': 'req_auth' },
      ),
      {} as Env,
      context(),
    )
    const proxied = handleProxySpy.mock.calls[0][0] as Request
    expect(proxied.headers.has('Authorization')).toBe(false)
    expect(proxied.headers.get('Payment-Signature')).toBe('signed-payload')
    expect(proxied.headers.get('X-Request-Id')).toBe('req_auth')
  })

  it('does not route to an unavailable fallback after terminal failure', async () => {
    handleProxySpy.mockResolvedValueOnce(new Response('{"error":"upstream"}', { status: 502 }))
    const response = await handleChatCompletions(
      request({ model: 'deepseek-v4-flash', messages: [] }), {} as Env, context(),
    )
    expect(handleProxySpy).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(502)
    expect(response.headers.has('X-MPPRouter-Fallback-Reason')).toBe(false)
  })

  it('unwraps the merchant success envelope into an OpenAI response', async () => {
    handleProxySpy.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { id: 'chatcmpl_1', object: 'chat.completion', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const response = await handleChatCompletions(
      request({ model: 'deepseek-v4-flash', messages: [] }), {} as Env, context(),
    )
    expect(await response.json()).toMatchObject({ id: 'chatcmpl_1', object: 'chat.completion', usage: { prompt_tokens: 2 } })
  })

  it('records missing usage as null instead of zero', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const env = { COUPON_SECURITY_DB: { prepare } } as unknown as Env
    const ctx = context()
    handleProxySpy.mockResolvedValue(new Response('{"choices":[]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await handleChatCompletions(
      request({ model: 'deepseek-v4-flash', messages: [] }, { 'X-Request-Id': 'req_test' }),
      env,
      ctx,
    )
    const task = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0] as Promise<void>
    await task
    const values = bind.mock.calls[0]
    expect(values.slice(8, 11)).toEqual([null, null, null])
  })

  it('never uses the caller-controlled request id as the ledger primary key', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const env = { COUPON_SECURITY_DB: { prepare } } as unknown as Env
    const ctx1 = context()
    const ctx2 = context()
    handleProxySpy.mockImplementation(async () => new Response('{"choices":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await handleChatCompletions(request({ model: 'deepseek-v4-flash', messages: [] }, { 'X-Request-Id': 'reused' }), env, ctx1)
    await handleChatCompletions(request({ model: 'deepseek-v4-flash', messages: [] }, { 'X-Request-Id': 'reused' }), env, ctx2)
    await Promise.all([
      (ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0],
      (ctx2.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ])
    expect(bind.mock.calls[0][0]).not.toBe(bind.mock.calls[1][0])
    expect(bind.mock.calls[0][1]).toBe('reused')
    expect(bind.mock.calls[1][1]).toBe('reused')
  })

  it('classifies final delivery and settlement independently from fallback', () => {
    expect(classifyFacadeStatus(new Response('{}', { status: 502 }), null, 'primary_failed')).toBe('failed')
    expect(classifyFacadeStatus(new Response('{}', {
      status: 200,
      headers: { 'X-MPPRouter-Quoted-Amount': '0.004', 'X-Payment-Settle-Status': 'failed' },
    }), '0.004', 'primary_failed')).toBe('delivered_unsettled')
    expect(classifyFacadeStatus(new Response('{}', { status: 200 }), null, null)).toBe('passthrough')
    expect(classifyFacadeStatus(new Response('{}', { status: 200 }), '0.004', 'primary_failed')).toBe('fallback_used')
  })
})
