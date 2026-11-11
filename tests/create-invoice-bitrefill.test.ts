import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import {
  BITREFILL_FEE_BPS,
  BITREFILL_MAX_USDC,
  bitrefillPricingFromOrder,
  isBitrefillOrderId,
  maxBitrefillFeeAtomic,
} from '../src/routes/bitrefill-invoice'
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
let rozoExpiresAt = '2999-01-01T12:00:00.000Z'
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
// Mirrors payment-api quotePartnerFee for exactOut: ceil to 4 dp.
const ceil4 = (v: number) => Math.ceil((v - 0.00000001) * 10000) / 10000
let upstreamSourceOverride: Record<string, unknown> | null = null

beforeEach(() => {
  createdIntent = null
  posts = 0
  existingOrder = null
  seenKeys = []
  rozoExpiresAt = '2999-01-01T12:00:00.000Z'
  upstreamSourceOverride = null
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    seenKeys.push(new Headers(init?.headers).get('X-API-Key') ?? '')
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/payments/order/')) {
      return existingOrder
        ? new Response(JSON.stringify(existingOrder), { status: 200 })
        : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      posts++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      const bps = createdIntent.partnerFeeBps
      const fee = ceil4((Number(createdIntent.destination?.amount) * bps) / 10000)
      return new Response(JSON.stringify({
        id: 'rozo-pay-bitrefill',
        paymentLink: 'https://pay.rozo.ai/b',
        expiresAt: rozoExpiresAt,
        source: {
          amount: '12.37', chainId: '1500', fee: '0.02',
          partnerFee: fee.toFixed(4), partnerFeeBps: bps,
          ...(upstreamSourceOverride ?? {}),
        },
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

  it.each([6, 15, 45, 59, 60])('accepts a Bitrefill invoice with %i minutes left', async (m) => {
    const exp = inMinutes(m)
    const { status, json } = await post(body({}, { expiresAt: exp }))
    expect(status).toBe(200)
    expect(json.expiresAt).toBe(exp)
    expect(posts).toBe(1)
  })

  it('returns the Rozo deposit expiry when it is earlier than Bitrefill\'s', async () => {
    rozoExpiresAt = inMinutes(58)
    const { status, json } = await post(body({}, { expiresAt: inMinutes(60) }))
    expect(status).toBe(200)
    expect(json.expiresAt).toBe(rozoExpiresAt)
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
    [{ amount: '1050.000001' }, 'AMOUNT_OUT_OF_RANGE'],
    [{ amount: '1051' }, 'AMOUNT_OUT_OF_RANGE'],
    [{ address: '0x8fe7155119d2975780c9e19b07dd98393965bc2a' }, 'BLOCKED_ADDRESS'],
    [{ address: '0xFD0E6FA2ABA8436E95F3FB3523AC14BA299C0E79' }, 'BLOCKED_ADDRESS'],
    [{ expiresAt: inMinutes(1) }, 'INVOICE_EXPIRING'],
    [{ expiresAt: inMinutes(4) }, 'INVOICE_EXPIRING'],
    [{ expiresAt: inMinutes(61.5) }, 'INVALID_INPUT'],
    [{ expiresAt: inMinutes(90) }, 'INVALID_INPUT'],
    [{ expiresAt: undefined }, 'INVALID_INPUT'],
    [{ expiresAt: 'soon' }, 'INVALID_INPUT'],
    [{ invoiceId: '../etc' }, 'INVALID_INPUT'],
  ])('rejects %j with %s', async (br, code) => {
    const { status, json } = await post(body({}, br))
    expect(status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: code })
    expect(posts).toBe(0)
  })

  it('caps the invoice amount at 1050 USDC (founder 2026-11-11)', async () => {
    expect(BITREFILL_MAX_USDC).toBe(1050)
    const atCap = await post(body({}, { amount: '1050' }))
    expect(atCap.status).toBe(200)
    expect(createdIntent.destination.amount).toBe('1050')
    expect(createdIntent.type).toBe('exactOut')
    const over = await post(body({}, { amount: '1050.000001' }))
    expect(over.status).toBe(400)
    expect(over.json.error).toBe('AMOUNT_OUT_OF_RANGE')
    expect(over.json.message).toContain('1050')
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

  it('refuses native coin and Lightning sources before any upstream call (no partner fee there)', async () => {
    const env = makeEnv({ NATIVE_SOURCES: 'ETH@8453' })
    const native = await post(body({ source: { chainId: '8453', tokenSymbol: 'ETH' } }, { amount: '40' }), env)
    expect(native.status).toBe(400)
    expect(native.json.error).toBe('UNSUPPORTED_SOURCE')
    const ln = await post(body({ source: { chainId: 'lightning', tokenSymbol: 'BTC' } }, { amount: '40' }), env)
    expect(ln.status).toBe(400)
    expect(ln.json.error).toBe('UNSUPPORTED_SOURCE')
    expect(posts).toBe(0)
    expect(seenKeys).toEqual([])
  })

  it('maps any other payment-api 400 to 400 INTENTS_API_REJECTED, keeps 5xx as 502', async () => {
    let upstreamStatus = 400
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
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
      if (u.includes('/payments/order/')) return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
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
      if (u.includes('/payments/order/')) return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
      return new Response('Bad Request', { status: 400 })
    }) as typeof fetch)
    expect((await post(body())).status).toBe(502)
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) return new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
      return new Response(JSON.stringify({ error: { code: 'amountTooLow', message: 'Minimum is $1 for ETH' } }), { status: 400 })
    }) as typeof fetch)
    const low = await post(body({}, { amount: '0.5' }))
    expect(low.status).toBe(400)
    expect(low.json.error).toBe('AMOUNT_OUT_OF_RANGE')
    expect(low.json.message).toBe('Minimum is $1 for ETH')
  })

  it('503 RETRY_LATER when the race winner has no id yet', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input.url
      if (u.includes('/payments/order/')) {
        return posts ? new Response('{}', { status: 200 }) : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
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

  it('409 DUPLICATE_INVOICE reports the earlier of the stored Bitrefill and Rozo expiry', async () => {
    const bitrefillExp = inMinutes(60)
    const rozoExp = inMinutes(55)
    existingOrder = { id: 'rozo-existing', expiresAt: rozoExp, metadata: { bitrefillExpiresAt: bitrefillExp } }
    let r = await post(body())
    expect(r.status).toBe(409)
    expect(r.json.expiresAt).toBe(rozoExp)
    existingOrder = { id: 'rozo-existing', expiresAt: inMinutes(65), metadata: { bitrefillExpiresAt: bitrefillExp } }
    r = await post(body())
    expect(r.json.expiresAt).toBe(bitrefillExp)
  })

  describe('service fee (1%)', () => {
    it('sends partnerFeeBps 100 and returns original / serviceFee / feeBps / callerPays from payment-api', async () => {
      const { status, json } = await post(body({}, { amount: '204' }))
      expect(status).toBe(200)
      expect(BITREFILL_FEE_BPS).toBe(100)
      expect(createdIntent.partnerFeeBps).toBe(100)
      expect(createdIntent.type).toBe('exactOut')
      // Bitrefill still receives exactly the invoice amount.
      expect(createdIntent.destination.amount).toBe('204')
      expect(json.destination.amount).toBe('204')
      expect(json).toMatchObject({ original: '204', serviceFee: '2.04', feeBps: 100, callerPays: '206.04' })
    })

    it('copies the 4 dp fee payment-api rounds up (not a cent rounding)', async () => {
      const { json } = await post(body({}, { amount: '204.37' }))
      expect(json).toMatchObject({ original: '204.37', serviceFee: '2.0437', callerPays: '206.4137' })
      const six = await post(body({}, { amount: '12.345678' }))
      expect(six.json).toMatchObject({ serviceFee: '0.1235', callerPays: '12.469178' })
    })

    it('fee at the 1050 cap', async () => {
      const { json } = await post(body({}, { amount: '1050' }))
      expect(json).toMatchObject({ original: '1050', serviceFee: '10.5', feeBps: 100, callerPays: '1060.5' })
    })

    it.each([
      [{ partnerFeeBps: 50 }],
      [{ partnerFeeBps: undefined, partnerFee: undefined }],
      [{ partnerFee: '0.0000' }],
      [{ partnerFee: '9.9999' }],
      [{ partnerFee: 'abc' }],
      [{ partnerFeeBps: 1000, partnerFee: '20.40' }],
    ])('502 FEE_MISMATCH, no deposit, when payment-api priced it differently: %j', async (over) => {
      upstreamSourceOverride = over
      const { status, json } = await post(body({}, { amount: '204' }))
      expect(status).toBe(502)
      expect(json.error).toBe('FEE_MISMATCH')
      expect(json.source).toBeUndefined()
      expect(json.callerPays).toBeUndefined()
    })

    it('duplicate reports the existing order fee as frozen upstream', async () => {
      existingOrder = {
        id: 'rozo-existing', expiresAt: '2999-01-01T00:00:00.000Z',
        destination: { amount: '204.000000' },
        source: { amount: '206.1', partnerFee: '2.0400', partnerFeeBps: 100 },
      }
      const { status, json } = await post(body({}, { amount: '204' }))
      expect(status).toBe(409)
      expect(json).toMatchObject({ error: 'DUPLICATE_INVOICE', rozoPaymentId: 'rozo-existing', original: '204', serviceFee: '2.04', feeBps: 100, callerPays: '206.04' })
      expect(posts).toBe(0)
    })

    it('duplicate of a pre-fee order reports a zero fee; corrupt fee data is not resumable', async () => {
      existingOrder = { id: 'rozo-old', expiresAt: '2999-01-01T00:00:00.000Z', destination: { amount: '50' }, source: { amount: '50.2' } }
      let r = await post(body({}, { amount: '50' }))
      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({ serviceFee: '0', feeBps: 0, callerPays: '50' })
      existingOrder = { id: 'rozo-bad', destination: { amount: '50' }, source: { partnerFee: '5.0000', partnerFeeBps: 100 } }
      r = await post(body({}, { amount: '50' }))
      expect(r.status).toBe(502)
      expect(r.json.error).toBe('FEE_MISMATCH')
      expect(r.json.source).toBeUndefined()
    })

    it('a create refused with FEE_MISMATCH cannot be resumed by retrying', async () => {
      upstreamSourceOverride = { partnerFeeBps: 50 }
      const first = await post(body({}, { amount: '204' }))
      expect(first.json.error).toBe('FEE_MISMATCH')
      expect(createdIntent.metadata.serviceFeeBps).toBe(100)
      for (const src of [
        { partnerFee: '1.0200', partnerFeeBps: 50 },
        { partnerFee: '0.0000', partnerFeeBps: 100 },
        {},
      ]) {
        existingOrder = { id: 'rozo-pay-bitrefill', destination: { amount: '204' }, source: src, metadata: { serviceFeeBps: 100 } }
        const retry = await post(body({}, { amount: '204' }))
        expect(retry.status).toBe(502)
        expect(retry.json.error).toBe('FEE_MISMATCH')
        expect(retry.json.source).toBeUndefined()
      }
    })

    it('a fee below what 1% produces is refused', async () => {
      upstreamSourceOverride = { partnerFee: '2.0300' }
      const { status, json } = await post(body({}, { amount: '204' }))
      expect(status).toBe(502)
      expect(json.error).toBe('FEE_MISMATCH')
    })

    it('maxBitrefillFeeAtomic / bitrefillPricingFromOrder arithmetic', () => {
      expect(maxBitrefillFeeAtomic(204_000_000n, 100)).toBe(2_040_000n)
      expect(maxBitrefillFeeAtomic(204_370_000n, 100)).toBe(2_043_700n)
      expect(maxBitrefillFeeAtomic(1_000_001n, 100)).toBe(10_100n)
      expect(maxBitrefillFeeAtomic(1n, 100)).toBe(100n)
      expect(bitrefillPricingFromOrder({ partnerFee: '0.0101', partnerFeeBps: 100 }, '1.000001')?.callerPays).toBe('1.010101')
      // payment-api's float epsilon can quote one 4dp step lower; still accepted.
      expect(bitrefillPricingFromOrder({ partnerFee: '0.0100', partnerFeeBps: 100 }, '1.000001')?.serviceFee).toBe('0.01')
      expect(bitrefillPricingFromOrder({ partnerFee: '0.0102', partnerFeeBps: 100 }, '1.000001')).toBeNull()
      expect(bitrefillPricingFromOrder({ partnerFee: '-1', partnerFeeBps: 100 }, '1')).toBeNull()
      expect(bitrefillPricingFromOrder({ partnerFee: '0.0099', partnerFeeBps: 100 }, '1.000001')).toBeNull()
    })
  })

  it('tags orderIds so the webhook skips router settlement', () => {
    expect(isBitrefillOrderId('bitrefill_inv-abc123')).toBe(true)
    expect(isBitrefillOrderId('pl_abc')).toBe(false)
  })
})
