// POST /api/invoice/verified-funding (v2, UPI rewards).
// Rows of design §5.4 / §9 (奖励履约, 崩溃, 商家范围) covered here.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  handleUpiResolve,
  handleUpiVerifiedFunding,
  handleUpiVerifiedPayIn,
  handleUpiFulfillmentStatus,
  hmacSha256Hex,
  loadFulfillment,
  fulfillmentKey,
} from '../src/routes/upi-invoice'
import { claimInvoiceKey, readInvoiceClaim } from '../src/routes/invoice-claim'
import { stopCheckout } from '../src/routes/checkout-control'
import { casUpdate } from '../src/routes/stripe-atomic'
import { approvalSigningString } from '../src/routes/upi-approval-verify'
import { rewardBindingFromCoinbase } from '../src/utils/upi-reward-binding'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

const SECRET = 'upi-internal-key-0123456789'
const ORDER = '11111111-2222-4333-8444-555555555555'
const ORDER2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PL_URL = 'https://payments.coinbase.com/payment-links/pl_abc123'
const PS_URL = 'https://payments.coinbase.com/payment-sessions/paymentSession_xyz789'
const MUGGLELINK = 'https://mugglelink.test'
const APPROVAL_URL = `${MUGGLELINK}/api/internal/rewards/verify-invoice-approval`
const TARGET = '0x1111111111111111111111111111111111111111'
const OTHER_TARGET = '0x2222222222222222222222222222222222222222'
const ESCROW = '0x3333333333333333333333333333333333333333'
const NONCE = '0x' + 'ab'.repeat(32)
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
    contractAddress: ESCROW,
    nonce: NONCE,
    merchant: { name: 'OpenRouter' },
    fiat: { amount: '10.50', currency: 'USD' },
    ...over,
  }
}

function v3Session(over: Record<string, unknown> = {}) {
  return {
    paymentSessionId: 'paymentSession_xyz789',
    status: 'PAYMENT_SESSION_STATUS_CREATED',
    amount: '11.13',
    asset: 'usdc',
    expiresAt: FUTURE.toISOString(),
    customerDisplay: { merchantName: 'OpenRouter' },
    target: { paymentTargetWallet: { address: TARGET, network: 'PAYMENT_TARGET_NETWORK_BASE' } },
    ...over,
  }
}

type Answer = { status: number; body: unknown } | 'throw' | 'hang'

interface World {
  v1: Record<string, unknown> | null
  v3: Record<string, unknown> | null
  // Optional per-fetch override sequence for the v3 session (first fetch, second, ...).
  v3Seq: Array<Record<string, unknown>>
  balanceHex: string | null
  payInvoice: Answer
  payCalls: Array<any>
  approval: Answer | 'auto-approve'
  approvalCalls: Array<{ headers: Record<string, string>; body: any; sigOk: boolean }>
}

let world: World
const originalFetch = globalThis.fetch

function respond(a: Answer): Promise<Response> {
  if (a === 'throw') return Promise.reject(new Error('ECONNRESET'))
  if (a === 'hang') return new Promise<Response>(() => {})
  return Promise.resolve(
    new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } }),
  )
}

function installFetch() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://payments.coinbase.com/next-api/payment-links/')) {
      return world.v1 ? Response.json(world.v1) : new Response('nope', { status: 404 })
    }
    if (url.startsWith('https://payments.coinbase.com/next-api/payment-sessions/')) {
      const next = world.v3Seq.shift()
      const v = next ?? world.v3
      return v ? Response.json(v) : new Response('nope', { status: 404 })
    }
    if (url === 'https://agentapi.rozo.ai/pay-invoice') {
      world.payCalls.push(JSON.parse(String(init?.body ?? '{}')))
      return respond(world.payInvoice)
    }
    if (url === APPROVAL_URL) {
      const h = new Headers(init?.headers)
      const raw = String(init?.body ?? '')
      const ts = h.get('x-timestamp') ?? ''
      const nonce = h.get('x-nonce') ?? ''
      const sig = await hmacSha256Hex(SECRET, approvalSigningString(ts, nonce, raw))
      const body = JSON.parse(raw)
      world.approvalCalls.push({
        headers: Object.fromEntries(h.entries()),
        body,
        sigOk: sig === h.get('x-signature') && /^[0-9a-f]{32}$/.test(nonce) && h.get('x-internal-key') === SECRET,
      })
      if (world.approval === 'auto-approve') {
        return Response.json({ approval_id: body.approval_id, approved: true, reason: 'ok', valid_until: FUTURE.toISOString() })
      }
      return respond(world.approval)
    }
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
    UPI_VERIFIED_FUNDING_V2_ENABLED: 'true',
    UPI_V2_MAX_CREDIT_MICRO: '50000000',
    UPI_MUGGLELINK_BASE_URL: MUGGLELINK,
    ...extra,
  } as unknown as Env
}

