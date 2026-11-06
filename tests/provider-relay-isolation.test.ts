import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import type { PublicServiceRoute } from '../src/services/merchants-types'
import { relayDirectSettlementRoute } from '../src/routes/provider-relay'
import { withCors } from '../src/utils/cors'

// No network, credentials or funds. Keep these tests focused on the response
// trust boundary rather than health/metrics persistence.
vi.mock('../src/services/route-metrics', () => ({
  classifyOutcome: () => 'ok',
  recordRouteCall: vi.fn(),
}))
vi.mock('../src/services/route-health', () => ({
  recordRouteFailure: vi.fn(),
  recordRouteSuccess: vi.fn(),
}))

const route = {
  id: 'provider_example', upstreamHost: 'provider.example', upstreamPath: '/api',
  operator: { id: 'provider' },
} as unknown as PublicServiceRoute
const env = {} as Env
const ctx = { waitUntil() {} } as unknown as ExecutionContext
const policy = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

async function relay(upstream: Response, host = 'coupon.rozo.ai') {
  const request = new Request(`https://${host}/v1/services/provider/example`)
  const response = await relayDirectSettlementRoute(request, env, ctx, route, async () => upstream)
  // The Worker applies this wrapper on the real response path.
  return withCors(request, response)
}

function expectIsolated(response: Response) {
  expect(response.headers.get('content-security-policy')).toBe(policy)
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
}

describe('direct provider response isolation', () => {
  it.each([
    'text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml',
    'application/javascript', 'text/javascript', 'text/css',
    'application/pdf', 'text/html, application/json', '',
  ])('does not publish %s as an active router document or script', async contentType => {
    const upstream = new Response('<script>fetch("/partner/api")</script>', {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Content-Security-Policy': "default-src * 'unsafe-inline'; sandbox allow-scripts allow-same-origin",
        'X-Content-Type-Options': 'invalid',
      },
    })
    const response = await relay(upstream)
    expectIsolated(response)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="provider-response.bin"')
    expect(await response.text()).toBe('<script>fetch("/partner/api")</script>')
  })

  it('handles an absent Content-Type without relying on browser sniffing', async () => {
    const upstream = new Response('<svg onload="alert(1)"></svg>')
    upstream.headers.delete('content-type')
    const response = await relay(upstream)
    expectIsolated(response)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })

  it.each([200, 402, 403, 500])('isolates provider HTML at status %i without losing payment headers', async status => {
    const response = await relay(new Response('<html>provider body</html>', {
      status,
      headers: {
        'Content-Type': 'text/html', 'Payment-Required': 'challenge',
        'Payment-Response': 'receipt', 'WWW-Authenticate': 'Payment challenge',
      },
    }))
    expectIsolated(response)
    expect(response.status).toBe(status)
    expect(response.headers.get('payment-required')).toBe('challenge')
    expect(response.headers.get('payment-response')).toBe('receipt')
    expect(response.headers.get('www-authenticate')).toBe('Payment challenge')
    expect(response.headers.get('x-mpp-router-settlement')).toBe('direct')
    expect(await response.text()).toBe('<html>provider body</html>')
  })

  it.each(['application/json', 'application/problem+json', 'text/plain', 'text/event-stream'])('preserves passive API MIME %s and streaming', async contentType => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')) },
    })
    const upstream = new Response(stream, { headers: { 'Content-Type': contentType } })
    const response = await relay(upstream)
    expectIsolated(response)
    expect(response.headers.get('content-type')).toBe(contentType)
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(response.bodyUsed).toBe(false)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first chunk')
    await reader.cancel()
  })

  it('removes provider headers that can affect router origin state or navigation', async () => {
    const response = await relay(new Response('{}', { headers: {
      'Content-Type': 'application/json', 'Refresh': '0;url=/partner/api',
      'Link': '</partner/api>; rel=prefetch', 'Clear-Site-Data': '"*"',
      'Service-Worker-Allowed': '/', 'Set-Cookie': 'attacker=value',
      'Content-Security-Policy-Report-Only': "default-src 'none'; report-uri https://provider.example/report",
      'Report-To': '{}', 'Reporting-Endpoints': 'default="https://provider.example/report"', 'NEL': '{}',
    } }))
    expectIsolated(response)
    for (const header of ['refresh', 'link', 'clear-site-data', 'service-worker-allowed', 'set-cookie',
      'content-security-policy-report-only', 'report-to', 'reporting-endpoints', 'nel']) {
      expect(response.headers.has(header)).toBe(false)
    }
  })

  it.each(['coupon.rozo.ai', 'apiserver.mpprouter.dev'])('applies isolation independently of host %s', async host => {
    const response = await relay(new Response('<html>untrusted</html>', { headers: { 'Content-Type': 'text/html' } }), host)
    expectIsolated(response)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('keeps an empty 204 response valid', async () => {
    const response = await relay(new Response(null, { status: 204 }))
    expectIsolated(response)
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('isolates the router-generated redirect refusal', async () => {
    const response = await relay(new Response(null, { status: 302, headers: { Location: 'https://provider.example/next' } }))
    expectIsolated(response)
    expect(response.status).toBe(502)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('isolates the router-generated network failure without reflecting error text', async () => {
    const request = new Request('https://coupon.rozo.ai/v1/services/provider/example')
    const response = await relayDirectSettlementRoute(request, env, ctx, route, async () => { throw new Error('<script>bad</script>') })
    expectIsolated(response)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('<script>')
  })
})
