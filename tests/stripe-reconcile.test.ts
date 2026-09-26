// Regression tests for the 2026-09-17 incident: a Stripe Crypto invoice paid
// through Rozo stayed `provider_paying` forever because Rozo's webhook sender
// aborted at 10s while the router was inline in pay-invoice, and nothing ever
// reconciled the record against Stripe afterwards.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  seedStripeRecord,
  stripeKvKey,
  handleStripeWebhookEvent,
  reconcileStripeRecordWithProvider,
  RECONCILE_MIN_INTERVAL_MS,
  RECONCILE_GONE_ESCALATE_AFTER,
  readDailySpentAtomic,
  sweepInFlightStripeRecords,
} from '../src/routes/stripe-fulfillment'
import { casRead } from '../src/routes/stripe-atomic'
import { handleInvoiceStatus, handleRozoWebhook } from '../src/routes/webhook'
import type { Env } from '../src/index'

function makeDoNamespace() {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const body: any = await req.json()
      if (url.pathname === '/read') {
        return Response.json({ value: store.get(body.key) ?? null, version: versions.get(body.key) ?? 0 })
      }
      if (url.pathname === '/commit') {
        const cur = versions.get(body.key) ?? 0
        if (cur !== body.expectedVersion) {
          return Response.json({ ok: false, value: store.get(body.key) ?? null, version: cur })
        }
        if (body.op === 'set') store.set(body.key, body.value)
        else store.delete(body.key)
        versions.set(body.key, body.expectedVersion + 1)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/scan') {
        const vals = [...store.entries()].filter(([k]) => k.startsWith(body.prefix)).map(([, v]) => v)
        return Response.json({ values: vals })
      }
      return new Response('Not Found', { status: 404 })
    },
  }
  return { idFromName: (n: string) => ({ name: n }), get: (_id: any) => stub }
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

const TEST_CAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    MPP_STORE: makeKv() as any,
    ATOMIC_STORE: makeDoNamespace() as any,
    PAYINVOICE_ADMIN_SECRET: 'admin',
    ROZO_INTENTS_API_KEY: 'key',
    ROZO_WEBHOOK_SECRET: 'whsec',
    BASE_RPC_URL: undefined,
    INVOICE_CAPABILITY_ENCRYPTION_KEY: TEST_CAP_KEY,
    ...extra,
  } as unknown as Env
}

const KEY = 'cpis_1UGa8xDSZgxV3MJKdwgCzGep'
const ORDER = `stripe_crypto_${KEY}`
const ROZO_ID = '38b281ad-4a74-413d-84dd-100a4914bc7e'
const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMQARoXBLOB'

async function seed(env: Env) {
  await seedStripeRecord(env, {
    invoiceKey: KEY,
    merchantAccount: 'acct_1T333NDSZgxV3MJK',
    invoiceAmountAtomic: '1360000',
    invoiceCurrency: 'usd',
    lockFingerprint: 'sha256:zz',
    stripeUrl: STRIPE_URL,
    rozoPaymentId: ROZO_ID,
  })
}

async function loadRec(env: Env): Promise<any> {
  const { value } = await casRead(env, stripeKvKey(KEY))
  return value ? JSON.parse(value) : null
}

async function forceStatus(env: Env, status: string, patch: Record<string, unknown> = {}) {
  const rec = await loadRec(env)
  Object.assign(rec, { status }, patch)
  const { version } = await casRead(env, stripeKvKey(KEY))
  await (env.ATOMIC_STORE as any).get(null).fetch(
    new Request('https://x/commit', {
      method: 'POST',
      body: JSON.stringify({ key: stripeKvKey(KEY), expectedVersion: version, op: 'set', value: JSON.stringify(rec) }),
    }),
  )
}

// A live Stripe session as resume_payin_session + payin_session return it.
function stripeSession(state: string, txId: string | null = null) {
  return {
    id: KEY,
    merchant: 'acct_1T333NDSZgxV3MJK',
    business_name: 'Command Code',
    state,
    payment_details: { amount: 136, currency: 'usd' },
    supported_currencies: [
      { id: 'usdc.base', currency_network: 'base', chain_id: 8453, asset_code: 'usdc',
        contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payment_options: ['direct_deposit', 'wallet_connect'] },
    ],
    transaction_details: txId ? { blockchain_tx_id: txId, destination_network: 'base' } : {},
    valid_before: '1789980699',
  }
}

