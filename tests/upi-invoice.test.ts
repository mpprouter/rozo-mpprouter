import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  handleUpiResolve,
  handleUpiVerifiedPayIn,
  handleUpiFulfillmentStatus,
  classifyUpiUrl,
  computeQuoteId,
  hmacSha256Hex,
  loadFulfillment,
  stripeTerminal,
} from '../src/routes/upi-invoice'
import { claimInvoiceKey, readInvoiceClaim } from '../src/routes/invoice-claim'
import { handleStripeWebhookEvent, seedStripeRecord } from '../src/routes/stripe-fulfillment'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

// ── Fixtures ────────────────────────────────────────────────────────────────

const SECRET = 'upi-internal-key-0123456789'
const ORDER = '11111111-2222-4333-8444-555555555555'
const ORDER2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PL_URL = 'https://payments.coinbase.com/payment-links/pl_abc123'
const PS_URL = 'https://payments.coinbase.com/payment-sessions/paymentSession_xyz789'
const STRIPE_URL = 'https://crypto.stripe.com/pay/blob_ABC'
const TEST_CAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')

// Second-aligned: Coinbase v1 expiry is unix seconds, so the ISO round-trip drops ms.
const FUTURE = new Date(Math.floor(Date.now() / 1000) * 1000 + 6 * 60 * 60 * 1000)

function v1Link(over: Record<string, unknown> = {}) {
  return {
    id: 'pl_abc123',
    status: 'ACTIVE',
    maxAmount: '10.50',
    token: BASE_USDC,
    networkId: 8453,
    preApprovalExpiry: String(Math.floor(FUTURE.getTime() / 1000)),
    maxUsage: 1,
    usageCount: 0,
    merchant: { name: 'OpenRouter' },
    fiat: { amount: '10.50', currency: 'USD' },
    ...over,
  }
}

function v3Session(over: Record<string, unknown> = {}) {
  return {
    paymentSessionId: 'paymentSession_xyz789',
    status: 'PAYMENT_SESSION_STATUS_CREATED',
    amount: '1.36',
    asset: 'usdc',
    expiresAt: FUTURE.toISOString(),
    customerDisplay: { merchantName: 'Venice AI' },
    target: { paymentTargetWallet: { address: '0xabc', network: 'PAYMENT_TARGET_NETWORK_BASE' } },
    ...over,
  }
}

function stripeSession(over: Record<string, unknown> = {}) {
  return {
    id: 'cpis_stripe1',
    object: 'crypto.payin_session',
    state: 'initialized',
    business_name: 'QuickNode',
    merchant: 'acct_123',
    livemode: true,
    payment_details: { amount: 1819, currency: 'usd' },
    supported_currencies: [
      {
        id: 'usdc.base',
        asset_code: 'usdc',
        chain_id: 8453,
        contract_address: BASE_USDC,
        currency_network: 'base',
        mainnet: true,
        payment_options: ['direct_deposit', 'wallet_connect'],
      },
    ],
    valid_before: FUTURE.toISOString(),
    ...over,
  }
}

// Programmable upstream. Each test mutates `world` to shape provider answers.
interface World {
  v1: Record<string, unknown> | null
  v3: Record<string, unknown> | null
  stripe: Record<string, unknown> | null
  balanceHex: string | null // null → RPC unreachable
  payInvoice: { status: number; body: unknown } | 'throw'
  payCalls: Array<{ url: string; body: any }>
}

let world: World
const originalFetch = globalThis.fetch

