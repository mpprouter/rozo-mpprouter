/**
 * Pure-function tests for the two building blocks of the Mercury MVP
 * router-held-credential path: converting a fixed USD price into the
 * base-unit-6 amount every other 402 challenge in this file uses, and
 * injecting the router-held credential into the upstream request without
 * ever forwarding the agent's own Authorization header.
 */

import { describe, it, expect } from 'vitest'
import { fixedPriceToBaseUnits6, injectUpstreamAuth, forwardHeaders, sanitizeUpstreamErrorDetail } from '../src/routes/proxy'
import type { Env } from '../src/index'

describe('fixedPriceToBaseUnits6', () => {
  it('converts the Mercury MVP price to base units at 6 decimals', () => {
    expect(fixedPriceToBaseUnits6('0.0005')).toBe('500')
  })

  it('handles whole-dollar and sub-cent amounts exactly', () => {
    expect(fixedPriceToBaseUnits6('1')).toBe('1000000')
    expect(fixedPriceToBaseUnits6('0.000001')).toBe('1')
    expect(fixedPriceToBaseUnits6('0')).toBe('0')
  })

  it('rejects more than 6 fractional digits rather than silently truncating', () => {
    expect(() => fixedPriceToBaseUnits6('0.0000001')).toThrow()
  })

  it('rejects non-decimal input', () => {
    expect(() => fixedPriceToBaseUnits6('abc')).toThrow()
    expect(() => fixedPriceToBaseUnits6('-0.01')).toThrow()
  })
})

describe('injectUpstreamAuth', () => {
  const route = {
    upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' as const },
  }

  it('sets Bearer <token> from the named env binding', () => {
    const env = { MERCURYDATA_MAINNET_JWT: 'super-secret-token' } as unknown as Env
    const headers = injectUpstreamAuth({}, route, env)
    expect(headers.get('Authorization')).toBe('Bearer super-secret-token')
  })

  it('sends the raw token with scheme:"raw" (no Bearer prefix)', () => {
    const env = { MERCURYDATA_MAINNET_JWT: 'raw-value' } as unknown as Env
    const rawRoute = { upstreamAuth: { ...route.upstreamAuth, scheme: 'raw' as const } }
    const headers = injectUpstreamAuth({}, rawRoute, env)
    expect(headers.get('Authorization')).toBe('raw-value')
  })

  it('no-ops (does not set the header) when the secret is unset in this environment', () => {
    const env = {} as unknown as Env
    const headers = injectUpstreamAuth({}, route, env)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('no-ops for a route with no upstreamAuth at all', () => {
    const env = { MERCURYDATA_MAINNET_JWT: 'super-secret-token' } as unknown as Env
    const headers = injectUpstreamAuth({}, {}, env)
    expect(headers.has('Authorization')).toBe(false)
  })

  it('never carries the agent-supplied Authorization header through — forwardHeaders strips it first', () => {
    const request = new Request('https://apiserver.mpprouter.dev/v1/services/mercury/events/by-ledger', {
      headers: { Authorization: 'Payment agent-supplied-credential-must-not-leak' },
    })
    const env = { MERCURYDATA_MAINNET_JWT: 'router-held-secret' } as unknown as Env
    const headers = injectUpstreamAuth(forwardHeaders(request), route, env)
    // Only the router-held credential goes upstream — never the agent's.
    expect(headers.get('Authorization')).toBe('Bearer router-held-secret')
  })
})

describe('sanitizeUpstreamErrorDetail', () => {
  // SECURITY (P1, codex review 2026-08-12): upstreamAuth routes carry a
  // router-held credential (e.g. the Mercury JWT) on the outbound
  // request. Reflecting the raw upstream error body back to the caller
  // risks leaking that credential if the upstream ever echoes request
  // state in its error output.
  it('withholds the raw upstream body for upstreamAuth routes, even if it contains a secret', () => {
    const leakyBody = JSON.stringify({
      error: 'unauthorized',
      // Simulates an upstream that echoes the request it received,
      // including our router-held credential — must never reach the caller.
      received_authorization: 'Bearer super-secret-mercury-jwt-do-not-leak',
    })
    const detail = sanitizeUpstreamErrorDetail(true, leakyBody)
    expect(detail).not.toContain('super-secret-mercury-jwt-do-not-leak')
    expect(detail).not.toContain('received_authorization')
    expect(detail).toBe('Upstream returned an error. Detail withheld for router-held-credential routes.')
  })

  it('keeps the old verbatim (first-500-chars) passthrough for non-upstreamAuth routes — byte-identical to pre-fix behavior', () => {
    const body = '{"error":"merchant says no","code":"MERCHANT_DOWN"}'
    expect(sanitizeUpstreamErrorDetail(false, body)).toBe(body.substring(0, 500))
  })

  it('non-upstreamAuth truncates at exactly 500 chars like the original inline `body.substring(0, 500)`', () => {
    const longBody = 'x'.repeat(1000)
    const detail = sanitizeUpstreamErrorDetail(false, longBody)
    expect(detail).toHaveLength(500)
    expect(detail).toBe(longBody.substring(0, 500))
  })
})