// Mock fetch so Stripe resume/query answer with `state`, and record what was hit.
function mockStripe(state: string, txId: string | null = null, extra?: (u: string) => Response | null) {
  const hits: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    hits.push(u)
    const e = extra?.(u)
    if (e) return e
    if (u.includes('resume_payin_session')) {
      return Response.json({ sessionId: KEY, clientSecret: 'cs_test', publishableKey: 'pk_test' })
    }
    if (u.includes('payin_session')) return Response.json(stripeSession(state, txId))
    return new Response('unexpected fetch ' + u, { status: 500 })
  })
  return hits
}

afterEach(() => vi.restoreAllMocks())

describe('reconcileStripeRecordWithProvider', () => {
  it('advances a stuck provider_paying record to paid when Stripe says fulfillment_complete', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    const hits = mockStripe('fulfillment_complete', '0x6900')
    const now = new Date('2026-09-17T08:20:00Z')
    const out = await reconcileStripeRecordWithProvider(env, KEY, now)
    expect(out).toEqual({ checked: true, providerState: 'fulfillment_complete', transition: 'paid' })
    const rec = await loadRec(env)
    expect(rec.status).toBe('paid')
    expect(rec.paidAt).toBe(now.toISOString())
    expect(rec.providerResult.blockchainTxId).toBe('0x6900')
    expect(rec.events.at(-1).kind).toBe('stripe_reconciled_paid')
    // The capability was decrypted only to query Stripe: never persisted or echoed.
    expect(JSON.stringify(rec)).not.toContain('CDMQARoXBLOB')
    expect(JSON.stringify(out)).not.toContain('CDMQARoXBLOB')
    expect(hits.some((u) => u.includes('resume_payin_session'))).toBe(true)
  })

  it.each(['provider_submitted', 'provider_submitted_ambiguous'])('also reconciles %s', async (status) => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, status)
    mockStripe('fulfillment_complete')
    const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
    expect(out).toMatchObject({ transition: 'paid' })
  })

  it.each(['purchase_complete', 'fulfillment_initiated', 'succeeded', 'unknown_state'])(
    'does NOT mark paid on %s (only fulfillment_complete proves the merchant was credited)',
    async (state) => {
      const env = makeEnv()
      await seed(env)
      await forceStatus(env, 'provider_submitted')
      mockStripe(state)
      const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
      expect(out).toMatchObject({ checked: true, transition: null })
      expect((await loadRec(env)).status).toBe('provider_submitted')
    },
  )

  it('concurrent polls claim the throttle atomically: only one Stripe round-trip', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    const hits = mockStripe('processing')
    const now = new Date('2026-09-17T08:20:00Z')
    const outs = await Promise.all(
      Array.from({ length: 5 }, () => reconcileStripeRecordWithProvider(env, KEY, now)),
    )
    expect(outs.filter((o) => o.checked).length).toBe(1)
    expect(outs.filter((o) => !o.checked && o.reason === 'throttled').length).toBe(4)
    expect(hits.filter((u) => u.includes('resume_payin_session')).length).toBe(1)
  })

  it('marks failed_provider when Stripe reports a failed/canceled session', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    mockStripe('canceled')
    const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
    expect(out).toMatchObject({ transition: 'failed_provider' })
    const rec = await loadRec(env)
    expect(rec.status).toBe('failed_provider')
    expect(rec.paidAt).toBeNull()
    expect(rec.failureReason).toContain('canceled')
  })

  it('leaves an in-flight record alone while Stripe is still processing', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    mockStripe('fulfillment_initiated')
    const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
    expect(out).toMatchObject({ checked: true, transition: null })
    expect((await loadRec(env)).status).toBe('provider_paying')
  })

  it('never touches terminal or pre-settlement records (no Stripe call)', async () => {
    for (const status of ['paid', 'manual_review', 'failed_provider', 'payout_seen', 'rozo_payment_created']) {
      const env = makeEnv()
      await seed(env)
      await forceStatus(env, status)
      const spy = vi.spyOn(globalThis, 'fetch')
      const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
      expect(out).toEqual({ checked: false, reason: 'not_in_flight' })
      expect(spy).not.toHaveBeenCalled()
      expect((await loadRec(env)).status).toBe(status)
      vi.restoreAllMocks()
    }
  })

  it('reports no_record for an unknown key without calling Stripe', async () => {
    const env = makeEnv()
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await reconcileStripeRecordWithProvider(env, 'cpis_nope', new Date())).toEqual({ checked: false, reason: 'no_record' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('throttles repeated checks so a polling UI cannot amplify Stripe calls', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    const hits = mockStripe('processing')
    const t0 = new Date('2026-09-17T08:20:00Z')
    expect((await reconcileStripeRecordWithProvider(env, KEY, t0)).checked).toBe(true)
    const callsAfterFirst = hits.length
    const t1 = new Date(t0.getTime() + RECONCILE_MIN_INTERVAL_MS - 1)
    expect(await reconcileStripeRecordWithProvider(env, KEY, t1)).toEqual({ checked: false, reason: 'throttled' })
    expect(hits.length).toBe(callsAfterFirst)
    const t2 = new Date(t0.getTime() + RECONCILE_MIN_INTERVAL_MS)
    expect((await reconcileStripeRecordWithProvider(env, KEY, t2)).checked).toBe(true)
    expect(hits.length).toBeGreaterThan(callsAfterFirst)
  })

  it('a Stripe error is recorded, throttled, and changes no status', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    mockStripe('x', null, (u) => (u.includes('resume_payin_session') ? new Response('gone', { status: 410 }) : null))
    const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
    expect(out).toEqual({ checked: true, error: 'stripe_expired', transition: null })
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_paying')
    expect(rec.lastProviderCheckAt).toBeTruthy()
    expect(rec.events.at(-1).kind).toBe('stripe_reconcile_error')
  })
})

