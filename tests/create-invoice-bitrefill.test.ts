import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { BITREFILL_MAX_USDC, isBitrefillOrderId } from '../src/routes/bitrefill-invoice'
import type { Env } from '../src/index'

const ADDR = '0x1111111111111111111111111111111111111111'

function makeEnv(extra: Record<string, string> = {}): Env {
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

let createdIntent: any = null
let posts = 0
let existingOrder: any = null
let seenKeys: string[] = []
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

beforeEach(() => {
  createdIntent = null
  posts = 0
  existingOrder = null
  seenKeys = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    seenKeys.push(new Headers(init?.headers).get('X-API-Key') ?? '')
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/payments/order/')) {
      return existingOrder
        ? new Response(JSON.stringify(existingOrder), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      posts++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({
        id: 'rozo-pay-bitrefill',
        paymentLink: 'https://pay.rozo.ai/b',
        expiresAt: '2999-01-01T12:00:00.000Z',
        source: { amount: '12.37', chainId: '1500' },
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

function body(over: Record<string, unknown> = {}, br: Record<string, unknown> = {}) {
  return {
    provider: 'bitrefill',
    bitrefill: { invoiceId: 'inv-abc123', address: ADDR, amount: '12.345678', expiresAt: inMinutes(15), ...br },
    source: { chainId: '1500', tokenSymbol: 'USDC' },
    ...over,
  }
}

async function post(b: unknown, env = makeEnv()) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/v1/services/rozo-agent-api/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

describe('create-invoice provider=bitrefill', () => {
  it('forwards an optional contact email and rejects an invalid one', async () => {
    const ok = await post(body({ email: 'Buyer@Example.com' }))
    expect(ok.status).toBe(200)
    expect(createdIntent.email).toBe('buyer@example.com')

    createdIntent = null
    const none = await post(body())
    expect(none.status).toBe(200)
    expect('email' in createdIntent).toBe(false)

    createdIntent = null
    const bad = await post(body({ email: 'buyer-at-example' }))
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('INVALID_EMAIL')
    expect(createdIntent).toBeNull()
  })

  it('creates an exactOut intent straight to the Bitrefill address', async () => {
    const { status, json } = await post(body({ client: 'rozo-checkout' }))
    expect(status).toBe(200)
    expect(json).toMatchObject({
      ok: true,
      provider: 'bitrefill',
      invoiceId: 'inv-abc123',
      rozoPaymentId: 'rozo-pay-bitrefill',
      destination: { chainId: '8453', tokenSymbol: 'USDC', address: ADDR, amount: '12.345678' },
    })
    expect(createdIntent).toMatchObject({
      appId: 'wallet_bitrefillpay',
      orderId: 'bitrefill_inv-abc123',
      type: 'exactOut',
      source: { chainId: '1500', tokenSymbol: 'USDC' },
      destination: {
        chainId: '8453',
        receiverAddress: ADDR,
        tokenSymbol: 'USDC',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '12.345678',
      },
      metadata: { source: 'mpprouter-create-invoice', provider: 'bitrefill', bitrefillInvoiceId: 'inv-abc123' },
    })
    expect(createdIntent.source.amount).toBeUndefined()
    expect(json.paymentLink).toBeUndefined()
    expect(JSON.stringify(json)).not.toContain('pay.rozo.ai')
    expect(json.source).toMatchObject({ amount: '12.37', chainId: '1500' })
    expect(typeof createdIntent.metadata.bitrefillExpiresAt).toBe('string')
    expect(seenKeys.length).toBeGreaterThan(0)
    expect(seenKeys.every((k) => k === 'bitrefill-key')).toBe(true)
  })

  it('returns the earlier of Bitrefill and Rozo expiry', async () => {
    const exp = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const { status, json } = await post(body({}, { expiresAt: exp }))
    expect(status).toBe(200)
    expect(json.expiresAt).toBe(exp)
  })

  it('is off by default (flag unset or false)', async () => {
    for (const env of [makeEnv({ BITREFILL_ENABLED: 'false' }), makeEnv({ BITREFILL_ENABLED: undefined as any })]) {
      const { status, json } = await post(body(), env)
      expect(status).toBe(403)
      expect(json).toMatchObject({ ok: false, error: 'BITREFILL_DISABLED' })
    }
    expect(posts).toBe(0)
  })

  it.each([
    [{ address: '0x123' }, 'INVALID_ADDRESS'],
    [{ address: 'not-an-address' }, 'INVALID_ADDRESS'],
    [{ address: '0x0000000000000000000000000000000000000000' }, 'BLOCKED_ADDRESS'],
    [{ address: '0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897' }, 'BLOCKED_ADDRESS'],
    [{ address: '0xf621ee3bae3cbe924ec05f795d14e31384bd11b6' }, 'BLOCKED_ADDRESS'],
    [{ amount: '0' }, 'INVALID_AMOUNT'],
    [{ amount: '-1' }, 'INVALID_AMOUNT'],
    [{ amount: '1.1234567' }, 'INVALID_AMOUNT'],
    [{ amount: 5 }, 'INVALID_AMOUNT'],
    [{ amount: String(BITREFILL_MAX_USDC + 0.01) }, 'AMOUNT_OUT_OF_RANGE'],
    [{ address: '0x8fe7155119d2975780c9e19b07dd98393965bc2a' }, 'BLOCKED_ADDRESS'],
    [{ address: '0xFD0E6FA2ABA8436E95F3FB3523AC14BA299C0E79' }, 'BLOCKED_ADDRESS'],
    [{ expiresAt: inMinutes(1) }, 'INVOICE_EXPIRING'],
    [{ expiresAt: inMinutes(45) }, 'INVALID_INPUT'],
    [{ expiresAt: undefined }, 'INVALID_INPUT'],
    [{ expiresAt: 'soon' }, 'INVALID_INPUT'],
    [{ invoiceId: '../etc' }, 'INVALID_INPUT'],
  ])('rejects %j with %s', async (br, code) => {
    const { status, json } = await post(body({}, br))
    expect(status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: code })
    expect(posts).toBe(0)
  })

  it('accepts a mixed-case (checksum-insensitive) address and the max amount', async () => {
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    const { status } = await post(body({}, { address: mixed, amount: String(BITREFILL_MAX_USDC) }))
    expect(status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(mixed)
  })

  it('503 BITREFILL_NOT_CONFIGURED without its own key (no OpenRouter fallback)', async () => {
    const { status, json } = await post(body(), makeEnv({ ROZO_BITREFILL_API_KEY: '' }))
    expect(status).toBe(503)
    expect(json.error).toBe('BITREFILL_NOT_CONFIGURED')
    expect(seenKeys).toEqual([])
  })

  it('applies NATIVE_MAX_USD to native sources', async () => {
    const env = makeEnv({ NATIVE_SOURCES: 'ETH@8453', NATIVE_MAX_USD: '50' })
    const over = await post(body({ source: { chainId: '8453', tokenSymbol: 'ETH' } }, { amount: '60' }), env)
    expect(over.status).toBe(400)
    expect(over.json.error).toBe('AMOUNT_OUT_OF_RANGE')
    const under = await post(body({ source: { chainId: '8453', tokenSymbol: 'ETH' } }, { amount: '40' }), env)
    expect(under.status).toBe(200)
  })

  it('400 UNSUPPORTED_SOURCE (not 502) when payment-api has native disabled for Bitrefill', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('nf', { status: 404 })
      posts++
      return new Response(JSON.stringify({
        error: { code: 'invalidRequest', message: 'Native ETH payin on chain 8453 is not enabled for this app' },
      }), { status: 400 })
    }) as typeof fetch)
    const env = makeEnv({ NATIVE_SOURCES: 'ETH@8453' })
    const { status, json } = await post(body({ source: { chainId: '8453', tokenSymbol: 'ETH' } }, { amount: '10' }), env)
    expect(status).toBe(400)
    expect(json.error).toBe('UNSUPPORTED_SOURCE')
    expect(json.message).toMatch(/Native ETH on chainId 8453 is not available for Bitrefill/)
    expect(json.upstream_message).toBe('Native ETH payin on chain 8453 is not enabled for this app')
  })

  it('maps any other payment-api 400 to 400 INTENTS_API_REJECTED, keeps 5xx as 502', async () => {
    let upstreamStatus = 400
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('nf', { status: 404 })
      return new Response(JSON.stringify({ error: { code: 'invalidRequest', message: 'bad amount' } }), { status: upstreamStatus })
    }) as typeof fetch)
    const rejected = await post(body())
    expect(rejected.status).toBe(400)
    expect(rejected.json.error).toBe('INTENTS_API_REJECTED')
    expect(rejected.json.message).toBe('bad amount')
    upstreamStatus = 500
    const down = await post(body())
    expect(down.status).toBe(502)
    expect(down.json.error).toBe('INTENTS_API_FAILED')
  })

  it('keeps operational payment-api 400s as 502; native amount limits are AMOUNT_OUT_OF_RANGE', async () => {
    let reply = { code: 'insufficientLiquidity', message: 'Liquidity check unavailable' }
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('nf', { status: 404 })
      return new Response(JSON.stringify({ error: reply }), { status: 400 })
    }) as typeof fetch)
    const outage = await post(body())
    expect(outage.status).toBe(502)
    expect(outage.json.error).toBe('INTENTS_API_FAILED')
    expect(outage.json.upstream_status).toBe(400)
    expect(outage.json.upstream_code).toBe('insufficientLiquidity')
    expect(outage.json.message).not.toContain('Liquidity check unavailable')
    reply = { code: 'providerError', message: 'quote failed' }
    expect((await post(body())).status).toBe(502)
    // Non-JSON 400 body: no classification possible, stays 502.
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('nf', { status: 404 })
      return new Response('Bad Request', { status: 400 })
    }) as typeof fetch)
    expect((await post(body())).status).toBe(502)
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('nf', { status: 404 })
      return new Response(JSON.stringify({ error: { code: 'amountTooLow', message: 'Minimum is $1 for ETH' } }), { status: 400 })
    }) as typeof fetch)
    const low = await post(body({ source: { chainId: '8453', tokenSymbol: 'ETH' } }, { amount: '0.5' }), makeEnv({ NATIVE_SOURCES: 'ETH@8453' }))
    expect(low.status).toBe(400)
    expect(low.json.error).toBe('AMOUNT_OUT_OF_RANGE')
    expect(low.json.message).toBe('Minimum is $1 for ETH')
  })

  it('503 RETRY_LATER when the race winner has no id yet', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) {
        return posts ? new Response('{}', { status: 200 }) : new Response('nf', { status: 404 })
      }
      posts++
      return new Response('{"error":"orderIdConflict"}', { status: 409 })
    }) as typeof fetch)
    const { status, json } = await post(body())
    expect(status).toBe(503)
    expect(json.error).toBe('RETRY_LATER')
  })

  it('rejects unsupported sources', async () => {
    const { status, json } = await post(body({ source: { chainId: '1500', tokenSymbol: 'DOGE' } }))
    expect(status).toBe(400)
    expect(json.error).toBe('UNSUPPORTED_SOURCE')
    expect(posts).toBe(0)
  })

  it('returns 409 DUPLICATE_INVOICE with the existing payment id', async () => {
    existingOrder = { id: 'rozo-existing', expiresAt: '2999-01-01T00:00:00.000Z' }
    const { status, json } = await post(body())
    expect(status).toBe(409)
    expect(json).toMatchObject({ ok: false, error: 'DUPLICATE_INVOICE', rozoPaymentId: 'rozo-existing' })
    expect(json.paymentLink).toBeUndefined()
    expect(posts).toBe(0)
  })

  it('tags orderIds so the webhook skips router settlement', () => {
    expect(isBitrefillOrderId('bitrefill_inv-abc123')).toBe(true)
    expect(isBitrefillOrderId('pl_abc')).toBe(false)
  })
})
