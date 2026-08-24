import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleProxySpy } = vi.hoisted(() => ({ handleProxySpy: vi.fn() }))
vi.mock('../src/routes/proxy', () => ({ handleProxy: handleProxySpy }))

import { classifyFacadeStatus, FACADE_MODELS, handleChatCompletions, handleModels } from '../src/routes/chat-completions'
import { PUBLIC_SERVICE_ROUTES } from '../src/services/merchants'
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
    expect(body.data.map(model => model.id).sort()).toEqual([
      'claude-haiku-4-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5',
      'deepseek-v4-flash', 'grok-4.3', 'mistral-medium-2505', 'sonar',
    ])
  })

  // The model list is derived from the catalog (2026-08-24), so these three
  // properties are what stop it drifting away from what we actually sell.
  it('derives every facade model from a live catalog route', () => {
    for (const model of FACADE_MODELS) {
      const route = PUBLIC_SERVICE_ROUTES.find(entry => entry.publicPath === model.route)
      expect(route, `no catalog route for ${model.id}`).toBeDefined()
      expect(route!.service).toBe(model.provider)
      expect(route!.verifiedMode).not.toBe(false)
    }
  })

  it('exposes the anthropic models, per the 2026-08-24 founder decision', () => {
    // Registered as a normal service. Note the upstream merchant was still
    // answering 403-after-payment on a paid probe on 2026-08-24, so these
    // currently refund rather than deliver; that is the merchant's state, not
    // a restriction this router imposes. This test exists so that removing
    // them is a conscious decision rather than a tidy-up.
    const anthropic = FACADE_MODELS.filter(model => model.provider === 'anthropic')
    expect(anthropic.map(model => model.id).sort()).toEqual([
      'claude-haiku-4-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5',
    ])
    expect(anthropic.every(model => model.route === '/v1/services/anthropic/chat_completions')).toBe(true)
  })

  it('rejects grok-3-mini before payment, since the upstream substitutes grok-4.3', () => {
    // Advertising an id the merchant silently swaps means the caller pays for
    // a model they did not ask for. Unavailable (400 before payment, naming
    // the replacement) rather than deleted.
    const stale = FACADE_MODELS.find(model => model.id === 'grok-3-mini')
    expect(stale?.available).toBe(false)
    expect(stale?.unavailableReason).toContain('grok-4.3')
    expect(FACADE_MODELS.find(model => model.id === 'grok-4.3')?.available).toBe(true)
  })

  it('keeps a known-broken model id listed as unavailable rather than deleted', () => {
    // Deleting it would turn a 400-before-payment into a paid call against an
    // id the merchant no longer serves.
    const groq = FACADE_MODELS.find(model => model.id === 'llama-3.1-8b-instant')
    expect(groq).toBeDefined()
    expect(groq!.available).toBe(false)
    expect(groq!.unavailableReason).toBeTruthy()
  })

  it('explains why a registered-but-unavailable model was rejected', async () => {
    const response = await handleChatCompletions(
      request({ model: 'grok-3-mini', messages: [] }), {} as Env, context(),
    )
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { message: string } }
    expect(body.error.message).toContain('grok-3-mini is currently unavailable')
    expect(body.error.message).toContain('grok-4.3')
    expect(handleProxySpy).not.toHaveBeenCalled()
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

  it('records the model the merchant says it served, and flags a substitution', async () => {
    // How the grok substitution was caught: we asked for one model and the
    // merchant answered with another. Reading that off the response body by
    // hand does not scale, so the ledger records it.
    const run = vi.fn().mockResolvedValue({ success: true })
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const env = { COUPON_SECURITY_DB: { prepare } } as unknown as Env
    const ctx = context()
    handleProxySpy.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { id: 'c1', object: 'chat.completion', model: 'grok-4.3', choices: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await handleChatCompletions(
      request({ model: 'deepseek-v4-flash', messages: [] }), env, ctx,
    )
    await ((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0] as Promise<void>)
    const evidence = JSON.parse(bind.mock.calls[0][15] as string)
    expect(evidence.served_model).toBe('grok-4.3')
    expect(evidence.model_substituted).toBe(true)
  })

  it('does not flag a substitution when the merchant echoes the model back', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const env = { COUPON_SECURITY_DB: { prepare } } as unknown as Env
    const ctx = context()
    handleProxySpy.mockResolvedValue(new Response(JSON.stringify({
      id: 'c1', object: 'chat.completion', model: 'deepseek-v4-flash', choices: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await handleChatCompletions(
      request({ model: 'deepseek-v4-flash', messages: [] }), env, ctx,
    )
    await ((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0] as Promise<void>)
    const evidence = JSON.parse(bind.mock.calls[0][15] as string)
    expect(evidence.served_model).toBe('deepseek-v4-flash')
    expect(evidence.model_substituted).toBe(false)
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
    expect(classifyFacadeStatus(new Response('{}', {
      status: 502,
      headers: { 'X-MPPRouter-Quoted-Amount': '0.008', 'Refund-Status': 'pending' },
    }), '0.008', null)).toBe('failed')
  })
})