describe('handleStripeWebhookEvent safety net', () => {
  it('a throw BEFORE pay-invoice releases the claim back to payout_seen (retryable)', async () => {
    const env = makeEnv()
    await seed(env)
    // The balance RPC throws synchronously inside fetch → getBaseUsdcBalance may
    // swallow it; force a throw from the daily-spend reservation (the last
    // pre-call accounting step; the shared KV pool counter no longer exists).
    const ns: any = env.ATOMIC_STORE
    const stub = ns.get(null)
    const realFetch = stub.fetch.bind(stub)
    stub.fetch = async (req: Request) => {
      const body: any = await req.clone().json()
      if (new URL(req.url).pathname === '/commit' && String(body.key).startsWith('stripe-daily-spent:')) {
        throw new Error('DO down')
      }
      return realFetch(req)
    }
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 }),
    )
    const out = await handleStripeWebhookEvent(
      env,
      { eventId: 'e1', eventType: 'payment_payout_completed', orderId: ORDER, rozoPaymentId: ROZO_ID, invoiceAmountStr: '1.38' },
      new Date(),
    )
    expect(out).toMatchObject({ ok: true, deferred: 'settlement_error', retryable: true })
    const rec = await loadRec(env)
    expect(rec.status).toBe('payout_seen')
    expect(rec.events.at(-1).kind).toBe('stripe_claim_released_on_error')
    expect(spy.mock.calls.some(([u]: any) => String(u.url ?? u).includes('pay-invoice'))).toBe(false)
  })

  it('a throw after reservations but before pay-invoice unwinds pool + daily ledger', async () => {
    const env = makeEnv()
    await seed(env)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 }),
    )
    // Make the DO read that loads the claimed record (after both reservations)
    // fail once, by breaking the capability decrypt input instead: simplest is
    // to make the DO /read throw on the 4th+ call after reservations. Use a
    // counter on the DO stub fetch.
    const ns: any = env.ATOMIC_STORE
    const stub = ns.get(null)
    const realFetch = stub.fetch.bind(stub)
    let armed = false
    let fired = false
    stub.fetch = async (req: Request) => {
      const clone = req.clone()
      const body: any = await clone.json()
      if (armed && !fired && new URL(req.url).pathname === '/read' && String(body.key).startsWith('invoice-fulfillment:v2:')) {
        fired = true
        throw new Error('DO hiccup')
      }
      return realFetch(req)
    }
    // Arm once the daily ledger has been reserved (the last step before loadStripeRecord).
    const origPut = (env.MPP_STORE as any).put
    ;(env.MPP_STORE as any).put = async (k: string, v: string) => { await origPut(k, v) }
    const now = new Date('2026-09-17T08:20:00Z')
    // reserveDailySpend commits a stripe-daily-spent key via /commit; arm after that.
    const realCommitFetch = stub.fetch
    stub.fetch = async (req: Request) => {
      const clone = req.clone()
      const body: any = await clone.json()
      if (!fired && new URL(req.url).pathname === '/commit' && String(body.key).startsWith('stripe-daily-spent:')) armed = true
      return realCommitFetch(req)
    }
    const out = await handleStripeWebhookEvent(
      env,
      { eventId: 'e-unwind', eventType: 'payment_payout_completed', orderId: ORDER, rozoPaymentId: ROZO_ID, invoiceAmountStr: '1.38' },
      now,
    )
    expect(out).toMatchObject({ deferred: 'settlement_error', retryable: true })
    expect((await loadRec(env)).status).toBe('payout_seen')
    // Daily reservation unwound; the removed shared KV pool counter is never written.
    expect(await (env.MPP_STORE as any).get('funder-reserved-atomic')).toBeNull()
    expect(await readDailySpentAtomic(env, now)).toBe(0n)
  })

  it('a throw AFTER the pay-invoice call started ends in provider_submitted_ambiguous (never re-fired)', async () => {
    const env = makeEnv()
    await seed(env)
    let payInvoiceCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('pay-invoice')) {
        payInvoiceCalls++
        // pay-invoice ACCEPTED (money moved) …
        return Response.json({ success: true })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    // … and the very next storage step (finalizing the record in the DO)
    // throws once. Before the safety net this left the record at provider_paying.
    const ns: any = env.ATOMIC_STORE
    const stub = ns.get(null)
    const realFetch = stub.fetch.bind(stub)
    let thrown = false
    stub.fetch = async (req: Request) => {
      if (payInvoiceCalls > 0 && !thrown) {
        thrown = true
        throw new Error('DO down after sign')
      }
      return realFetch(req)
    }
    const out = await handleStripeWebhookEvent(
      env,
      { eventId: 'e2', eventType: 'payment_payout_completed', orderId: ORDER, rozoPaymentId: ROZO_ID, invoiceAmountStr: '1.38' },
      new Date(),
    )
    expect(out.status).toBe('provider_submitted_ambiguous')
    expect(payInvoiceCalls).toBe(1)
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_submitted_ambiguous')
    expect(rec.events.at(-1).kind).toBe('stripe_settlement_threw')
    // Replay → guarded, no second signing attempt.
    const again = await handleStripeWebhookEvent(
      env,
      { eventId: 'e3', eventType: 'payment_payout_completed', orderId: ORDER, rozoPaymentId: ROZO_ID, invoiceAmountStr: '1.38' },
      new Date(),
    )
    expect(again.already_in_flight).toBe(true)
    expect(payInvoiceCalls).toBe(1)
  })
})

