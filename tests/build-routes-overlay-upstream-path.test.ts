import { describe, it, expect } from 'vitest'

import { buildRoutesFromMppSnapshot } from '../src/services/build-routes'
import {
  PUBLIC_SERVICE_ROUTES,
  resolveUpstreamPath,
} from '../src/services/merchants'

/**
 * Overlay `upstreamPath` override (2026-07-29): when the snapshot
 * publishes a path the router cannot resolve (gemini's literal
 * `/{version}/models/*` wildcard), the overlay supplies a fully
 * templated replacement while the overlay KEY keeps matching the
 * snapshot-derived path.
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
    const { path } = resolveUpstreamPath(gemini!, new URLSearchParams())
    expect(path).toBe('/v1beta/models/gemini-2.0-flash:generateContent')
    // disabled until the upstream NANOUSD currency issue is resolved
    expect(gemini!.verifiedMode).toBe(false)
  })

  it('NANOUSD-blocked mpp.tempo.xyz routes are disabled', () => {
    for (const id of ['anthropic_messages', 'openai_chat', 'openrouter_chat', 'tempo_rpc']) {
      const route = PUBLIC_SERVICE_ROUTES.find((r) => r.id === id)
      expect(route, id).toBeDefined()
      expect(route!.verifiedMode, id).toBe(false)
    }
  })

  it('services verified by 2026-07-29 real-money E2E are charge-verified', () => {
    const expected = [
      'grok_grok_chat',
      'mistral_mistral_chat',
      'perplexity_perplexity_chat',
      'deepgram_deepgram_list-models',
      'deepseek_chat',
      'coingecko_simple_price',
      'exa_search',
      'firecrawl_scrape',
      'parallel_search',
    ]
    for (const id of expected) {
      const route = PUBLIC_SERVICE_ROUTES.find((r) => r.id === id)
      expect(route, id).toBeDefined()
      expect(route!.chargeVerified, id).toBe(true)
    }
  })
})
