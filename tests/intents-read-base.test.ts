// Read-path switch (ROZO_INTENTS_READ_BASE): read-only GETs move to the
// configured base; unset keeps the exact payment-api URLs; writes never move.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import {
  ROZO_INTENTS_BASE,
  intentsReadBase,
  isIntentsPaymentNotFound,
  resetIntentsReadBaseWarning,
} from '../src/routes/intents-base'
import { lookupIntentsOrder } from '../src/routes/existing-order'
import { fetchRozoPaymentById, reportDeliveredToRozo } from '../src/routes/webhook'
import { handleCreateInvoice } from '../src/routes/create-invoice'

const OLD = 'https://intentapiv4.rozo.ai/functions/v1/payment-api'
const READ = 'https://intentapiv4.rozo.ai/functions/v1/payment-read'
const READ_DIRECT = 'https://aozudqtlykbhzbuzalzz.supabase.co/functions/v1/payment-read'

// Real bodies (probed 2026-10-15): intents' own not-found (rozo-intents-api
// payment-api/payment-response.ts errorResponse('paymentNotFound', ...)) and
// the Supabase platform 404 for a function that is not deployed.
const intentsNotFound = () =>
  new Response(
    JSON.stringify({ error: { code: 'paymentNotFound', message: 'Payment not found' }, requestId: 'r1' }),
    { status: 404 },
  )
const platformNotFound = () =>
  new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }), {
    status: 404,
  })
const htmlNotFound = () => new Response('<html>Not Found</html>', { status: 404 })

type Call = { url: string; method: string }

function urlOf(input: any): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function record(reply: (url: string, method: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    return reply(url, method)
  }) as typeof fetch)
  return calls
}

afterEach(() => vi.restoreAllMocks())

const baseEnv = (extra: Record<string, string> = {}) =>
  ({ ROZO_INTENTS_API_KEY: 'test-key', ...extra }) as unknown as Env

describe('intentsReadBase', () => {
  it('defaults to payment-api (unset, empty, whitespace)', () => {
    expect(ROZO_INTENTS_BASE).toBe(OLD)
    expect(intentsReadBase(baseEnv())).toBe(OLD)
    expect(intentsReadBase(baseEnv({ ROZO_INTENTS_READ_BASE: '' }))).toBe(OLD)
    expect(intentsReadBase(baseEnv({ ROZO_INTENTS_READ_BASE: '   ' }))).toBe(OLD)
    expect(intentsReadBase(undefined)).toBe(OLD)
  })
  it('uses the override, trimmed and without a trailing slash', () => {
    expect(intentsReadBase(baseEnv({ ROZO_INTENTS_READ_BASE: ` ${READ}/ ` }))).toBe(READ)
  })
  it('honors the direct supabase.co host of the intents project', () => {
    expect(intentsReadBase(baseEnv({ ROZO_INTENTS_READ_BASE: READ_DIRECT }))).toBe(READ_DIRECT)
  })
  it('ignores a non-intents host (falls back to payment-api) and warns once', () => {
    resetIntentsReadBaseWarning()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [
      'https://evil.example/functions/v1/payment-read',
      'http://intentapiv4.rozo.ai/functions/v1/payment-read',
      'https://intentapiv4.rozo.ai.evil.example/functions/v1/payment-read',
      'https://other.supabase.co/functions/v1/payment-read',
      'intentapiv4.rozo.ai/functions/v1/payment-read',
    ]) {
      expect(intentsReadBase(baseEnv({ ROZO_INTENTS_READ_BASE: bad }))).toBe(OLD)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('ROZO_INTENTS_READ_BASE ignored')
  })
  it('a rejected override never receives the API key', async () => {
    resetIntentsReadBaseWarning()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = record(() => intentsNotFound())
    await lookupIntentsOrder(baseEnv({ ROZO_INTENTS_READ_BASE: 'https://evil.example/x' }), 'a', 'b')
    expect(calls.map((c) => c.url)).toEqual([`${OLD}/payments/order/a/b`])
  })
})