async function quote(env: Env, url: string) {
  const res = await handleUpiResolve(
    new Request('https://x/api/invoice/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': SECRET },
      body: JSON.stringify({ pay_url: url }),
    }),
    env,
  )
  const body = (await res.json()) as any
  expect(body.payable).toBe(true)
  return body
}

// v3 $11.13 fully paid with reward credit.
function creditBody(q: any, over: Record<string, unknown> = {}, funding: Record<string, unknown> = {}) {
  const gross = over.gross_amount_minor ?? q.base_amount_minor
  return {
    schema_version: 2,
    order_id: ORDER,
    provider: q.provider,
    invoice_key: q.invoice_key,
    quote_id: q.quote_id,
    quote_expires_at: q.expires_at,
    base_amount_minor: q.base_amount_minor,
    gross_amount_minor: gross,
    funding: {
      credit_micro: String(Number(gross) * 10_000),
      cash_minor: 0,
      redemption_id: 'red_1',
      merchant_approval_id: 'appr_1',
      ...funding,
    },
    cash_payment: null,
    ...over,
  }
}

async function fundingReq(body: Record<string, unknown>, over: { key?: string; sig?: string; idem?: string } = {}) {
  const raw = JSON.stringify(body)
  return new Request('https://x/api/invoice/verified-funding', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': over.key ?? SECRET,
      'x-signature': over.sig ?? (await hmacSha256Hex(SECRET, raw)),
      'x-idempotency-key': over.idem ?? String(body.order_id),
    },
    body: raw,
  })
}

async function fund(env: Env, body: Record<string, unknown>, over?: { key?: string; sig?: string; idem?: string }, ctx?: ExecutionContext) {
  const res = await handleUpiVerifiedFunding(await fundingReq(body, over), env, ctx ? { ctx } : {})
  return { status: res.status, body: (await res.json()) as any }
}

async function status(env: Env, orderId = ORDER) {
  const res = await handleUpiFulfillmentStatus(
    new Request(`https://x/api/invoice/fulfillment/${orderId}`, { headers: { 'x-internal-key': SECRET } }),
    env,
    orderId,
  )
  return { status: res.status, body: (await res.json()) as any }
}

beforeEach(() => {
  world = {
    v1: v1Link(),
    v3: v3Session(),
    v3Seq: [],
    balanceHex: '0x' + (1_000_000_000n).toString(16),
    payInvoice: { status: 200, body: { success: false, mode: 'admin' } },
    payCalls: [],
    approval: 'auto-approve',
    approvalCalls: [],
  }
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ── Auth and body contract ──────────────────────────────────────────────────

describe('verified-funding: auth and body contract', () => {
  it('reuses the v1 internal key, raw-body HMAC and idempotency key rules', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const b = creditBody(q)
    expect((await fund(env, b, { key: 'wrong' })).status).toBe(401)
    expect((await fund(env, b, { sig: '0'.repeat(64) })).body.error).toBe('invalid_signature')
    expect((await fund(env, b, { idem: ORDER2 })).body.error).toBe('idempotency_key_mismatch')
    expect(await loadFulfillment(env, ORDER)).toBeNull()
  })

  it('validates integers, the funding equation and the cash/credit mode', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...creditBody(q), schema_version: 1 }, 'schema_version'],
      [creditBody(q, {}, { credit_micro: '11120000' }), 'must equal'],
      [creditBody(q, {}, { credit_micro: '11130000.5' }), 'credit_micro'],
      [creditBody(q, {}, { credit_micro: ' 11130000' }), 'credit_micro'],
      [creditBody(q, { gross_amount_minor: 1.5 }), 'gross_amount_minor'],
      [creditBody(q, { gross_amount_minor: 1000 }), 'gross_amount_minor must be >='],
      [{ ...creditBody(q), cash_payment: { razorpay_order_id: 'o', razorpay_payment_id: 'p', captured_at: 'now', currency: 'USD', amount_minor: 1 } }, 'cash_payment must be null'],
      [creditBody(q, {}, { merchant_approval_id: null }), 'merchant_approval_id'],
      [creditBody(q, { gross_amount_minor: 1180 }, { credit_micro: '10000000', cash_minor: 180 }), 'cash_payment is required'],
      [
        {
          ...creditBody(q, { gross_amount_minor: 1180 }, { credit_micro: '10000000', cash_minor: 180 }),
          cash_payment: { razorpay_order_id: 'o', razorpay_payment_id: 'p', captured_at: 'now', currency: 'USD', amount_minor: 179 },
        },
        'does not match cash_minor',
      ],
      [{ ...creditBody(q), provider: 'stripe_crypto' }, 'provider must be coinbase_v1|coinbase_v3'],
    ]
    for (const [b, msg] of bad) {
      const r = await fund(env, b)
      expect(r.status, msg).toBe(400)
      expect(r.body.message).toContain(msg)
    }
    // Zero cash with zero credit is impossible (gross > 0 forces credit).
    expect(world.payCalls.length).toBe(0)
    expect(await loadFulfillment(env, ORDER)).toBeNull()
  })
})