describe('handleRozoWebhook keeps the Stripe settlement alive past the sender timeout', () => {
  it('registers the settlement promise with ctx.waitUntil', async () => {
    const env = makeEnv()
    await seed(env)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('pay-invoice')) return Response.json({ success: true })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const body = JSON.stringify({
      event_id: 'evt-1', type: 'payment_payout_completed',
      data: { id: ROZO_ID, orderId: ORDER, destination: { amount: '1.36' } },
    })
    const ts = String(Date.now())
    const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', keyMat, new TextEncoder().encode(`${ts}.${body}`))))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    const waited: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await handleRozoWebhook(
      new Request('https://x/webhook', { method: 'POST', body, headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig}` } }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ provider: 'stripe_crypto', status: 'provider_submitted' })
    expect(waited.length).toBe(1)
  })
})

describe('invoice-status Stripe lookups', () => {
  function rozoPayment() {
    return {
      id: ROZO_ID, status: 'payment_payout_completed', orderId: ORDER,
      source: { amount: '1.380000', confirmedAt: '2026-09-17T08:03:43.292+00:00', txHash: '25b1' },
      destination: { amount: '1.380000', txHash: '0x7259', confirmedAt: '2026-09-17T08:03:51+00:00' },
    }
  }

  it('rozo_payment_id of a Stripe order takes the Stripe branch and reconciles to paid', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    mockStripe('fulfillment_complete', '0x6900', (u) => (u.includes('/payments/') ? Response.json(rozoPayment()) : null))
    const res = await handleInvoiceStatus(new Request(`https://x/invoice-status?rozo_payment_id=${ROZO_ID}`), env)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.provider).toBe('stripe_crypto')
    expect(body.invoiceKey).toBe(KEY)
    expect(body.routerState.status).toBe('paid')
    expect(body.routerState.paidAt).toBeTruthy()
    expect(body.payin.confirmed).toBe(true)
    expect(body.reconcile).toMatchObject({ transition: 'paid' })
    expect(JSON.stringify(body)).not.toContain('CDMQARoXBLOB')
  })

  it.each([
    `payment_id=${ORDER}`,
    `payment_id=${KEY}`,
    `payment_id=stripe:${KEY}`,
    `payment_id=stripe:${ORDER}`,
    `invoice_key=${KEY}`,
  ])('resolves %s to the Stripe record', async (qs) => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: '2026-09-17T08:10:00.000Z' })
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('/payments/')) return Response.json(rozoPayment())
      return new Response('unexpected ' + u, { status: 500 })
    })
    const res = await handleInvoiceStatus(new Request(`https://x/invoice-status?${qs}`), env)
    const body: any = await res.json()
    expect(res.status).toBe(200)
    expect(body.invoiceKey).toBe(KEY)
    expect(body.routerState.status).toBe('paid')
    expect(body.rozo_payment_id).toBe(ROZO_ID)
    // Terminal: no Stripe call at all.
    expect(spy.mock.calls.some(([u]: any) => String(u.url ?? u).includes('stripe.com'))).toBe(false)
  })

  it('a Stripe error during reconcile does not break the status read', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    mockStripe('x', null, (u) => {
      if (u.includes('resume_payin_session')) return new Response('boom', { status: 500 })
      if (u.includes('/payments/')) return Response.json(rozoPayment())
      return null
    })
    const res = await handleInvoiceStatus(new Request(`https://x/invoice-status?payment_id=${ORDER}`), env)
    const body: any = await res.json()
    expect(res.status).toBe(200)
    expect(body.routerState.status).toBe('provider_paying')
    expect(body.reconcile).toMatchObject({ checked: true, error: 'stripe_upstream' })
  })
})

