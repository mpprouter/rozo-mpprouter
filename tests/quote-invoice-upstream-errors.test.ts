/**
 * quote-invoice: how an agentapi failure is classified.
 *
 * Every non-2xx from agentapi except 409/410 used to come back as a 502
 * QUOTE_UNAVAILABLE. The overwhelmingly common case is a 404, i.e. the buyer
 * pasted a Coinbase link that no longer exists: they were shown "server error"
 * instead of "this link is dead", and every one of those counted as one of our
 * 5xx, burying real incidents in the Cloudflare alert.
 *
 * A bad link is a 4xx. Only agentapi being unreachable or broken is a 502.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'

const LINK = 'https://payments.coinbase.com/payment-links/pl_01ABCxyz'
const env = { PAYINVOICE_ADMIN_SECRET: 'test-secret' } as unknown as import('../src/index').Env

function post() {
  return new Request('https://mpp.test/quote-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: LINK }),
  })
}

/** agentapi answers with `status`; nothing else is called. */
function mockAgentApi(status: number, body = `upstream says ${status}`) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    expect(u).toContain('agentapi.rozo.ai/quote-invoice')
    return new Response(body, { status })
  })
}

describe('quote-invoice upstream error classification', () => {
  afterEach(() => vi.restoreAllMocks())

  it('maps a 404 from agentapi to 404 LINK_NOT_FOUND, not 502', async () => {
    mockAgentApi(404, 'Coinbase has no payment link with id pl_01ABCxyz')
    const res = await handleQuoteInvoice(post(), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(404)
    expect(body.code).toBe('LINK_NOT_FOUND')
    // The hint carries the upstream detail so support can see what Coinbase said.
    expect(body.hint).toContain('pl_01ABCxyz')
  })

  it('maps other link-level 4xx from agentapi to 422 LINK_NOT_PAYABLE', async () => {
    mockAgentApi(400)
    const res = await handleQuoteInvoice(post(), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(422)
    expect(body.code).toBe('LINK_NOT_PAYABLE')
  })

  it('keeps 409 and 410 as LINK_USED_OR_EXPIRED', async () => {
    for (const status of [409, 410]) {
      vi.restoreAllMocks()
      mockAgentApi(status)
      const res = await handleQuoteInvoice(post(), env)
      const body = (await res.json()) as any
      expect(res.status).toBe(status)
      expect(body.code).toBe('LINK_USED_OR_EXPIRED')
    }
  })

  // Not every 4xx is the link's fault. agentapi answers 401/403 when it rejects
  // OUR admin secret and 408/429 when it is timing out or throttling US. Those
  // are our outage: calling them LINK_NOT_PAYABLE would blame the buyer's link
  // and leave the Cloudflare 5xx alert silent through a total checkout outage.
  // (Verified 2026-09-22: an unauthenticated POST to agentapi.rozo.ai/quote-invoice
  // answers 401 {"error":"unauthorized"}.)
  it.each([401, 403, 408, 429])(
    'keeps upstream %i (our fault, not the link) as 502 QUOTE_UNAVAILABLE',
    async (status) => {
      mockAgentApi(status)
      const res = await handleQuoteInvoice(post(), env)
      const body = (await res.json()) as any
      expect(res.status).toBe(502)
      expect(body.code).toBe('QUOTE_UNAVAILABLE')
    },
  )

  it('keeps a 5xx from agentapi as 502 QUOTE_UNAVAILABLE', async () => {
    mockAgentApi(500)
    const res = await handleQuoteInvoice(post(), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(502)
    expect(body.code).toBe('QUOTE_UNAVAILABLE')
  })

  it('keeps an unreachable agentapi as 502 QUOTE_UNAVAILABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('error sending request: connection timed out')
    })
    const res = await handleQuoteInvoice(post(), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(502)
    expect(body.code).toBe('QUOTE_UNAVAILABLE')
    expect(body.hint).toContain('unreachable')
  })
})