// ── Happy paths ─────────────────────────────────────────────────────────────

describe('verified-funding: execution', () => {
  it('credit-only v3: verifies approval, passes expected_binding, paid only on CAPTURE_SUCCEEDED', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const r = await fund(env, creditBody(q))
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ state: 'processing', execution_phase: 'accepted', failure_class: null, funding_kind: 'credit_only' })

    // Approval checked twice (before claim, before execute), correctly signed.
    expect(world.approvalCalls.length).toBe(2)
    const fp = (await rewardBindingFromCoinbase(v3Session())).fingerprint
    for (const c of world.approvalCalls) {
      expect(c.sigOk).toBe(true)
      expect(c.body).toEqual({
        approval_id: 'appr_1',
        provider: 'coinbase_v3',
        invoice_key: 'paymentSession_xyz789',
        fingerprint_version: 'upi-reward-binding-v1',
        fingerprint: fp,
        base_minor: 1113,
        expires_at: FUTURE.toISOString(),
      })
    }
    expect(world.approvalCalls[0].headers['x-nonce']).not.toBe(world.approvalCalls[1].headers['x-nonce'])

    expect(world.payCalls).toEqual([
      {
        payment_id: 'paymentSession_xyz789',
        expected_binding: {
          version: 'upi-reward-binding-v1',
          invoice_key: 'paymentSession_xyz789',
          amount_atomic: '11130000',
          fingerprint: fp,
        },
      },
    ])
    const rec = await loadFulfillment(env, ORDER)
    expect(rec?.funding).toMatchObject({ kind: 'credit_only', creditMicro: '11130000', cashMinor: '0', redemptionId: 'red_1', merchantApprovalId: 'appr_1' })
    expect(rec?.razorpayPaymentId).toBeNull()
    expect(rec?.attemptId).toMatch(/^[0-9a-f-]{36}$/)

    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_AUTHORIZATION_PENDING' })
    expect((await status(env)).body).toMatchObject({ state: 'processing', execution_phase: 'accepted' })
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    expect((await status(env)).body).toMatchObject({ state: 'paid', execution_phase: 'terminal', failure_class: null })
    expect(world.payCalls.length).toBe(1)
  })

  it('mixed v1: records cash evidence and settles once', async () => {
    const env = makeEnv()
    const q = await quote(env, PL_URL)
    const body = {
      ...creditBody(q, { gross_amount_minor: 1113 }, { credit_micro: '10000000', cash_minor: 113 }),
      cash_payment: { razorpay_order_id: 'order_r', razorpay_payment_id: 'pay_r', captured_at: new Date().toISOString(), currency: 'USD', amount_minor: 113 },
    }
    const r = await fund(env, body)
    expect(r.status).toBe(202)
    expect(r.body.funding_kind).toBe('mixed')
    expect(world.payCalls[0].expected_binding.amount_atomic).toBe('10500000')
    expect(world.payCalls[0].expected_binding.fingerprint).toBe((await rewardBindingFromCoinbase(v1Link())).fingerprint)
    const rec = await loadFulfillment(env, ORDER)
    expect(rec?.cashEvidence).toMatchObject({ razorpayPaymentId: 'pay_r', amountMinor: '113', currency: 'USD' })
    expect(rec?.razorpayPaymentId).toBe('pay_r')
    world.v1 = v1Link({ usageCount: 1 })
    expect((await status(env)).body.state).toBe('paid')
  })

  it('cash-only v2 needs no approval but still binds the signer', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const body = {
      ...creditBody(q, {}, { credit_micro: '0', cash_minor: 1113, redemption_id: null, merchant_approval_id: null }),
      cash_payment: { razorpay_order_id: 'o', razorpay_payment_id: 'p', captured_at: 'x', currency: 'INR', amount_minor: 98765 },
    }
    const r = await fund(env, body)
    expect(r.status).toBe(202)
    expect(r.body.funding_kind).toBe('cash_only')
    expect(world.approvalCalls.length).toBe(0)
    expect(world.payCalls[0].expected_binding).toBeDefined()
  })

  it('same order + same body returns the existing result; different body → 409; never re-executes', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const b = creditBody(q)
    expect((await fund(env, b)).status).toBe(202)
    const again = await fund(env, b)
    expect(again.status).toBe(202)
    expect(again.body.execution_phase).toBe('accepted')
    const diff = await fund(env, creditBody(q, {}, { redemption_id: 'red_2' }))
    expect(diff.status).toBe(409)
    expect(diff.body.error).toBe('order_body_mismatch')
    expect(world.payCalls.length).toBe(1)
  })
})

