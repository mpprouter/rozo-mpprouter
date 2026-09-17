import { describe, expect, it } from 'vitest'
import {
  FORWARDED_HINT_HEADER,
  buildForwardedClientHint,
  forwardedClientHintHeader,
  withForwardedClientHint,
} from './client-hint-forward'

const req = (headers: Record<string, string> = {}) =>
  new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice', {
    method: 'POST',
    headers,
  })

describe('client-hint-forward', () => {
  it('captures ua / ip / referer / origin and the resolved client label', () => {
    const hint = buildForwardedClientHint(
      req({
        'user-agent': ' Mozilla/5.0 (Brave) ',
        'cf-connecting-ip': '203.0.113.9',
        referer: 'https://agent.rozo.ai/pay/x',
        origin: 'https://agent.rozo.ai',
      }),
      'rozo-checkout-web',
    )
    expect(hint).toEqual({
      ua: 'Mozilla/5.0 (Brave)',
      ip: '203.0.113.9',
      referer: 'https://agent.rozo.ai/pay/x',
      origin: 'https://agent.rozo.ai',
      client: 'rozo-checkout-web',
    })
  })

  it('emits no header when nothing was seen, and never exceeds the cap', () => {
    expect(forwardedClientHintHeader(req(), null)).toBeNull()
    const huge = 'x'.repeat(5000)
    const encoded = forwardedClientHintHeader(req({ 'user-agent': huge, referer: huge, origin: huge }), null)
    // each field is truncated, so the whole thing fits
    expect(encoded).not.toBeNull()
    expect(encoded!.length).toBeLessThanOrEqual(1024)
    expect(JSON.parse(encoded!).ua.length).toBe(200)
  })

  it('adds the header only when there is a value, without touching other headers', () => {
    const base = { 'content-type': 'application/json', 'X-API-Key': 'k' }
    expect(withForwardedClientHint(base, null)).toBe(base)
    const out = withForwardedClientHint(base, '{"ua":"curl/8"}')
    expect(out[FORWARDED_HINT_HEADER]).toBe('{"ua":"curl/8"}')
    expect(out['X-API-Key']).toBe('k')
  })
})