describe('isIntentsPaymentNotFound', () => {
  it('only the intents paymentNotFound body counts', async () => {
    expect(await isIntentsPaymentNotFound(intentsNotFound())).toBe(true)
    expect(await isIntentsPaymentNotFound(platformNotFound())).toBe(false)
    expect(await isIntentsPaymentNotFound(htmlNotFound())).toBe(false)
    expect(await isIntentsPaymentNotFound(new Response('{}', { status: 404 }))).toBe(false)
    expect(
      await isIntentsPaymentNotFound(
        new Response(JSON.stringify({ error: { code: 'paymentNotFound' } }), { status: 500 }),
      ),
    ).toBe(false)
  })
})

describe('existing-order.ts lookupIntentsOrder (GET /payments/order/...)', () => {
  const reply = () => intentsNotFound()
  for (const [label, extra] of [
    ['switch set', { ROZO_INTENTS_READ_BASE: READ }],
    ['switch unset', {}],
  ] as const) {
    it(`${label}: intents paymentNotFound 404 -> missing`, async () => {
      record(() => intentsNotFound())
      expect(await lookupIntentsOrder(baseEnv(extra), 'merchant_openrouter', 'pl_abc')).toEqual({ state: 'missing' })
    })
    it(`${label}: platform 404 (function not deployed) -> error, not missing`, async () => {
      record(() => platformNotFound())
      expect(await lookupIntentsOrder(baseEnv(extra), 'merchant_openrouter', 'pl_abc')).toEqual({
        state: 'error',
        status: 404,
      })
    })
    it(`${label}: non-JSON 404 -> error, not missing`, async () => {
      record(() => htmlNotFound())
      expect(await lookupIntentsOrder(baseEnv(extra), 'merchant_openrouter', 'pl_abc')).toEqual({
        state: 'error',
        status: 404,
      })
    })
  }
  it('switch set: GET goes to the read base', async () => {
    const calls = record(reply)
    await lookupIntentsOrder(baseEnv({ ROZO_INTENTS_READ_BASE: READ }), 'merchant_openrouter', 'pl_abc')
    expect(calls).toEqual([{ url: `${READ}/payments/order/merchant_openrouter/pl_abc`, method: 'GET' }])
  })
  it('switch unset: byte-identical payment-api URL', async () => {
    const calls = record(reply)
    await lookupIntentsOrder(baseEnv(), 'merchant_openrouter', 'pl_abc')
    expect(calls).toEqual([{ url: `${OLD}/payments/order/merchant_openrouter/pl_abc`, method: 'GET' }])
  })
})

describe('webhook.ts fetchRozoPaymentById (GET /payments/:id, invoice-status and sweep)', () => {
  const reply = () => new Response('{}', { status: 200 })
  it('switch set: GET goes to the read base', async () => {
    const calls = record(reply)
    await fetchRozoPaymentById(baseEnv({ ROZO_INTENTS_READ_BASE: READ }), 'rozo-1')
    expect(calls).toEqual([{ url: `${READ}/payments/rozo-1`, method: 'GET' }])
  })
  it('switch unset: byte-identical payment-api URL', async () => {
    const calls = record(reply)
    await fetchRozoPaymentById(baseEnv(), 'rozo-1')
    expect(calls).toEqual([{ url: `${OLD}/payments/rozo-1`, method: 'GET' }])
  })
  it('POST /payments/:id/delivered stays on payment-api with the switch set', async () => {
    const calls = record(() => new Response('{}', { status: 200 }))
    await reportDeliveredToRozo(
      baseEnv({ ROZO_INTENTS_READ_BASE: READ, ROZO_DELIVERED_REPORT_ENABLED: 'true' }),
      'rozo-1',
      'pl_abc',
    )
    expect(calls).toEqual([{ url: `${OLD}/payments/rozo-1/delivered`, method: 'POST' }])
  })
})