// ── Refusal barriers (pre_execution_refusal) ────────────────────────────────

describe('verified-funding: persistent pre-execution refusals', () => {
  async function expectBarrier(env: Env, r: { status: number; body: any }, code: string) {
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ error: code, state: 'failed', execution_phase: 'not_started', failure_class: 'pre_execution_refusal' })
    const s = await status(env)
    expect(s.body).toMatchObject({ state: 'failed', execution_phase: 'not_started', failure_class: 'pre_execution_refusal', reason: code })
    expect(world.payCalls.length).toBe(0)
  }

  it('v2 switch is off by default (fail closed) and the refusal is durable', async () => {
    const env = makeEnv({ UPI_VERIFIED_FUNDING_V2_ENABLED: undefined })
    const q = await quote(env, PS_URL)
    const b = creditBody(q)
    await expectBarrier(env, await fund(env, b), 'v2_disabled')
    // Switching on later does not resurrect the order.
    ;(env as any).UPI_VERIFIED_FUNDING_V2_ENABLED = 'true'
    await expectBarrier(env, await fund(env, b), 'v2_disabled')
  })

  it('checkout pause and over-limit credit refuse before anything; an unset limit is no limit', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    await stopCheckout(env, { reason: 'test', actor: 'test' } as any)
    await expectBarrier(env, await fund(env, creditBody(q)), 'checkout_paused')

    const env2 = makeEnv({ UPI_V2_MAX_CREDIT_MICRO: undefined })
    const r2 = await fund(env2, creditBody(await quote(env2, PS_URL)))
    expect(r2.status).toBe(202)
    expect(r2.body.failure_class).toBeNull()
    expect(world.payCalls.length).toBe(1)
    world.approvalCalls.length = 0
    world.payCalls.length = 0

    const envBad = makeEnv({ UPI_V2_MAX_CREDIT_MICRO: '10 dollars' })
    await expectBarrier(envBad, await fund(envBad, creditBody(await quote(envBad, PS_URL))), 'limit_misconfigured')

    const env3 = makeEnv({ UPI_V2_MAX_CREDIT_MICRO: '11129999' })
    await expectBarrier(env3, await fund(env3, creditBody(await quote(env3, PS_URL))), 'over_credit_limit')
    expect(world.approvalCalls.length).toBe(0)
  })

  it('invalid quote and changed invoice amount are refused and persisted', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    await expectBarrier(env, await fund(env, creditBody(q, { quote_id: 'f'.repeat(64) })), 'invalid_quote')

    const env2 = makeEnv()
    const q2 = await quote(env2, PS_URL)
    world.v3 = v3Session({ amount: '11.14' })
    await expectBarrier(env2, await fund(env2, creditBody(q2)), 'invoice_changed')
  })

  it('merchant scope: not approved / revoked / expired approval refuse; later approval cannot revive', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.approval = { status: 200, body: { approval_id: 'appr_1', approved: false, reason: 'revoked', valid_until: null } }
    await expectBarrier(env, await fund(env, creditBody(q)), 'merchant_not_approved:revoked')
    world.approval = 'auto-approve'
    await expectBarrier(env, await fund(env, creditBody(q)), 'merchant_not_approved:revoked')

    const env2 = makeEnv()
    world.approval = { status: 200, body: { approval_id: 'appr_1', approved: true, reason: 'ok', valid_until: new Date(Date.now() - 1000).toISOString() } }
    await expectBarrier(env2, await fund(env2, creditBody(await quote(env2, PS_URL))), 'merchant_not_approved:expired')
  })

  it('a look-alike merchant name does not help: an unapproved fingerprint is refused', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.approval = { status: 200, body: { approval_id: 'appr_1', approved: false, reason: 'mismatch', valid_until: null } }
    await expectBarrier(env, await fund(env, creditBody(q)), 'merchant_not_approved:mismatch')
  })

  it('target swapped between the pre-claim and pre-execute checks → binding_changed, claim released', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.v3Seq = [v3Session(), v3Session({ target: { paymentTargetWallet: { address: OTHER_TARGET, network: 'PAYMENT_TARGET_NETWORK_BASE' } } })]
    await expectBarrier(env, await fund(env, creditBody(q)), 'binding_changed')
    expect(await readInvoiceClaim(env, 'paymentSession_xyz789')).toBeNull()
  })

  it('a payload without a verifiable target is refused (binding_invalid)', async () => {
    const env = makeEnv()
    const q = await quote(env, PL_URL)
    world.v1 = v1Link({ nonce: undefined })
    await expectBarrier(env, await fund(env, creditBody(q)), 'binding_invalid')
  })

  it('insufficient funder balance is a pre-execution refusal', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.balanceHex = '0x' + (1_000n).toString(16)
    await expectBarrier(env, await fund(env, creditBody(q)), 'insufficient_funder_balance')
  })

  it('invoice paid by another party while queued → refusal, never paid', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.approval = { status: 503, body: {} }
    expect((await fund(env, creditBody(q))).body.state).toBe('queued')
    world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
    expect((await status(env)).body).toMatchObject({ state: 'failed', failure_class: 'pre_execution_refusal', reason: 'paid_by_other_party' })
    expect(world.payCalls.length).toBe(0)
  })
})

