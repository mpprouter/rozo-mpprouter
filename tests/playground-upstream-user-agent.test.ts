/**
 * Playground upstream calls must carry a User-Agent.
 *
 * paywithlocus merchants (groq, deepseek) answer 403 to any request with no
 * User-Agent, before the 402 handshake; a Workers fetch sends none. Confirmed
 * 2026-09-15 by probing the merchants directly (empty UA → 403, any UA → 402).
 * The proxy forwards the buyer's UA so it never saw this; the playground
 * builds its headers from scratch, so every playground chat to those
 * merchants failed pre-payment and rolled the voucher back.
 */
import { describe, expect, it, vi } from 'vitest'

const payMerchant = vi.fn(async (_env: unknown, _url: string, init: RequestInit) => {
  const ua = new Headers(init.headers).get('user-agent')
  // Mirror the WAF: no UA → 403 before any payment.
  if (!ua) return new Response('forbidden', { status: 403 })
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
})

vi.mock('../src/mpp/tempo-client', () => ({
  BudgetExceededError: class extends Error {},
  ChannelNotInstalledError: class extends Error {},
  payMerchant: (...args: any[]) => (payMerchant as any)(...args),
  payMerchantSession: vi.fn(),
}))

const { callUpstream, resolvePlaygroundRoute, PLAYGROUND_USER_AGENT } = await import('../src/playground/upstream')

describe('playground upstream User-Agent', () => {
  it('sends an explicit User-Agent on tempo.charge calls (groq/deepseek WAF 403s an empty one)', async () => {
    const route = resolvePlaygroundRoute('/v1/services/groq/chat', 'POST')
    const call = await callUpstream({} as any, {
      route,
      body: { model: 'openai/gpt-oss-20b', messages: [] },
      budgetAtomic: 100_000n,
    })
    expect(call.response.status).toBe(200)
    const init = payMerchant.mock.calls[0][2]
    expect(new Headers(init.headers).get('user-agent')).toBe(PLAYGROUND_USER_AGENT)
    expect(PLAYGROUND_USER_AGENT).toMatch(/^mpprouter/)
  })
})