function installFetch() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://payments.coinbase.com/next-api/payment-links/')) {
      return world.v1 ? Response.json(world.v1) : new Response('nope', { status: 404 })
    }
    if (url.startsWith('https://payments.coinbase.com/next-api/payment-sessions/')) {
      return world.v3 ? Response.json(world.v3) : new Response('nope', { status: 404 })
    }
    if (url === 'https://crypto.stripe.com/resume_payin_session') {
      return Response.json({ publishableKey: 'pk_test', clientSecret: 'cs_test', sessionId: 'cpis_stripe1', mode: 'pay' })
    }
    if (url.startsWith('https://api.stripe.com/v1/crypto/internal/payin_session')) {
      return world.stripe ? Response.json(world.stripe) : new Response('gone', { status: 410 })
    }
    if (url === 'https://agentapi.rozo.ai/pay-invoice') {
      world.payCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      if (world.payInvoice === 'throw') throw new Error('ECONNRESET')
      return new Response(JSON.stringify(world.payInvoice.body), {
        status: world.payInvoice.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    // Base RPC balance (any other https POST with eth_call).
    if (init?.method === 'POST' && String(init.body ?? '').includes('eth_call')) {
      if (world.balanceHex === null) return new Response('down', { status: 503 })
      return Response.json({ jsonrpc: '2.0', id: 1, result: world.balanceHex })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    MPP_STORE: makeKv() as any,
    ATOMIC_STORE: makeAtomicStoreMock(),
    PAYINVOICE_ADMIN_SECRET: 'admin',
    ROZO_INTENTS_API_KEY: 'key',
    UPI_INTERNAL_KEY: SECRET,
    UPI_PROVIDERS_ENABLED: 'coinbase_v1,coinbase_v3,stripe_crypto',
    INVOICE_CAPABILITY_ENCRYPTION_KEY: TEST_CAP_KEY,
    ...extra,
  } as unknown as Env
}

function resolveReq(payUrl: string, key = SECRET) {
  return new Request('https://apiserver.mpprouter.dev/api/invoice/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': key },
    body: JSON.stringify({ pay_url: payUrl }),
  })
}

async function resolve(env: Env, payUrl: string) {
  const res = await handleUpiResolve(resolveReq(payUrl), env)
  return { status: res.status, body: (await res.json()) as any }
}

async function payInReq(
  body: Record<string, unknown>,
  over: { key?: string; sig?: string; idem?: string } = {},
) {
  const raw = JSON.stringify(body)
  const sig = over.sig ?? (await hmacSha256Hex(SECRET, raw))
  return new Request('https://apiserver.mpprouter.dev/api/invoice/verified-pay-in', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': over.key ?? SECRET,
      'x-signature': sig,
      'x-idempotency-key': over.idem ?? String(body.order_id),
    },
    body: raw,
  })
}

function payInBody(resolved: any, over: Record<string, unknown> = {}) {
  return {
    order_id: ORDER,
    provider: resolved.provider,
    invoice_key: resolved.invoice_key,
    quote_id: resolved.quote_id,
    base_amount_minor: resolved.base_amount_minor,
    razorpay_order_id: 'order_rzp1',
    razorpay_payment_id: 'pay_rzp1',
    captured_at: new Date().toISOString(),
    ...over,
  }
}

async function payIn(env: Env, body: Record<string, unknown>, over?: { key?: string; sig?: string; idem?: string }) {
  const res = await handleUpiVerifiedPayIn(await payInReq(body, over), env)
  return { status: res.status, body: (await res.json()) as any }
}