// ── Approval service unavailable ────────────────────────────────────────────

describe('verified-funding: eligibility_unavailable keeps the order queued', () => {
  for (const [label, answer] of [
    ['timeout/network', 'throw'],
    ['5xx', { status: 502, body: {} }],
    ['401 (signature/replay)', { status: 401, body: { error: 'unauthorized' } }],
    ['non-JSON / wrong approval id', { status: 200, body: { approval_id: 'other', approved: true } }],
    ['approved but reason revoked', { status: 200, body: { approval_id: 'appr_1', approved: true, reason: 'revoked', valid_until: new Date(Date.now() + 3_600_000).toISOString() } }],
    ['approved without valid_until', { status: 200, body: { approval_id: 'appr_1', approved: true, reason: 'ok' } }],
  ] as Array<[string, Answer]>) {
    it(`${label}: queued, not executed, not refused; a later replay proceeds once`, async () => {
      const env = makeEnv()
      const q = await quote(env, PS_URL)
      world.approval = answer
      const r = await fund(env, creditBody(q))
      expect(r.status).toBe(202)
      expect(r.body).toMatchObject({ state: 'queued', execution_phase: 'not_started', failure_class: null, reason: 'eligibility_unavailable' })
      expect(world.payCalls.length).toBe(0)
      expect((await status(env)).body.state).toBe('queued')

      world.approval = 'auto-approve'
      const again = await fund(env, creditBody(q))
      expect(again.body.execution_phase).toBe('accepted')
      expect(world.payCalls.length).toBe(1)
      expect((await fund(env, creditBody(q))).body.execution_phase).toBe('accepted')
      expect(world.payCalls.length).toBe(1)
    })
  }

  it('missing MuggleLink base URL is unavailable, not a refusal', async () => {
    const env = makeEnv({ UPI_MUGGLELINK_BASE_URL: undefined })
    const r = await fund(env, creditBody(await quote(env, PS_URL)))
    expect(r.body).toMatchObject({ state: 'queued', reason: 'eligibility_unavailable' })
    expect(world.approvalCalls.length).toBe(0)
  })
})