describe('provider gone (410) escalation', () => {
  it('parks the record in manual_review after repeated 410s instead of hitting Stripe forever', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    const hits = mockStripe('x', null, (u) => (u.includes('resume_payin_session') ? new Response('gone', { status: 410 }) : null))
    const t0 = Date.parse('2026-09-17T08:40:00Z')
    for (let i = 1; i < RECONCILE_GONE_ESCALATE_AFTER; i++) {
      const out = await reconcileStripeRecordWithProvider(env, KEY, new Date(t0 + i * RECONCILE_MIN_INTERVAL_MS))
      expect(out).toEqual({ checked: true, error: 'stripe_expired', transition: null })
      expect((await loadRec(env)).status).toBe('provider_paying')
    }
    const last = await reconcileStripeRecordWithProvider(env, KEY, new Date(t0 + RECONCILE_GONE_ESCALATE_AFTER * RECONCILE_MIN_INTERVAL_MS))
    expect(last).toEqual({ checked: true, error: 'stripe_expired', transition: 'manual_review' })
    const rec = await loadRec(env)
    expect(rec.status).toBe('manual_review')
    expect(rec.paidAt).toBeNull()
    expect(rec.failureReason).toContain('410')
    // Terminal now: further sweeps make no Stripe calls.
    const before = hits.length
    expect(await reconcileStripeRecordWithProvider(env, KEY, new Date(t0 + 10 * RECONCILE_MIN_INTERVAL_MS))).toEqual({ checked: false, reason: 'not_in_flight' })
    expect(hits.length).toBe(before)
  })

  it('a successful read resets the gone counter', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying', { providerGoneChecks: 2 })
    mockStripe('processing')
    await reconcileStripeRecordWithProvider(env, KEY, new Date())
    expect((await loadRec(env)).providerGoneChecks).toBe(0)
  })
})