async function status(env: Env, orderId: string) {
  const res = await handleUpiFulfillmentStatus(
    new Request(`https://apiserver.mpprouter.dev/api/invoice/fulfillment/${orderId}`, {
      headers: { 'x-internal-key': SECRET },
    }),
    env,
    orderId,
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeEach(() => {
  world = {
    v1: v1Link(),
    v3: v3Session(),
    stripe: stripeSession(),
    balanceHex: '0x' + (1_000_000_000n).toString(16), // 1000 USDC
    payInvoice: { status: 200, body: { success: true, txHash: '0xdeadbeef' } },
    payCalls: [],
  }
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ── URL classification ──────────────────────────────────────────────────────

describe('classifyUpiUrl', () => {
  it('accepts exactly the three supported families', () => {
    expect(classifyUpiUrl(PL_URL)).toMatchObject({ provider: 'coinbase_v1', invoiceKey: 'pl_abc123' })
    expect(classifyUpiUrl(PS_URL)).toMatchObject({ provider: 'coinbase_v3', invoiceKey: 'paymentSession_xyz789' })
    expect(classifyUpiUrl(STRIPE_URL)).toMatchObject({ provider: 'stripe_crypto' })
  })

  it('rejects card checkout, setup links, commerce charges, look-alikes and junk', () => {
    expect(classifyUpiUrl('https://checkout.stripe.com/c/pay/cs_live_abc')).toBeNull()
    expect(classifyUpiUrl('https://crypto.stripe.com/setup/blob')).toBeNull()
    expect(classifyUpiUrl('https://commerce.coinbase.com/pay/0b1c2d')).toBeNull()
    expect(classifyUpiUrl('https://crypto.stripe.com.evil.com/pay/blob')).toBeNull()
    expect(classifyUpiUrl('http://payments.coinbase.com/payment-links/pl_abc')).toBeNull()
    expect(classifyUpiUrl('not a url')).toBeNull()
    expect(classifyUpiUrl('https://example.com/pay/x')).toBeNull()
  })
})

// ── resolve ─────────────────────────────────────────────────────────────────

describe('POST /api/invoice/resolve', () => {
  it('requires the internal key and fails closed when unset', async () => {
    const env = makeEnv()
    expect((await handleUpiResolve(resolveReq(PL_URL, 'wrong'), env)).status).toBe(401)
    expect((await handleUpiResolve(resolveReq(PL_URL, ''), env)).status).toBe(401)
    const unset = makeEnv({ UPI_INTERNAL_KEY: undefined })
    expect((await handleUpiResolve(resolveReq(PL_URL), unset)).status).toBe(503)
  })

  it('resolves a Coinbase v1 link with a verifiable quote_id', async () => {
    const env = makeEnv()
    const { status, body } = await resolve(env, PL_URL)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      provider: 'coinbase_v1',
      invoice_key: 'pl_abc123',
      merchant: 'OpenRouter',
      base_amount_minor: 1050,
      currency: 'USD',
      payable: true,
      reason: null,
    })
    expect(body.expires_at).toBe(FUTURE.toISOString())
    const expected = await computeQuoteId(SECRET, 'coinbase_v1', 'pl_abc123', 1050, body.expires_at)
    expect(body.quote_id).toBe(expected)
    // Never echoes the pay URL or any secret-ish field.
    expect(JSON.stringify(body)).not.toContain('payment-links/')
  })

  it('resolves a Coinbase v3 session and a Stripe crypto session', async () => {
    const env = makeEnv()
    const v3 = await resolve(env, PS_URL)
    expect(v3.status).toBe(200)
    expect(v3.body).toMatchObject({
      provider: 'coinbase_v3',
      invoice_key: 'paymentSession_xyz789',
      merchant: 'Venice AI',
      base_amount_minor: 136,
      payable: true,
    })
    const st = await resolve(env, STRIPE_URL)
    expect(st.status).toBe(200)
    expect(st.body).toMatchObject({
      provider: 'stripe_crypto',
      invoice_key: 'cpis_stripe1',
      merchant: 'QuickNode',
      base_amount_minor: 1819,
      payable: true,
    })
    const raw = JSON.stringify(st.body)
    expect(raw).not.toContain('cs_test')
    expect(raw).not.toContain('pk_test')
    expect(raw).not.toContain('blob_ABC')
  })

  it('rejects unsupported URLs with 400 unsupported_url', async () => {
    const env = makeEnv()
    for (const u of ['https://checkout.stripe.com/c/pay/cs_1', 'https://crypto.stripe.com/setup/x', 'https://evil.com/']) {
      const r = await resolve(env, u)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('unsupported_url')
    }
  })

  it('rejects non-USD invoices with 422 non_usd', async () => {
    const env = makeEnv()
    world.stripe = stripeSession({ payment_details: { amount: 1000, currency: 'eur' } })
    const r = await resolve(env, STRIPE_URL)
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('non_usd')
  })

  it('reports already-paid / used invoices as not payable', async () => {
    const env = makeEnv()
    world.v1 = v1Link({ usageCount: 1 })
    const a = await resolve(env, PL_URL)
    expect(a.body.payable).toBe(false)
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    const b = await resolve(env, PS_URL)
    expect(b.body.payable).toBe(false)
    world.stripe = stripeSession({ state: 'fulfillment_complete' })
    const c = await resolve(env, STRIPE_URL)
    expect(c.body.payable).toBe(false)
  })

  it('requires enough remaining validity', async () => {
    const env = makeEnv()
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    world.v3 = v3Session({ expiresAt: soon })
    const r = await resolve(env, PS_URL)
    expect(r.body.payable).toBe(false)
    expect(r.body.reason).toBe('expires_too_soon')
    const gone = new Date(Date.now() - 60 * 1000).toISOString()
    world.v3 = v3Session({ expiresAt: gone })
    const r2 = await resolve(env, PS_URL)
    expect(r2.body.payable).toBe(false)
  })

  it('answers 410 expired when the provider no longer has the invoice', async () => {
    const env = makeEnv()
    world.v1 = null
    const r = await resolve(env, PL_URL)
    expect(r.status).toBe(410)
    expect(r.body.error).toBe('expired')
  })

  it('honours the provider allowlist (fail closed when unset)', async () => {
    const off = makeEnv({ UPI_PROVIDERS_ENABLED: 'coinbase_v3' })
    const r = await resolve(off, PL_URL)
    expect(r.body.payable).toBe(false)
    expect(r.body.reason).toBe('provider_disabled')
    const none = makeEnv({ UPI_PROVIDERS_ENABLED: undefined })
    const r2 = await resolve(none, PS_URL)
    expect(r2.body.payable).toBe(false)
    expect(r2.body.reason).toBe('provider_disabled')
  })

  it('never stores the Stripe pay URL in plaintext', async () => {
    const env = makeEnv()
    await resolve(env, STRIPE_URL)
    const kv = (env.MPP_STORE as any).store as Map<string, string>
    const all = Array.from(kv.values()).join('\n')
    expect(all).not.toContain('blob_ABC')
    expect(all).toContain('"payUrlEncrypted":"v1:')
  })
})

// ── verified-pay-in: auth / replay / idempotency ────────────────────────────

describe('POST /api/invoice/verified-pay-in — auth and idempotency', () => {
  it('rejects a bad internal key, a bad signature, and an idempotency key mismatch', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    const b = payInBody(q)
    expect((await payIn(env, b, { key: 'nope' })).status).toBe(401)
    expect((await payIn(env, b, { sig: 'f'.repeat(64) })).status).toBe(401)
    expect((await payIn(env, b, { sig: 'garbage' })).status).toBe(401)
    expect((await payIn(env, b, { idem: ORDER2 })).status).toBe(400)
    expect(world.payCalls.length).toBe(0)
    expect(await loadFulfillment(env, ORDER)).toBeNull()
  })

  it('signature must cover the exact raw bytes (tampered body fails)', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    const b = payInBody(q)
    const goodSig = await hmacSha256Hex(SECRET, JSON.stringify(b))
    const tampered = { ...b, base_amount_minor: 1 }
    const r = await payIn(env, tampered, { sig: goodSig })
    expect(r.status).toBe(401)
  })

  it('rejects a forged quote_id and an amount that does not match the quote', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    const forged = await payIn(env, payInBody(q, { quote_id: 'a'.repeat(64) }))
    expect(forged.status).toBe(422)
    expect(forged.body.error).toBe('invalid_quote')
    const wrongAmount = await payIn(env, payInBody(q, { base_amount_minor: 100 }))
    expect(wrongAmount.status).toBe(422)
    expect(world.payCalls.length).toBe(0)
    expect(await loadFulfillment(env, ORDER)).toBeNull()
  })

  it('same order_id + same body replays the same 202; different body → 409', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    const b = payInBody(q)
    const first = await payIn(env, b)
    expect(first.status).toBe(202)
    expect(first.body.fulfillment_id).toBe(ORDER)
    const replay = await payIn(env, b)
    expect(replay.status).toBe(202)
    expect(replay.body).toEqual(first.body)
    expect(world.payCalls.length).toBe(1) // executor called exactly once

    const different = await payIn(env, { ...b, razorpay_payment_id: 'pay_other' })
    expect(different.status).toBe(409)
    expect(different.body.error).toBe('order_body_mismatch')
    expect(world.payCalls.length).toBe(1)
  })
})

