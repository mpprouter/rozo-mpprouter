/**
 * create-invoice relays rozo-intents-api's 429 (tiered per-IP creation limit,
 * rozo-intents-api PR #643) instead of turning it into a 502, and always
 * forwards the Cloudflare-provided buyer IP the upstream limiter keys on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { relayUpstreamRateLimit } from '../src/routes/upstream-rate-limit'
import { FORWARDED_HINT_HEADER } from '../src/routes/client-hint-forward'
import { withCors } from '../src/utils/cors'
import type { Env } from '../src/index'

const UPSTREAM_429_BODY = {
  error: {
    code: 'rate_limited',
    message:
      'Too many payment creations from this IP. Limit is 10 per 600s (tier0). Retry after 412s; attempts made while limited also count.',
  },
  requestId: 'req-1',
  data: {
    errorCode: 'CREATE_RATE_LIMITED',
    tier: 'tier0',
    scope: 'ip_window',
    limit: 10,
    windowSeconds: 600,
    remaining: 0,
    retryAfterSeconds: 412,
    upgrade: 'Completing a payment from this IP raises its limit.',
  },
}

const UPSTREAM_429_HEADERS = {
  'content-type': 'application/json',
  'Retry-After': '412',
  'X-RateLimit-Limit': '10',
  'X-RateLimit-Remaining': '0',
  'X-RateLimit-Tier': 'tier0',
  'X-RateLimit-Window': '600',
  'X-RateLimit-Scope': 'ip_window',
}

function upstream429(headers: Record<string, string> = UPSTREAM_429_HEADERS, body: unknown = UPSTREAM_429_BODY) {
  return new Response(JSON.stringify(body), { status: 429, headers })
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    BITREFILL_ENABLED: 'true',
    ROZO_BITREFILL_API_KEY: 'bitrefill-key',
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
    ...extra,
  } as unknown as Env
}

let createResponse: () => Response
let createHeaders: Headers[] = []

beforeEach(() => {
  createHeaders = []
  createResponse = () =>
    new Response(
      JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
      { status: 200 },
    )
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({ invoice: { amount: '10.5' }, merchant: 'OpenRouter, Inc', linkId: 'paymentSession_rl_test' }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) return new Response('not found', { status: 404 })
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createHeaders.push(new Headers(init?.headers))
      return createResponse()
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

function createReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers },
    body: JSON.stringify(body),
  })
}

const COINBASE_BODY = { payment_id: 'paymentSession_rl_test', source: { chainId: '1500', tokenSymbol: 'USDC' } }
const BITREFILL_BODY = {
  provider: 'bitrefill',
  bitrefill: {
    invoiceId: 'inv-rl1',
    address: '0x1111111111111111111111111111111111111111',
    amount: '12.345678',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  },
  source: { chainId: '1500', tokenSymbol: 'USDC' },
}

function expectRelayed429(res: Response, json: any) {
  expect(res.status).toBe(429)
  expect(res.headers.get('Retry-After')).toBe('412')
  expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
  expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
  expect(res.headers.get('X-RateLimit-Tier')).toBe('tier0')
  expect(res.headers.get('X-RateLimit-Window')).toBe('600')
  expect(res.headers.get('X-RateLimit-Scope')).toBe('ip_window')
  expect(json.code).toBe('RATE_LIMITED')
  expect(json.errorCode).toBe('CREATE_RATE_LIMITED')
  expect(json.tier).toBe('tier0')
  expect(json.retryAfterSeconds).toBe(412)
  expect(json.upgrade).toMatch(/raises its limit/)
  expect(json.message).toMatch(/Retry after 412s/)
  expect(json.upstream_status).toBe(429)
  expect(json.upstream_code).toBe('rate_limited')
  expect(json.upstream).toEqual(UPSTREAM_429_BODY)
}

describe('create-invoice relays the upstream 429', () => {
  it('Coinbase path: status, Retry-After, X-RateLimit-*, errorCode and tier pass through', async () => {
    createResponse = () => upstream429()
    const res = await handleCreateInvoice(createReq(COINBASE_BODY), makeEnv())
    const json = (await res.json()) as any
    expectRelayed429(res, json)
    expect(json.code).not.toBe('INTENTS_API_FAILED')
  })

  it('Bitrefill path relays the same 429 in its own envelope', async () => {
    createResponse = () => upstream429()
    const res = await handleCreateInvoice(createReq(BITREFILL_BODY), makeEnv())
    const json = (await res.json()) as any
    expectRelayed429(res, json)
    expect(json.ok).toBe(false)
    expect(json.error).toBe('RATE_LIMITED')
  })

  it('headers survive the CORS wrapper and are exposed to browser JS', async () => {
    createResponse = () => upstream429()
    const req = createReq(COINBASE_BODY, { origin: 'https://checkout.rozo.ai' })
    const res = withCors(req, await handleCreateInvoice(req, makeEnv()))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('412')
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim())
    for (const h of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-tier', 'x-ratelimit-window', 'x-ratelimit-scope']) {
      expect(exposed).toContain(h)
    }
  })

  it('a non-429 upstream error keeps the existing 502 INTENTS_API_FAILED', async () => {
    createResponse = () => new Response('boom', { status: 500 })
    const res = await handleCreateInvoice(createReq(COINBASE_BODY), makeEnv())
    expect(res.status).toBe(502)
    expect(((await res.json()) as any).code).toBe('INTENTS_API_FAILED')
  })
})

describe('relayUpstreamRateLimit', () => {
  it('returns null for non-429 responses', () => {
    expect(relayUpstreamRateLimit(new Response('x', { status: 400 }), 'x')).toBeNull()
  })

  it('derives Retry-After from the body when a proxy dropped the header', async () => {
    const resp = upstream429({ 'content-type': 'application/json' })
    const out = relayUpstreamRateLimit(resp, JSON.stringify(UPSTREAM_429_BODY))!
    expect(out.status).toBe(429)
    expect(out.headers.get('Retry-After')).toBe('412')
    const json = (await out.json()) as any
    expect(json.errorCode).toBe('CREATE_RATE_LIMITED')
  })

  it('handles a bare upstream 429 (keyed app bucket, non-JSON body)', async () => {
    const out = relayUpstreamRateLimit(new Response('slow down', { status: 429 }), 'slow down', { provider: 'stripe_crypto' })!
    expect(out.status).toBe(429)
    expect(out.headers.get('Retry-After')).toBeNull()
    const json = (await out.json()) as any
    expect(json.code).toBe('RATE_LIMITED')
    expect(json.provider).toBe('stripe_crypto')
    expect(json.upstream).toBeNull()
  })
})

describe('create-invoice forwards the Cloudflare buyer IP on every create', () => {
  it('Coinbase and Bitrefill creates carry x-rozo-client-hint.ip = cf-connecting-ip', async () => {
    await handleCreateInvoice(createReq(COINBASE_BODY), makeEnv())
    await handleCreateInvoice(createReq(BITREFILL_BODY), makeEnv())
    expect(createHeaders).toHaveLength(2)
    for (const h of createHeaders) {
      const hint = JSON.parse(h.get(FORWARDED_HINT_HEADER) ?? '{}')
      expect(hint.ip).toBe('203.0.113.9')
    }
  })

  it('ignores a client-supplied X-Forwarded-For / X-Real-IP', async () => {
    await handleCreateInvoice(
      createReq(COINBASE_BODY, { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' }),
      makeEnv(),
    )
    const hint = JSON.parse(createHeaders[0].get(FORWARDED_HINT_HEADER) ?? '{}')
    expect(hint.ip).toBe('203.0.113.9')
  })
})

describe('router backstop 429', () => {
  it('sets Retry-After and reports the env-configured limit', async () => {
    const store = new Map<string, string>()
    const versions = new Map<string, number>()
    const stub = {
      async fetch(req: Request) {
        const url = new URL(req.url)
        const b: any = await req.json()
        if (url.pathname === '/read') {
          return Response.json({ value: store.get(b.key) ?? null, version: versions.get(b.key) ?? 0 })
        }
        const cur = versions.get(b.key) ?? 0
        if (cur !== b.expectedVersion) return Response.json({ ok: false, value: store.get(b.key) ?? null, version: cur })
        store.set(b.key, b.value)
        versions.set(b.key, cur + 1)
        return Response.json({ ok: true })
      },
    }
    const env = makeEnv({
      ATOMIC_STORE: { idFromName: (n: string) => ({ name: n }), get: () => stub },
      CREATE_INVOICE_IP_LIMIT_PER_HOUR: '1',
    })
    expect((await handleCreateInvoice(createReq(COINBASE_BODY), env)).status).toBe(200)
    const res = await handleCreateInvoice(createReq(COINBASE_BODY), env)
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(3600)
    const json = (await res.json()) as any
    expect(json.code).toBe('RATE_LIMITED')
    expect(json.limit).toBe(1)
    expect(json.retryAfterSeconds).toBe(retryAfter)
  })
})
