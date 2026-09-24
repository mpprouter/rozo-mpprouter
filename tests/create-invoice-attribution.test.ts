/**
 * create-invoice writes order-level attribution to metadata.attribution.
 *
 * Pins the 2026-09-25 contract shared with agent.rozo.ai, checkout.rozo.ai and
 * the @rozoai/checkout skill: whitelisted keys only, sanitized, client derived
 * from the User-Agent when absent, written on creation only, and never able to
 * change pricing, routing, validation or the response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import {
  buildOrderAttribution,
  clientFromUserAgent,
  sanitizeOrderAttribution,
} from '../src/routes/order-attribution'
import type { Env } from '../src/index'

// ── Unit: sanitizer ───────────────────────────────────────────────────────────

describe('sanitizeOrderAttribution', () => {
  it('keeps only whitelisted string keys', () => {
    expect(
      sanitizeOrderAttribution({
        client: 'rozo-agent-web/1.2.0',
        utm_source: 'x',
        utm_medium: 'social',
        utm_campaign: 'launch',
        utm_content: 'post-1',
        utm_term: 'dropped',
        ref: 'dropped',
        evil: 'dropped',
        referrer: 'https://www.google.com/search?q=secret#frag',
        landing_path: '/btc?utm_source=x#top',
      }),
    ).toEqual({
      client: 'rozo-agent-web/1.2.0',
      utm_source: 'x',
      utm_medium: 'social',
      utm_campaign: 'launch',
      utm_content: 'post-1',
      referrer: 'https://www.google.com/search',
      landing_path: '/btc',
    })
  })

  it('drops non-string values', () => {
    expect(
      sanitizeOrderAttribution({ client: 42, utm_source: { a: 1 }, utm_medium: ['x'], utm_campaign: null }),
    ).toBeNull()
  })

  it('strips control and invisible format characters', () => {
    expect(
      sanitizeOrderAttribution({ utm_source: 'goo\u0000gle​‮\n', client: '\u0007' }),
    ).toEqual({ utm_source: 'google' })
  })

  it('truncates to the per-key caps', () => {
    const out = sanitizeOrderAttribution({
      client: 'c'.repeat(500),
      utm_campaign: 'u'.repeat(500),
      landing_path: '/' + 'p'.repeat(1000),
      referrer: 'https://example.com/' + 'r'.repeat(2000),
    })!
    expect(out.client!.length).toBe(64)
    expect(out.utm_campaign!.length).toBe(100)
    expect(out.landing_path!.length).toBe(256)
    expect(out.referrer!.length).toBe(512)
    expect(out.referrer!.startsWith('https://example.com/')).toBe(true)
  })

  it('drops non-http referrers and unparseable ones', () => {
    expect(sanitizeOrderAttribution({ referrer: 'javascript:alert(1)' })).toBeNull()
    expect(sanitizeOrderAttribution({ referrer: 'not a url' })).toBeNull()
    expect(sanitizeOrderAttribution({ referrer: 'https://user:pw@host.example/p?q=1' })).toEqual({
      referrer: 'https://host.example/p',
    })
  })

  it('returns null for missing, non-object, array and empty input', () => {
    expect(sanitizeOrderAttribution(undefined)).toBeNull()
    expect(sanitizeOrderAttribution('utm_source=x')).toBeNull()
    expect(sanitizeOrderAttribution(['x'])).toBeNull()
    expect(sanitizeOrderAttribution({})).toBeNull()
  })
})

describe('clientFromUserAgent', () => {
  it('recognizes the checkout skill', () => {
    expect(clientFromUserAgent('rozo-checkout-skill/0.1.12 node/22')).toBe('rozo-checkout-skill/0.1.12')
  })
  it('labels Mozilla UAs as browser', () => {
    expect(clientFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('browser')
  })
  it('falls back to unknown', () => {
    expect(clientFromUserAgent('node')).toBe('unknown')
    expect(clientFromUserAgent(null)).toBe('unknown')
    expect(clientFromUserAgent('')).toBe('unknown')
  })
  it('caps a long skill version at 64 chars', () => {
    expect(clientFromUserAgent('rozo-checkout-skill/' + '1'.repeat(200)).length).toBe(64)
  })
})

describe('buildOrderAttribution', () => {
  const req = (ua?: string) =>
    new Request('https://mpp.test/x', { headers: ua ? { 'user-agent': ua } : {} })

  it('an explicit client wins over the User-Agent', () => {
    expect(buildOrderAttribution({ client: 'rozo-checkout-web' }, req('Mozilla/5.0'))).toEqual({
      client: 'rozo-checkout-web',
    })
  })
  it('derives client from the User-Agent when absent', () => {
    expect(buildOrderAttribution({ utm_source: 'x' }, req('Mozilla/5.0'))).toEqual({
      utm_source: 'x',
      client: 'browser',
    })
    expect(buildOrderAttribution(undefined, req('rozo-checkout-skill/0.1.12'))).toEqual({
      client: 'rozo-checkout-skill/0.1.12',
    })
    expect(buildOrderAttribution('garbage', req())).toEqual({ client: 'unknown' })
  })
})

// ── Integration: create-invoice (Coinbase line) ───────────────────────────────

function makeEnv(): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
  } as unknown as Env
}

const PAYMENT_ID = 'paymentSession_attribution_test'
let createdIntent: any = null
let existingIntent: any = null
let nonGetCalls: string[] = []

function installFetchMock() {
  createdIntent = null
  existingIntent = null
  nonGetCalls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (init?.method && init.method !== 'GET') nonGetCalls.push(`${init.method} ${u}`)
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({ invoice: { amount: '10' }, merchant: 'OpenRouter, Inc', linkId: PAYMENT_ID }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      return existingIntent
        ? new Response(JSON.stringify(existingIntent), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
        { status: 200 },
      )
    }
    if (u.includes('/payment-api')) {
      return new Response(JSON.stringify({ status: 'payment_unpaid' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

async function createInvoice(body: Record<string, unknown> | string, ua?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ua) headers['user-agent'] = ua
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    makeEnv(),
  )
  return { status: res.status, json: (await res.json()) as any }
}

const EVM_SOURCE = { chainId: '8453', tokenSymbol: 'USDC' }
const LIGHTNING_SOURCE = { chainId: 'lightning', tokenSymbol: 'BTC' }

beforeEach(() => installFetchMock())
afterEach(() => vi.restoreAllMocks())

describe('create-invoice — metadata.attribution', () => {
  it('writes sanitized attribution on the EVM (exactIn) path', async () => {
    const { status } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: EVM_SOURCE,
      attribution: {
        client: 'rozo-checkout-web/landing',
        utm_source: 'x',
        referrer: 'https://t.co/abc?amp=1',
        landing_path: '/zh?utm_source=x',
        junk: 'dropped',
      },
    })
    expect(status).toBe(200)
    expect(createdIntent.metadata.attribution).toEqual({
      client: 'rozo-checkout-web/landing',
      utm_source: 'x',
      referrer: 'https://t.co/abc',
      landing_path: '/zh',
    })
    // Existing metadata keys are untouched.
    expect(createdIntent.metadata.source).toBe('mpprouter-create-invoice')
    expect(createdIntent.metadata.coinbasePaymentLinkId).toBeTruthy()
  })

  it('writes it on the Lightning (exactOut) path too', async () => {
    const { status } = await createInvoice(
      { payment_id: PAYMENT_ID, source: LIGHTNING_SOURCE, attribution: { utm_medium: 'email' } },
      'Mozilla/5.0 (X11; Linux x86_64)',
    )
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.metadata.attribution).toEqual({ utm_medium: 'email', client: 'browser' })
  })

  it('derives client from the User-Agent when no attribution is sent', async () => {
    await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE }, 'rozo-checkout-skill/0.1.12')
    expect(createdIntent.metadata.attribution).toEqual({ client: 'rozo-checkout-skill/0.1.12' })
  })

  it('never changes pricing, routing, title or response for any attribution shape', async () => {
    const baseline = await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE })
    const baseIntent = createdIntent
    const shapes: unknown[] = [
      'a string',
      ['an', 'array'],
      42,
      null,
      { client: { nested: true }, utm_source: 7 },
      { client: 'x'.repeat(100_000), referrer: '\u0000'.repeat(10_000) },
      { client: 'rozo-checkout-web' },
    ]
    for (const attribution of shapes) {
      installFetchMock()
      const run = await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE, attribution })
      expect(run.status).toBe(baseline.status)
      expect(run.json).toEqual(baseline.json)
      const { metadata: m1, attribution: _a1, ...rest1 } = createdIntent
      const { metadata: m0, attribution: _a0, ...rest0 } = baseIntent
      expect(rest1).toEqual(rest0)
      const { attribution: _x, ...md1 } = m1
      const { attribution: _y, ...md0 } = m0
      expect(md1).toEqual(md0)
      vi.restoreAllMocks()
    }
  })

  it('does not write attribution when an existing unpaid order is reused', async () => {
    existingIntent = {
      id: 'rozo-existing',
      status: 'payment_unpaid',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10' },
    }
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: EVM_SOURCE,
      attribution: { client: 'second-caller', utm_source: 'overwrite-attempt' },
    })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(createdIntent).toBeNull()
    // No write of any kind reached upstream (no create, no metadata patch).
    expect(nonGetCalls.filter((c) => c.includes('payment-api'))).toEqual([])
  })
})