// ── verified-pay-in: execution and terminal mapping ─────────────────────────

describe('POST /api/invoice/verified-pay-in — execution', () => {
  it('Coinbase v3: executor accepted is `processing`, `paid` only on CAPTURE_SUCCEEDED', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PS_URL)
    const r = await payIn(env, payInBody(q))
    expect(r.status).toBe(202)
    expect(r.body.state).toBe('processing') // provider still CREATED
    expect(world.payCalls[0].body).toEqual({ payment_id: 'paymentSession_xyz789' })

    // Provider now pending-ish: still not paid.
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_AUTHORIZATION_ACCEPTED' })
    let s = await status(env, ORDER)
    expect(s.body.state).toBe('processing')
    expect(s.body.provider_final_state).toBe('PAYMENT_SESSION_STATUS_AUTHORIZATION_ACCEPTED')

    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    s = await status(env, ORDER)
    expect(s.body.state).toBe('paid')
    expect(s.body.provider_final_state).toBe('PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED')
    expect(s.body.execution_ref).toBe('0xdeadbeef')
    expect(world.payCalls.length).toBe(1)
  })

  it('Coinbase v1: paid when usage is exhausted after the executor call', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    // Executor pays and the link is immediately fully used.
    const r = await payIn(env, payInBody(q))
    expect(r.status).toBe(202)
    world.v1 = v1Link({ usageCount: 1 })
    const s = await status(env, ORDER)
    expect(s.body.state).toBe('paid')
  })

  it('never re-pays: executor 5xx / transport error → unknown, status polling never calls the executor', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    world.payInvoice = 'throw'
    const r = await payIn(env, payInBody(q))
    expect(r.body.state).toBe('unknown')
    await status(env, ORDER)
    await status(env, ORDER)
    expect(world.payCalls.length).toBe(1)
    const rec = await loadFulfillment(env, ORDER)
    expect(rec?.state).toBe('unknown')

    const env2 = makeEnv()
    const { body: q2 } = await resolve(env2, PS_URL)
    world.payInvoice = { status: 502, body: { error: 'bad gateway' } }
    const r2 = await payIn(env2, payInBody(q2))
    expect(r2.body.state).toBe('unknown')
    // Later provider success resolves the unknown to paid without paying again.
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    const s = await status(env2, ORDER)
    expect(s.body.state).toBe('paid')
  })

  it('executor definite 4xx → failed', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    world.payInvoice = { status: 409, body: { error: 'used' } }
    const r = await payIn(env, payInBody(q))
    expect(r.body.state).toBe('failed')
  })

  it('keeps the wallet inventory gate: insufficient funder balance → failed, executor not called', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    world.balanceHex = '0x' + (1_000_000n).toString(16) // 1 USDC < 10.50
    const r = await payIn(env, payInBody(q))
    expect(r.body.state).toBe('failed')
    expect(world.payCalls.length).toBe(0)
    const rec = await loadFulfillment(env, ORDER)
    expect(rec?.failureReason).toBe('insufficient_funder_balance')
    // Reserved counter released.
    expect(await env.MPP_STORE.get('funder-reserved-atomic')).toBeNull()
  })

  it('refuses at pay time when the invoice was paid by someone else meanwhile (never attributes it)', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PS_URL)
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    const r = await payIn(env, payInBody(q))
    expect(r.status).toBe(202)
    expect(r.body.state).toBe('failed')
    expect(world.payCalls.length).toBe(0)
    // Polling must not flip it to paid.
    const s = await status(env, ORDER)
    expect(s.body.state).toBe('failed')
  })

  it('refuses when the provider is disabled at pay time even if the quote was issued', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    ;(env as any).UPI_PROVIDERS_ENABLED = ''
    const r = await payIn(env, payInBody(q))
    expect(r.body.state).toBe('failed')
    expect(world.payCalls.length).toBe(0)
  })

  it('Stripe: passes the locked merchant/amount to the executor; disabled branch → failed; fulfillment_complete → paid', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, STRIPE_URL)
    world.payInvoice = { status: 403, body: { code: 'stripe_fulfillment_disabled' } }
    const r = await payIn(env, payInBody(q))
    expect(r.body.state).toBe('failed')
    const call = world.payCalls[0].body
    expect(call).toMatchObject({
      url: STRIPE_URL,
      expected_merchant_account: 'acct_123',
      expected_amount_atomic: '18190000',
      spent_today_atomic: '0',
    })

    const env2 = makeEnv()
    const { body: q2 } = await resolve(env2, STRIPE_URL)
    world.payInvoice = { status: 200, body: { success: true, state: 'provider_submitted' } }
    const r2 = await payIn(env2, payInBody(q2))
    expect(r2.body.state).toBe('processing') // submitted ≠ paid
    world.stripe = stripeSession({ state: 'fulfillment_initiated' })
    expect((await status(env2, ORDER)).body.state).toBe('processing')
    world.stripe = stripeSession({ state: 'fulfillment_complete' })
    expect((await status(env2, ORDER)).body.state).toBe('paid')
  })

  it('Stripe terminal mapping', () => {
    expect(stripeTerminal('fulfillment_complete')).toBe('success')
    expect(stripeTerminal('succeeded')).toBe('success')
    expect(stripeTerminal('failed')).toBe('failure')
    expect(stripeTerminal('canceled')).toBe('failure')
    for (const s of ['initialized', 'checkout', 'purchase_complete', 'fulfillment_initiated', 'processing', 'unknown']) {
      expect(stripeTerminal(s)).toBeNull()
    }
  })

  it('status: 404 for unknown order, 401 without key', async () => {
    const env = makeEnv()
    expect((await status(env, ORDER2)).status).toBe(404)
    const res = await handleUpiFulfillmentStatus(
      new Request(`https://x/api/invoice/fulfillment/${ORDER}`),
      env,
      ORDER,
    )
    expect(res.status).toBe(401)
  })
})

