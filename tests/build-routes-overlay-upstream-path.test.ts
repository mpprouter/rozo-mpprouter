import { describe, it, expect } from 'vitest'

import { buildRoutesFromMppSnapshot } from '../src/services/build-routes'
import {
  PUBLIC_SERVICE_ROUTES,
  resolveUpstreamPath,
} from '../src/services/merchants'

/**
 * Overlay `upstreamPath` override: when the snapshot publishes a path
 * the router cannot resolve (gemini's literal `/{version}/models/*`
 * wildcard), the overlay supplies a fully templated replacement while
 * the overlay KEY keeps matching the snapshot-derived path.
 */
describe('overlay upstreamPath override', () => {
  const snapshot = {
    services: [
      {
        id: 'gemini',
        name: 'Gemini',
        serviceUrl: 'https://gemini.mpp.example.com',
        endpoints: [
          {
            method: 'POST',
            path: '/{version}/models/*',
            payment: { amount: '0', currency: 'USDC', intent: 'session' },
          },
        ],
      },
    ],
  }

  it('replaces the snapshot wildcard path with the templated override', () => {
    const routes = buildRoutesFromMppSnapshot(snapshot as any, {
      'gemini::/{version}/models/*': {
        id: 'gemini_generate',
        upstreamPath: '/{version}/models/{model}:generateContent',
        placeholderDefaults: { version: 'v1beta', model: 'gemini-2.0-flash' },
      },
    })
    expect(routes).toHaveLength(1)
    expect(routes[0].upstreamPath).toBe('/{version}/models/{model}:generateContent')
    // and the templated path fully resolves with the defaults
    const { path } = resolveUpstreamPath(routes[0], new URLSearchParams())
    expect(path).toBe('/v1beta/models/gemini-2.0-flash:generateContent')
  })

  it('leaves upstreamPath untouched when the overlay has no override', () => {
    const routes = buildRoutesFromMppSnapshot(snapshot as any, {
      'gemini::/{version}/models/*': { id: 'gemini_generate' },
    })
    expect(routes[0].upstreamPath).toBe('/{version}/models/*')
  })
})

describe('production overlay (real snapshot)', () => {
  it('gemini_generate resolves to a concrete generateContent path', () => {
    const gemini = PUBLIC_SERVICE_ROUTES.find((r) => r.id === 'gemini_generate')
    expect(gemini).toBeDefined()
    // regression guard: the snapshot wildcard `*` must never reach upstream
    expect(gemini!.upstreamPath).not.toContain('*')
    const { path } = resolveUpstreamPath(gemini!, new URLSearchParams())
    expect(path).toBe('/v1beta/models/gemini-2.0-flash:generateContent')
    // path bug fixed, but NOT payable until a fresh real-money E2E passes
    expect(gemini!.verifiedMode).toBe(false)
  })
})