// create-invoice.ts: Coinbase link with an existing unpaid order on another
// source => POST /payments/:id/checkout (rotation, a write) fails with a
// non-status error => refetchPaymentRow GET /payments/:id (a read).
describe('create-invoice.ts rotation + refetchPaymentRow', () => {
  const existing = {
    id: 'rozo-existing-rb',
    status: 'payment_unpaid',
    paymentLink: 'https://pay.rozo.ai/existing',
    expiresAt: '2999-01-01T00:00:00.000Z',
    source: { chainId: '1500', tokenSymbol: 'USDC', amount: '105' },
  }

  async function run(extra: Record<string, string>) {
    const calls = record((u, method) => {
      if (u.includes('/quote-invoice')) {
        return new Response(
          JSON.stringify({ invoice: { amount: '105' }, merchant: 'OpenRouter, Inc.', linkId: 'pl_test123' }),
          { status: 200 },
        )
      }
      if (u.includes('/payments/order/')) return new Response(JSON.stringify(existing), { status: 200 })
      if (u.includes('/checkout')) return new Response('upstream exploded', { status: 500 })
      if (method === 'GET' && u.endsWith(`/payments/${existing.id}`)) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ id: 'rozo-new' }), { status: 200 })
    })
    const res = await handleCreateInvoice(
      new Request('https://mpp.test/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payment_id: 'pl_test123', source: { chainId: '900', tokenSymbol: 'USDT' } }),
      }),
      { PAYINVOICE_ADMIN_SECRET: 'test-admin-secret', ROZO_INTENTS_API_KEY: 'test-key', ...extra } as unknown as Env,
    )
    expect(res.status).toBe(502)
    return calls.filter((c) => c.url.includes('intentapiv4.rozo.ai'))
  }

  it('switch set: order lookup and refetch GET use the read base; checkout POST stays on payment-api', async () => {
    const calls = await run({ ROZO_INTENTS_READ_BASE: READ })
    const refetch = calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/payments/${existing.id}`))
    expect(refetch).toEqual([{ url: `${READ}/payments/${existing.id}`, method: 'GET' }])
    const lookups = calls.filter((c) => c.url.includes('/payments/order/'))
    expect(lookups.length).toBeGreaterThan(0)
    for (const l of lookups) {
      expect(l.method).toBe('GET')
      expect(l.url.startsWith(`${READ}/payments/order/`)).toBe(true)
    }
    const checkout = calls.filter((c) => c.url.includes('/checkout'))
    expect(checkout).toEqual([{ url: `${OLD}/payments/${existing.id}/checkout`, method: 'POST' }])
    // No non-GET ever goes to the read base.
    expect(calls.filter((c) => c.url.startsWith(READ) && c.method !== 'GET')).toEqual([])
  })

  it('switch unset: every intents URL is byte-identical to payment-api', async () => {
    const calls = await run({})
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.url.startsWith(`${OLD}/`)).toBe(true)
    expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith(`/payments/${existing.id}`))).toEqual([
      { url: `${OLD}/payments/${existing.id}`, method: 'GET' },
    ])
    expect(calls.filter((c) => c.url.includes('/checkout'))).toEqual([
      { url: `${OLD}/payments/${existing.id}/checkout`, method: 'POST' },
    ])
  })
})

// bitrefill-invoice.ts: duplicate-invoice lookup GET /payments/order/...,
// then the create POST (a write) to payment-api.
describe('bitrefill-invoice.ts lookupExisting', () => {
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
  async function run(extra: Record<string, string>, notFound: () => Response = intentsNotFound, expectStatus = 200) {
    const store = new Map<string, string>()
    const calls = record((u, method) => {
      if (u.includes('/payments/order/')) return notFound()
      if (method === 'POST') {
        return new Response(JSON.stringify({
          id: 'rozo-pay-bitrefill',
          paymentLink: 'https://pay.rozo.ai/b',
          expiresAt: '2999-01-01T12:00:00.000Z',
          source: { amount: '12.37', chainId: '1500' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const env = {
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
    const res = await handleCreateInvoice(
      new Request('https://mpp.test/v1/services/rozo-agent-api/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'bitrefill',
          bitrefill: {
            invoiceId: 'inv-readbase1',
            address: '0x1111111111111111111111111111111111111111',
            amount: '12.345678',
            expiresAt: inMinutes(15),
          },
          source: { chainId: '1500', tokenSymbol: 'USDC' },
        }),
      }),
      env,
    )
    expect(res.status).toBe(expectStatus)
    return calls.filter((c) => c.url.includes('intentapiv4.rozo.ai'))
  }

  for (const [label, extra] of [
    ['switch set', { ROZO_INTENTS_READ_BASE: READ }],
    ['switch unset', {}],
  ] as const) {
    it(`${label}: platform 404 on the lookup -> 502, no create POST (no duplicate)`, async () => {
      const calls = await run(extra, platformNotFound, 502)
      expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    })
    it(`${label}: non-JSON 404 on the lookup -> 502, no create POST`, async () => {
      const calls = await run(extra, htmlNotFound, 502)
      expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    })
    it(`${label}: intents paymentNotFound 404 -> creates exactly once`, async () => {
      const calls = await run(extra)
      expect(calls.filter((c) => c.method === 'POST').length).toBe(1)
    })
  }

  it('switch set: lookup GET uses the read base; create POST stays on payment-api', async () => {
    const calls = await run({ ROZO_INTENTS_READ_BASE: READ })
    const lookups = calls.filter((c) => c.url.includes('/payments/order/'))
    expect(lookups.length).toBeGreaterThan(0)
    for (const l of lookups) {
      expect(l.method).toBe('GET')
      expect(l.url.startsWith(`${READ}/payments/order/`)).toBe(true)
    }
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.length).toBe(1)
    expect(posts[0].url).toBe(`${OLD}/`)
  })

  it('switch unset: byte-identical payment-api lookup URL', async () => {
    const calls = await run({})
    const lookups = calls.filter((c) => c.url.includes('/payments/order/'))
    expect(lookups.length).toBeGreaterThan(0)
    for (const l of lookups) expect(l.url.startsWith(`${OLD}/payments/order/`)).toBe(true)
  })
})

// create-invoice (Coinbase): a platform 404 on the order-slot scan must not be
// read as "no existing order" (that would create a duplicate order).
describe('create-invoice.ts order lookup 404 classification', () => {
  async function run(extra: Record<string, string>, notFound: () => Response) {
    const calls = record((u) => {
      if (u.includes('/quote-invoice')) {
        return new Response(
          JSON.stringify({ invoice: { amount: '105' }, merchant: 'OpenRouter, Inc.', linkId: 'pl_test404' }),
          { status: 200 },
        )
      }
      if (u.includes('/payments/order/')) return notFound()
      return new Response(JSON.stringify({ id: 'rozo-new', paymentLink: 'https://pay.rozo.ai/n', expiresAt: '2999-01-01T00:00:00.000Z', source: { amount: '105', chainId: '1500' } }), { status: 200 })
    })
    const res = await handleCreateInvoice(
      new Request('https://mpp.test/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payment_id: 'pl_test404', source: { chainId: '1500', tokenSymbol: 'USDC' } }),
      }),
      { PAYINVOICE_ADMIN_SECRET: 'test-admin-secret', ROZO_INTENTS_API_KEY: 'test-key', ...extra } as unknown as Env,
    )
    const creates = calls.filter((c) => c.method === 'POST' && c.url === `${OLD}/`)
    return { status: res.status, json: JSON.parse(await res.text()), creates: creates.length }
  }

  for (const [label, extra] of [
    ['switch set', { ROZO_INTENTS_READ_BASE: READ }],
    ['switch unset', {}],
  ] as const) {
    it(`${label}: platform 404 -> 502 INTENTS_API_FAILED, no create`, async () => {
      const r = await run(extra, platformNotFound)
      expect(r.status).toBe(502)
      expect(r.json.code).toBe('INTENTS_API_FAILED')
      expect(r.creates).toBe(0)
    })
    it(`${label}: intents paymentNotFound 404 -> slot free, creates once`, async () => {
      const r = await run(extra, intentsNotFound)
      expect(r.status).toBe(200)
      expect(r.creates).toBe(1)
    })
  }
})

// Guard: a future read must not bypass the switch. Every `${ROZO_INTENTS_BASE}/payments/`
// URL in src/routes must be a write (its fetch options say method: 'POST');
// read-only GETs go through intentsReadBase(env).
describe('source guard: no direct ROZO_INTENTS_BASE GET for /payments/', () => {
  it('every ROZO_INTENTS_BASE /payments/ fetch in src/routes is a POST', () => {
    const dir = join(__dirname, '..', 'src', 'routes')
    const needle = '${ROZO_INTENTS_BASE}/payments/'
    let seen = 0
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8')
      let i = src.indexOf(needle)
      while (i !== -1) {
        seen++
        // The options object follows the URL template within the same call.
        const window = src.slice(i, i + 300)
        expect(window, `${f}: ROZO_INTENTS_BASE /payments/ fetch must be a POST`).toMatch(/method:\s*'POST'/)
        i = src.indexOf(needle, i + needle.length)
      }
    }
    // /checkout (create-invoice.ts) and /delivered (webhook.ts) today.
    expect(seen).toBe(2)
  })
})