// ── Cross-channel claim ─────────────────────────────────────────────────────

describe('invoice claim (cross-channel)', () => {
  it('two concurrent UPI claims on one invoice: exactly one wins', async () => {
    const env = makeEnv()
    const results = await Promise.all([
      claimInvoiceKey(env, 'pl_race', 'upi', ORDER),
      claimInvoiceKey(env, 'pl_race', 'upi', ORDER2),
    ])
    const winners = results.filter((r) => r.ok)
    expect(winners.length).toBe(1)
    const holder = await readInvoiceClaim(env, 'pl_race')
    expect(holder?.channel).toBe('upi')
    // Winner's re-entry is idempotent; loser stays refused.
    expect((await claimInvoiceKey(env, 'pl_race', 'upi', holder!.ref)).ok).toBe(true)
    const loserRef = holder!.ref === ORDER ? ORDER2 : ORDER
    expect((await claimInvoiceKey(env, 'pl_race', 'upi', loserRef)).ok).toBe(false)
  })

  it('crypto vs UPI is mutually exclusive; crypto vs crypto is left to the existing guards', async () => {
    const env = makeEnv()
    expect((await claimInvoiceKey(env, 'pl_x', 'crypto', 'pl_x')).ok).toBe(true)
    expect((await claimInvoiceKey(env, 'pl_x', 'crypto', 'coupon:ABC')).ok).toBe(true)
    const upi = await claimInvoiceKey(env, 'pl_x', 'upi', ORDER)
    expect(upi.ok).toBe(false)
    if (!upi.ok) expect(upi.holder.channel).toBe('crypto')
  })

  it('two concurrent verified-pay-in orders for the same invoice: one settles, the other 409s', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PS_URL)
    const [a, b] = await Promise.all([
      payIn(env, payInBody(q, { order_id: ORDER })),
      payIn(env, payInBody(q, { order_id: ORDER2 })),
    ])
    const codes = [a.status, b.status].sort()
    expect(codes).toEqual([202, 409])
    expect(world.payCalls.length).toBe(1)
    const loser = a.status === 409 ? a : b
    expect(loser.body.error).toBe('already_claimed')
    expect(loser.body.state).toBe('failed')
  })

  it('verified-pay-in 409s when the crypto flow already claimed the invoice', async () => {
    const env = makeEnv()
    const { body: q } = await resolve(env, PL_URL)
    expect((await claimInvoiceKey(env, 'pl_abc123', 'crypto', 'pl_abc123')).ok).toBe(true)
    const r = await payIn(env, payInBody(q))
    expect(r.status).toBe(409)
    expect(world.payCalls.length).toBe(0)
    expect((await status(env, ORDER)).body.state).toBe('failed')
  })

  it('Stripe crypto webhook refuses to sign when UPI already holds the session', async () => {
    const env = makeEnv()
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_stripe1',
      merchantAccount: 'acct_123',
      invoiceAmountAtomic: '18190000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:x',
      stripeUrl: STRIPE_URL,
      rozoPaymentId: 'rozo-1',
    })
    expect((await claimInvoiceKey(env, 'cpis_stripe1', 'upi', ORDER)).ok).toBe(true)
    const out = await handleStripeWebhookEvent(
      env,
      {
        eventId: 'evt-1',
        eventType: 'payment_payout_completed',
        orderId: 'stripe_crypto_cpis_stripe1',
        rozoPaymentId: 'rozo-1',
        invoiceAmountStr: '18.19',
      },
      new Date(),
    )
    expect(out.status).toBe('claimed_by_other_channel')
    expect(world.payCalls.length).toBe(0)
  })
})