describe('sweepInFlightStripeRecords (cron)', () => {
  it('reconciles only in-flight records and reports transitions', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_paying')
    // A second, already-paid record must be scanned but never checked.
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_done', merchantAccount: 'acct_x', invoiceAmountAtomic: '1000000', invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:d', stripeUrl: 'https://crypto.stripe.com/pay/DONE', rozoPaymentId: 'rp-done',
    })
    const { value } = await casRead(env, stripeKvKey('cpis_done'))
    const done = JSON.parse(value!); done.status = 'paid'
    const { version } = await casRead(env, stripeKvKey('cpis_done'))
    await (env.ATOMIC_STORE as any).get(null).fetch(new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey('cpis_done'), expectedVersion: version, op: 'set', value: JSON.stringify(done) }) }))
    const hits = mockStripe('fulfillment_complete', '0x6900')
    const out = await sweepInFlightStripeRecords(env, new Date('2026-09-17T08:05:00Z'))
    expect(out).toEqual({ scanned: 2, inFlight: 1, checked: 1, transitions: ['cpis_1UGa…zGep:paid'] })
    expect((await loadRec(env)).status).toBe('paid')
    expect(hits.filter((u) => u.includes('resume_payin_session')).length).toBe(1)
    expect(JSON.stringify(out)).not.toContain('CDMQARoXBLOB')
  })

  it('bounded batch is least-recently-checked first (no starvation)', async () => {
    const env = makeEnv()
    const keys = Array.from({ length: 25 }, (_, i) => `cpis_${String(i).padStart(3, '0')}`)
    for (const k of keys) {
      await seedStripeRecord(env, { invoiceKey: k, merchantAccount: 'acct', invoiceAmountAtomic: '1000000', invoiceCurrency: 'usd', lockFingerprint: 'x', stripeUrl: `https://crypto.stripe.com/pay/${k}`, rozoPaymentId: null })
      const { value } = await casRead(env, stripeKvKey(k))
      const r = JSON.parse(value!)
      r.status = 'provider_paying'
      // The first 20 in storage order were checked recently; the last 5 never.
      r.lastProviderCheckAt = keys.indexOf(k) < 20 ? '2026-09-17T08:00:00.000Z' : null
      const { version } = await casRead(env, stripeKvKey(k))
      await (env.ATOMIC_STORE as any).get(null).fetch(new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey(k), expectedVersion: version, op: 'set', value: JSON.stringify(r) }) }))
    }
    const checked: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('resume_payin_session')) {
        const body = String(init?.body ?? '')
        const m = body.match(/session_hash=(cpis_\d+)/)
        if (m) checked.push(m[1])
        return Response.json({ sessionId: m?.[1] ?? 'cpis_x', clientSecret: 'cs', publishableKey: 'pk' })
      }
      return Response.json({ id: 'x', merchant: 'acct', business_name: 'b', state: 'processing', payment_details: { amount: 100, currency: 'usd' }, supported_currencies: [], transaction_details: {}, valid_before: '1' })
    })
    const out = await sweepInFlightStripeRecords(env, new Date('2026-09-17T09:00:00Z'))
    expect(out.inFlight).toBe(25)
    expect(out.checked).toBe(20)
    // All five never-checked records are in this batch.
    for (const k of keys.slice(20)) expect(checked).toContain(k)
  })

  it('swallows a DO scan failure (never breaks the cron)', async () => {
    const env = makeEnv()
    ;(env.ATOMIC_STORE as any).get = () => ({ fetch: async () => new Response('boom', { status: 500 }) })
    expect(await sweepInFlightStripeRecords(env)).toEqual({ scanned: 0, inFlight: 0, checked: 0, transitions: [] })
  })
})
