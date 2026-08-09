/**
 * Regression test for the merchant-leg Accept-Payment leak.
 *
 * History (2026-08-09): forwardHeaders copied every client header except
 * host/authorization onto the router→merchant request, including
 * `Accept-Payment`. mppx's resolvePaymentPreferences then adopted the
 * AGENT's preference (e.g. `stellar/charge`) as the ROUTER's own, so
 * selectChallengeCandidates filtered out every Tempo challenge the merchant
 * offered, leaving zero candidates and throwing
 * "No method found for challenges: ...". Every charge-mode service 502'd.
 *
 * The router pays merchants on its own terms; the agent's Accept-Payment
 * describes only what the agent can pay US with, and must not leak upstream.
 */

import { describe, it, expect } from 'vitest'
import { forwardHeaders } from '../src/routes/proxy'

function headerKeys(h: HeadersInit): string[] {
  return Object.keys(h as Record<string, string>).map((k) => k.toLowerCase())
}

describe('forwardHeaders', () => {
  it('strips Accept-Payment so the merchant leg keeps the router preferences', () => {
    const request = new Request('https://router.example/v1/services/exa/search', {
      method: 'POST',
      headers: {
        'Accept-Payment': 'stellar/charge',
        'Content-Type': 'application/json',
      },
    })

    const keys = headerKeys(forwardHeaders(request))

    expect(keys).not.toContain('accept-payment')
    expect(keys).toContain('content-type')
  })

  it('strips Accept-Payment regardless of header casing', () => {
    const request = new Request('https://router.example/v1/services/exa/search', {
      method: 'POST',
      headers: { 'accept-payment': 'stellar/charge' },
    })

    expect(headerKeys(forwardHeaders(request))).not.toContain('accept-payment')
  })

  it('still drops host and authorization by default, and keeps auth on request', () => {
    const request = new Request('https://router.example/v1/services/exa/search', {
      method: 'POST',
      headers: {
        Authorization: 'Payment abc',
        'Accept-Payment': 'stellar/charge',
        'X-Trace': 'keep-me',
      },
    })

    expect(headerKeys(forwardHeaders(request))).not.toContain('authorization')
    expect(headerKeys(forwardHeaders(request))).toContain('x-trace')

    const kept = headerKeys(forwardHeaders(request, { keepAuthorization: true }))
    expect(kept).toContain('authorization')
    // Accept-Payment stays stripped even in transparent-passthrough mode.
    expect(kept).not.toContain('accept-payment')
  })
})