// ── Downstream outcome mapping (§5.4) ───────────────────────────────────────

describe('verified-funding: downstream result mapping', () => {
  it('structured PRE_SIGN_BINDING_MISMATCH (payment_attempted:false) → definite_not_paid, claim released', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.payInvoice = { status: 422, body: { error_code: 'PRE_SIGN_BINDING_MISMATCH', payment_attempted: false } }
    const r = await fund(env, creditBody(q))
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ state: 'failed', execution_phase: 'terminal', failure_class: 'definite_not_paid' })
    expect(await readInvoiceClaim(env, 'paymentSession_xyz789')).toBeNull()
    expect((await status(env)).body.failure_class).toBe('definite_not_paid')
  })

  for (const [label, answer] of [
    ['422 without the structured code', { status: 422, body: { error: 'nope' } }],
    ['422 code but payment_attempted not false', { status: 422, body: { error_code: 'PRE_SIGN_BINDING_MISMATCH', payment_attempted: true } }],
    ['409', { status: 409, body: { error: 'already used' } }],
    ['400', { status: 400, body: { error: 'bad' } }],
    ['500', { status: 500, body: { error: 'boom' } }],
    ['404', { status: 404, body: 'not found' }],
    ['transport error', 'throw'],
  ] as Array<[string, Answer]>) {
    it(`${label} after the call → unknown/ambiguous, claim kept, never re-called`, async () => {
      const env = makeEnv()
      const q = await quote(env, PS_URL)
      world.payInvoice = answer
      const r = await fund(env, creditBody(q))
      expect(r.body).toMatchObject({ state: 'unknown', execution_phase: 'calling', failure_class: 'ambiguous' })
      expect(await readInvoiceClaim(env, 'paymentSession_xyz789')).toMatchObject({ channel: 'upi', ref: ORDER })
      await fund(env, creditBody(q))
      await status(env)
      expect(world.payCalls.length).toBe(1)
      // Provider later shows the capture: the order is paid.
      world.v3 = v3Session({ status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' })
      expect((await status(env)).body).toMatchObject({ state: 'paid', execution_phase: 'terminal', failure_class: null })
    })
  }
})

// ── Crash recovery ──────────────────────────────────────────────────────────

describe('verified-funding: crash recovery', () => {
  async function seed(env: Env, mutate: (r: any) => void) {
    // Build a real record via an unavailable approval, then rewrite it into
    // the post-crash shape under test.
    const q = await quote(env, PS_URL)
    world.approval = { status: 503, body: {} }
    await fund(env, creditBody(q))
    world.approval = 'auto-approve'
    await casUpdate(env, fulfillmentKey(ORDER), (raw) => {
      const r = JSON.parse(raw as string)
      mutate(r)
      return { op: 'set', value: JSON.stringify(r), result: true }
    })
    return q
  }

  it('crash after binding freeze + claim, before taking the execution right → replay executes exactly once', async () => {
    const env = makeEnv()
    const fp = (await rewardBindingFromCoinbase(v3Session())).fingerprint
    const q = await seed(env, (r) => {
      r.queuedReason = 'claiming'
      r.binding = { version: 'upi-reward-binding-v1', fingerprint: fp, amountAtomic: '11130000', usdCents: '1113', approvalId: 'appr_1', approvalValidUntil: null }
    })
    expect((await claimInvoiceKey(env, 'paymentSession_xyz789', 'upi', ORDER)).ok).toBe(true)
    const r = await fund(env, creditBody(q))
    expect(r.body.execution_phase).toBe('accepted')
    expect(world.payCalls.length).toBe(1)
  })

  it('crash after entering the call (phase calling) → replays never re-call; stale → unknown/ambiguous', async () => {
    const env = makeEnv()
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString()
    const q = await seed(env, (r) => {
      r.state = 'processing'
      r.executionPhase = 'calling'
      r.attemptId = 'attempt-1'
      r.updatedAt = old
    })
    const r = await fund(env, creditBody(q))
    expect(r.body).toMatchObject({ state: 'processing', execution_phase: 'calling' })
    expect(world.payCalls.length).toBe(0)
    const s = await status(env)
    expect(s.body).toMatchObject({ state: 'unknown', execution_phase: 'calling', failure_class: 'ambiguous' })
    await fund(env, creditBody(q))
    expect(world.payCalls.length).toBe(0)
  })

  it('a hung executor call (worker lost) leaves phase calling; a replay does not call again', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    world.payInvoice = 'hang'
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const r = await fund(env, creditBody(q), undefined, ctx)
    expect(r.body).toMatchObject({ state: 'processing', execution_phase: 'calling' })
    await new Promise((res) => setTimeout(res, 10))
    const again = await fund(env, creditBody(q))
    expect(again.body.execution_phase).toBe('calling')
    expect(world.payCalls.length).toBe(1)
  })

  it('concurrent identical deliveries take the execution right once (atomic CAS)', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const b = creditBody(q)
    const results = await Promise.all([fund(env, b), fund(env, b), fund(env, b)])
    expect(world.payCalls.length).toBe(1)
    for (const r of results) expect(r.status).toBe(202)
  })
})

