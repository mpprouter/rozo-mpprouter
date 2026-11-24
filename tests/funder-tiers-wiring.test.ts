/**
 * Tiered funders (FUNDER_TIERS_ENABLED): order creation sites.
 *   - Coinbase create-invoice: receiver = the tier for the Coinbase amount,
 *     refusal creates nothing, an upstream order paying another wallet is not
 *     handed out, a reused order paying another wallet is not handed out.
 *   - Stripe create-invoice: receiver = T3B.
 *   - TRON / TON alpha: no option while the flag is on.
 *   - Funder balance watch: every tier, own state.
 * Flag off: every body is byte-identical to today's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { handleTronTonAlphaCapability, handleTronTonAlphaOption } from '../src/routes/tron-ton-alpha'
import { checkFunderBalance, FUNDER_TIER_WATCH_PROFILES, watchStateKey } from '../src/utils/funder-balance-watch'
import { BASE_FUNDER_ADDRESS } from '../src/funder-address'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const T1 = '0x1000000000000000000000000000000000000001'
const T2 = '0x2000000000000000000000000000000000000002'
const T3A = '0x3000000000000000000000000000000000000003'
const T3B = '0x4000000000000000000000000000000000000004'
const TIERS = { FUNDER_TIERS_ENABLED: 'true', FUNDER_T1_ADDRESS: T1, FUNDER_T2_ADDRESS: T2, FUNDER_T3A_ADDRESS: T3A, FUNDER_T3B_ADDRESS: T3B }
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYMENT_ID = 'paymentSession_tier_test'
const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMTierBlob_ABC123xyz'

function makeKv() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

function makeEnv(over: Record<string, unknown> = {}): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: makeKv(),
    INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    ...over,
  } as unknown as Env
}

let quoteAmount = '10.5'
let stripeCents = 1000
let createdIntent: any = null
let creates = 0
let createReceiver: ((sent: any) => string | undefined) = (sent) => sent?.destination?.receiverAddress
let existingRow: any = null

beforeEach(() => {
  quoteAmount = '10.5'
  stripeCents = 1000
  createdIntent = null
  creates = 0
  createReceiver = (sent) => sent?.destination?.receiverAddress
  existingRow = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) {
      return Response.json({ invoice: { amount: quoteAmount }, merchant: 'OpenRouter, Inc', linkId: PAYMENT_ID })
    }
    if (u.includes('/resume_payin_session')) {
      return Response.json({ sessionId: 'cpis_tier123', clientSecret: 'cs_secret', publishableKey: 'pk_live_test', mode: 'pay' })
    }
    if (u.includes('/payin_session')) {
      return Response.json({
        id: 'cpis_tier123',
        state: 'checkout',
        business_name: 'Test Merchant',
        merchant: 'acct_test',
        payment_details: { amount: stripeCents, currency: 'usd' },
        supported_currencies: [{
          id: 'usdc.base', chain_id: 8453, currency_network: 'base', mainnet: true, asset_code: 'usdc',
          currency_minor_units: 6, contract_address: BASE_USDC.toLowerCase(), payment_options: ['wallet_connect'],
        }],
        valid_before: '2999-01-01T00:00:00.000Z',
      })
    }
    if (u.includes('/payments/order/')) {
      return existingRow ? Response.json(existingRow) : new Response('{"error":{"code":"paymentNotFound"}}', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      creates++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return Response.json({
        id: 'rozo-pay-1',
        paymentLink: 'https://pay.rozo.ai/x',
        expiresAt: '2999-01-01T00:00:00.000Z',
        destination: { chainId: '8453', receiverAddress: createReceiver(createdIntent), tokenSymbol: 'USDC' },
      })
    }
    if (u.includes('/payment-api')) return Response.json({ status: 'payment_unpaid' })
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function create(body: Record<string, unknown>, env = makeEnv()) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

describe('Coinbase create-invoice', () => {
  it('flag off: receiver is the legacy funder (unchanged)', async () => {
    const r = await create({ payment_id: PAYMENT_ID })
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(BASE_FUNDER_ADDRESS)
  })

  it('flag off: an upstream answer naming another receiver is not checked (unchanged)', async () => {
    createReceiver = () => '0x9999999999999999999999999999999999999999'
    const r = await create({ payment_id: PAYMENT_ID })
    expect(r.status).toBe(200)
  })

  it('flag on: below $200 -> T2, at $200 -> T3A', async () => {
    let r = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(T2)
    quoteAmount = '199.999999'
    r = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(createdIntent.destination.receiverAddress).toBe(T2)
    quoteAmount = '200'
    r = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(T3A)
  })

  it('flag on: above the order cap or with a missing tier, nothing is created', async () => {
    quoteAmount = '1200.000001'
    let r = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('FUNDER_TIER_REFUSED')
    quoteAmount = '10.5'
    r = await create({ payment_id: PAYMENT_ID }, makeEnv({ ...TIERS, FUNDER_T2_ADDRESS: 'placeholder' }))
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('FUNDER_TIER_REFUSED')
    expect(creates).toBe(0)
  })

  it('flag on: an upstream order paying another wallet is not handed out', async () => {
    createReceiver = () => BASE_FUNDER_ADDRESS
    const r = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('FUNDER_TIER_RECEIVER_MISMATCH')
    expect(r.json.paymentLink).toBeUndefined()
  })

  it('flag on: an upstream order without a receiver is not handed out', async () => {
    createReceiver = () => undefined
    const r = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(r.json.code).toBe('FUNDER_TIER_RECEIVER_MISMATCH')
  })

  it('flag on: a reusable order paying the legacy funder is never reused', async () => {
    existingRow = {
      id: 'rozo-old',
      orderId: PAYMENT_ID,
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.5' },
      destination: { chainId: '8453', receiverAddress: BASE_FUNDER_ADDRESS },
    }
    const off = await create({ payment_id: PAYMENT_ID })
    expect(off.json.reused).toBe(true)
    const on = await create({ payment_id: PAYMENT_ID }, makeEnv(TIERS))
    expect(on.json.reused).not.toBe(true)
    expect(on.json.paymentLink ?? null).not.toBe('rozo-old')
  })
})

describe('phase 2a create-invoice (FUNDER_T3_BACKEND=legacy)', () => {
  const P2A = { ...TIERS, FUNDER_T3A_ADDRESS: undefined, FUNDER_T3B_ADDRESS: undefined, FUNDER_T3_BACKEND: 'legacy' }
  it('Coinbase >= $200 and Stripe go to the legacy funder; Coinbase < $200 to T2', async () => {
    quoteAmount = '250'
    let r = await create({ payment_id: PAYMENT_ID }, makeEnv(P2A))
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(BASE_FUNDER_ADDRESS)
    quoteAmount = '10.5'
    r = await create({ payment_id: PAYMENT_ID }, makeEnv(P2A))
    expect(createdIntent.destination.receiverAddress).toBe(T2)
    r = await create({ url: STRIPE_URL }, makeEnv(P2A))
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(BASE_FUNDER_ADDRESS)
  })
  it('a reusable alpha-created $20 order (legacy receiver) is reused in 2a; a plain one paying legacy is not', async () => {
    const row = (source: string) => ({
      id: 'rozo-alpha',
      orderId: PAYMENT_ID,
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      source: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.5' },
      destination: { chainId: '8453', receiverAddress: BASE_FUNDER_ADDRESS },
      metadata: { source },
    })
    existingRow = row('mpprouter-tron-ton-alpha')
    let r = await create({ payment_id: PAYMENT_ID }, makeEnv(P2A))
    expect(r.json.reused).toBe(true)
    existingRow = row('mpprouter-create-invoice')
    r = await create({ payment_id: PAYMENT_ID }, makeEnv(P2A))
    expect(r.json.reused).not.toBe(true)
  })
})

describe('Stripe create-invoice', () => {
  it('flag off: receiver is the legacy funder; flag on: T3B', async () => {
    let r = await create({ url: STRIPE_URL })
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(BASE_FUNDER_ADDRESS)
    r = await create({ url: STRIPE_URL }, makeEnv(TIERS))
    expect(r.status).toBe(200)
    expect(createdIntent.destination.receiverAddress).toBe(T3B)
  })

  it('flag on: a missing T3B refuses before any create; a mismatching order is not handed out', async () => {
    let r = await create({ url: STRIPE_URL }, makeEnv({ ...TIERS, FUNDER_T3B_ADDRESS: undefined }))
    expect(r.json.code).toBe('FUNDER_TIER_REFUSED')
    expect(creates).toBe(0)
    createReceiver = () => T2
    r = await create({ url: STRIPE_URL }, makeEnv(TIERS))
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('FUNDER_TIER_RECEIVER_MISMATCH')
  })
})

describe('TRON / TON alpha', () => {
  it('flag on: capability lists nothing and option is refused before anything upstream', async () => {
    const env = makeEnv(TIERS)
    const cap = await handleTronTonAlphaCapability(new Request('https://mpp.test/cap'), env)
    expect(await cap.json()).toEqual({ ok: true, enabled: false, options: [] })
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const before = fetchSpy.mock.calls.length
    const opt = await handleTronTonAlphaOption(
      new Request('https://mpp.test/opt', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      env,
    )
    expect(opt.status).toBe(503)
    expect(((await opt.json()) as any).code).toBe('ALPHA_FUNDER_TIERS_PAUSED')
    expect(fetchSpy.mock.calls.length).toBe(before)
  })
})

describe('funder balance watch', () => {
  it('legacy state key and texts by default; tier profile and own key per tier', async () => {
    const kv = makeKv()
    const read = (balance: bigint) => async () => ({ balance, rpcsTried: [] })
    const legacy = await checkFunderBalance({ kv: kv as any, address: BASE_FUNDER_ADDRESS, readBalance: read(40_000_000n), now: 1e12 })
    expect(legacy!.messages[0]).toMatch(/^\[MPP Router\] 🚨 Funder balance P0 \(< \$50\.00\)/)
    await legacy!.commit()
    expect(kv._store.has('funder-balance:watch-state')).toBe(true)

    // T1 at 40 USDC is healthy for its own bands (P0 < $10).
    const t1 = await checkFunderBalance({
      kv: kv as any, address: T1, readBalance: read(40_000_000n), now: 1e12,
      stateKey: watchStateKey('T1'), profile: FUNDER_TIER_WATCH_PROFILES.T1,
    })
    expect(t1).toBeNull()
    expect(kv._store.has('funder-balance:watch-state:T1')).toBe(true)
    const t1low = await checkFunderBalance({
      kv: kv as any, address: T1, readBalance: read(5_000_000n), now: 1e12 + 16 * 60_000,
      stateKey: watchStateKey('T1'), profile: FUNDER_TIER_WATCH_PROFILES.T1,
    })
    expect(t1low!.messages[0]).toMatch(/Funder T1 \(x402\) balance P0 \(< \$10\.00\)/)
  })
})
