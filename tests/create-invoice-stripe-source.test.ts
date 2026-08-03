/**
 * Stripe create-invoice honors the caller's `source` (pay-with chain/token).
 *
 * The Stripe branch used to return before `resolveSource()` ran, so a caller
 * asking to pay with e.g. Solana USDT had that silently dropped and was billed
 * on Base USDC instead — no error, no effect. These tests pin the fixed
 * behavior and, just as importantly, pin what must NOT change: the destination
 * is always Base USDC to the funder wallet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import type { Env } from '../src/index'

const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMTestBlob_ABC123xyz'
const SETTLEMENT_RECEIVER = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

function makeKvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  }
}

function makeDoStub() {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  const stub = {
    async fetch(req: Request) {
      const url = new URL(req.url)
      const b: any = await req.json()
      if (url.pathname === '/read') {
        return Response.json({
          value: store.get(b.key) ?? null,
          version: versions.get(b.key) ?? 0,
        })
      }
      const cur = versions.get(b.key) ?? 0
      if (cur !== b.expectedVersion) {
        return Response.json({ ok: false, value: store.get(b.key) ?? null, version: cur })
      }
      if (b.op === 'set') store.set(b.key, b.value)
      else store.delete(b.key)
      versions.set(b.key, b.expectedVersion + 1)
      return Response.json({ ok: true })
    },
  }
  return { idFromName: (n: string) => ({ name: n }), get: () => stub }
}

function makeEnv(): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: makeKvStub(),
    ATOMIC_STORE: makeDoStub(),
    INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
  } as unknown as Env
}

/** Captures the body POSTed to the Rozo intents API so we can assert on it. */
let createdIntent: any = null
/** When set, the idempotency lookup returns this instead of 404. */
let existingIntent: any = null

function installFetchMock() {
  createdIntent = null
  existingIntent = null
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/resume_payin_session')) {
      return new Response(
        JSON.stringify({
          sessionId: 'cpis_test123',
          clientSecret: 'cs_secret',
          publishableKey: 'pk_live_test',
          mode: 'pay',
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payin_session')) {
      return new Response(
        JSON.stringify({
          id: 'cpis_test123',
          state: 'checkout',
          business_name: 'Test Merchant',
          merchant: 'acct_test',
          payment_details: { amount: 1000, currency: 'usd' },
          supported_currencies: [
            {
              id: 'usdc.base',
              chain_id: 8453,
              currency_network: 'base',
              mainnet: true,
              asset_code: 'usdc',
              currency_minor_units: 6,
              contract_address: BASE_USDC.toLowerCase(),
              payment_options: ['wallet_connect'],
            },
          ],
          valid_before: '2999-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      return existingIntent
        ? new Response(JSON.stringify(existingIntent), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api')) {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({
          id: 'rozo-pay-1',
          paymentLink: 'https://pay.rozo.ai/x',
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

async function createInvoice(body: Record<string, unknown>) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    makeEnv(),
  )
  return { status: res.status, json: (await res.json()) as any }
}

beforeEach(() => {
  installFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Stripe create-invoice — source is honored, not swallowed', () => {
  it('creates the intent on the requested source (Solana USDT)', async () => {
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactIn')
    expect(createdIntent.source).toMatchObject({
      chainId: '900',
      tokenSymbol: 'USDT',
      tokenAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    })
    expect(json.source).toEqual({ chainId: '900', tokenSymbol: 'USDT' })
  })

  it('still defaults to Base USDC when no source is given', async () => {
    const { status, json } = await createInvoice({ url: STRIPE_URL })
    expect(status).toBe(200)
    expect(createdIntent.source).toMatchObject({ chainId: '8453', tokenSymbol: 'USDC' })
    expect(json.source).toEqual({ chainId: '8453', tokenSymbol: 'USDC' })
  })

  it('uses exactOut with a pinned destination amount for a Lightning source', async () => {
    const { status } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: 'lightning', tokenSymbol: 'BTC' },
    })
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.source).toEqual({ chainId: 'lightning', tokenSymbol: 'BTC' })
    // BTC price floats, so no source.amount — the destination pins what we get.
    expect(createdIntent.source.amount).toBeUndefined()
    expect(createdIntent.destination.amount).toBe('9.523809')
  })

  it('rejects an unsupported source explicitly instead of silently ignoring it', async () => {
    // Base has no USDT. Previously this was swallowed and billed as Base USDC.
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '8453', tokenSymbol: 'USDT' },
    })
    expect(status).toBe(400)
    expect(json.code).toBe('UNSUPPORTED_SOURCE')
    expect(json.supported_sources).toBeDefined()
    // Nothing was created upstream.
    expect(createdIntent).toBeNull()
  })

  it('rejects a malformed source before touching Stripe at all', async () => {
    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { tokenSymbol: 'USDC' }, // no chainId
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_SOURCE')
    expect(createdIntent).toBeNull()
  })
})

describe('Stripe create-invoice — what source must NOT change', () => {
  it('always settles to the funder wallet in Base USDC regardless of source', async () => {
    for (const source of [
      { chainId: '900', tokenSymbol: 'USDT' },
      { chainId: '1', tokenSymbol: 'USDC' },
      { chainId: '1500', tokenSymbol: 'USDC' },
    ]) {
      await createInvoice({ url: STRIPE_URL, source })
      expect(createdIntent.destination).toMatchObject({
        chainId: '8453',
        receiverAddress: SETTLEMENT_RECEIVER,
        tokenSymbol: 'USDC',
        tokenAddress: BASE_USDC,
      })
    }
  })

  it('does not change the amount the caller pays', async () => {
    // $10 invoice -> 10*100/105 discount, independent of the source chain.
    const base = await createInvoice({ url: STRIPE_URL })
    const solana = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })
    expect(base.json.callerPays).toBe('9.523809')
    expect(solana.json.callerPays).toBe('9.523809')
  })
})

describe('Stripe create-invoice — reuse with a conflicting source', () => {
  it('echoes the existing intent source and warns that the request was not applied', async () => {
    existingIntent = {
      id: 'rozo-existing-1',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC' },
    }

    const { status, json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })

    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    // No new intent — and the caller is told their source did NOT take effect,
    // rather than being left to assume it did.
    expect(createdIntent).toBeNull()
    expect(json.source).toEqual({ chainId: '8453', tokenSymbol: 'USDC' })
    expect(json.warnings?.join(' ')).toContain('was not applied')
  })

  it('does not warn when the reused intent matches the requested source', async () => {
    existingIntent = {
      id: 'rozo-existing-2',
      paymentLink: 'https://pay.rozo.ai/existing',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '900', tokenSymbol: 'USDT' },
    }

    const { json } = await createInvoice({
      url: STRIPE_URL,
      source: { chainId: '900', tokenSymbol: 'USDT' },
    })
    expect(json.reused).toBe(true)
    expect(json.warnings ?? []).not.toContain(expect.stringContaining('was not applied'))
  })
})