// ── Coinbase crypto webhook honours the UPI claim ───────────────────────────

describe('Coinbase webhook vs UPI claim', () => {
  it('payout_completed for a UPI-claimed link does not call the executor', async () => {
    const { handleRozoWebhook } = await import('../src/routes/webhook')
    const env = makeEnv({ ROZO_WEBHOOK_SECRET: 'hook-secret' } as Partial<Env>)
    expect((await claimInvoiceKey(env, 'pl_abc123', 'upi', ORDER)).ok).toBe(true)
    const body = JSON.stringify({
      event_id: 'evt-upi-1',
      type: 'payment_payout_completed',
      data: { id: 'rozo-1', orderId: 'pl_abc123', destination: { amount: '10.50' } },
    })
    const ts = String(Date.now())
    const sig = await hmacSha256Hex('hook-secret', `${ts}.${body}`)
    const res = await handleRozoWebhook(
      new Request('https://x/v1/services/rozo-agent-api/webhook', {
        method: 'POST',
        headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig}` },
        body,
      }),
      env,
    )
    const out = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(out.status).toBe('claimed_by_other_channel')
    expect(world.payCalls.length).toBe(0)
    // Terminal: a replayed event does not reopen it.
    const body2 = body.replace('evt-upi-1', 'evt-upi-2')
    const sig2 = await hmacSha256Hex('hook-secret', `${ts}.${body2}`)
    const res2 = await handleRozoWebhook(
      new Request('https://x/v1/services/rozo-agent-api/webhook', {
        method: 'POST',
        headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig2}` },
        body: body2,
      }),
      env,
    )
    expect(((await res2.json()) as any).alreadyTerminal).toBe('claimed_by_other_channel')
    expect(world.payCalls.length).toBe(0)
  })
})

describe('queued records never become paid', () => {
  it('a queued order whose invoice gets settled by someone else is failed, not paid', async () => {
    const { casUpdate } = await import('../src/routes/stripe-atomic')
    const { fulfillmentKey } = await import('../src/routes/upi-invoice')
    const env = makeEnv()
    const nowIso = new Date().toISOString()
    await casUpdate(env, fulfillmentKey(ORDER), () => ({
      op: 'set',
      value: JSON.stringify({
        orderId: ORDER, provider: 'coinbase_v3', invoiceKey: 'paymentSession_xyz789', bodyHash: 'h',
        baseAmountMinor: '136', stablecoinAmountAtomic: '1360000', state: 'queued',
        providerFinalState: null, executionRef: null, failureReason: null, razorpayPaymentId: 'p',
        createdAt: nowIso, updatedAt: nowIso, events: [],
      }),
      result: true,
    }))
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    const s = await status(env, ORDER)
    expect(s.body.state).toBe('failed')
    expect(world.payCalls.length).toBe(0)
  })
})