// ── Shared claim with v1 / crypto ───────────────────────────────────────────

describe('verified-funding: one claim namespace shared with v1, crypto and coupon', () => {
  it('a crypto-held invoice is refused as already_claimed (not_started barrier)', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    expect((await claimInvoiceKey(env, 'paymentSession_xyz789', 'crypto', 'paymentSession_xyz789')).ok).toBe(true)
    const r = await fund(env, creditBody(q))
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'already_claimed', state: 'failed', execution_phase: 'not_started', failure_class: 'pre_execution_refusal' })
    expect(world.payCalls.length).toBe(0)
    // The crypto holder's claim is untouched.
    expect(await readInvoiceClaim(env, 'paymentSession_xyz789')).toMatchObject({ channel: 'crypto' })
  })

  it('v1 and v2 orders for the same invoice: exactly one executes', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const v1Raw = JSON.stringify({
      order_id: ORDER2,
      provider: q.provider,
      invoice_key: q.invoice_key,
      quote_id: q.quote_id,
      base_amount_minor: q.base_amount_minor,
      razorpay_order_id: 'o',
      razorpay_payment_id: 'p',
      captured_at: new Date().toISOString(),
    })
    const v1Res = await handleUpiVerifiedPayIn(
      new Request('https://x/api/invoice/verified-pay-in', {
        method: 'POST',
        headers: { 'x-internal-key': SECRET, 'x-signature': await hmacSha256Hex(SECRET, v1Raw), 'x-idempotency-key': ORDER2 },
        body: v1Raw,
      }),
      env,
    )
    expect(v1Res.status).toBe(202)
    expect(world.payCalls).toEqual([{ payment_id: 'paymentSession_xyz789' }]) // v1 body unchanged
    const r = await fund(env, creditBody(q))
    expect(r.status).toBe(409)
    expect(world.payCalls.length).toBe(1)
  })

  it('an order_id already used by v1 cannot be replayed as v2 (different body → 409)', async () => {
    const env = makeEnv()
    const q = await quote(env, PS_URL)
    const v1Raw = JSON.stringify({
      order_id: ORDER, provider: q.provider, invoice_key: q.invoice_key, quote_id: q.quote_id,
      base_amount_minor: q.base_amount_minor, razorpay_order_id: 'o', razorpay_payment_id: 'p', captured_at: 'x',
    })
    await handleUpiVerifiedPayIn(
      new Request('https://x/api/invoice/verified-pay-in', {
        method: 'POST',
        headers: { 'x-internal-key': SECRET, 'x-signature': await hmacSha256Hex(SECRET, v1Raw), 'x-idempotency-key': ORDER },
        body: v1Raw,
      }),
      env,
    )
    expect((await fund(env, creditBody(q))).status).toBe(409)
    expect(world.payCalls.length).toBe(1)
    // v1 status payload keeps its original shape.
    expect(Object.keys((await status(env)).body).sort()).toEqual(['execution_ref', 'provider_final_state', 'state', 'updated_at'])
  })
})
