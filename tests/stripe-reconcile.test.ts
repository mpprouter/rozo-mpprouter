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
  retryAmbiguousStripeRecord,
  AMBIGUOUS_RETRY_GRACE_MS,
  AMBIGUOUS_MAX_AUTO_RETRIES,
} from '../src/routes/stripe-fulfillment'
import { handleStripeFulfillmentRetry } from '../src/routes/stripe-fulfillment-admin'
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

describe('stuck-order Intercom tickets (S3, Stripe)', () => {
  const TICKET_ENV = {
    INTERCOM_TICKET_TOKEN: 'ic-test-token',
    INTERCOM_TICKET_TYPE_ID: '4',
    INTERCOM_TICKET_CONTACT_ID: 'contact-internal',
  } as Partial<Env>
  const NOW = new Date('2026-09-28T10:00:00Z')
  const minsBefore = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

  function mockWithIntercom(state: string, intercomStatus: number | 'throw' = 200) {
    const tickets: any[] = []
    const hits = mockStripe(state, null, (u) => null)
    const inner = (globalThis.fetch as any).getMockImplementation()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('api.intercom.io/tickets')) {
        tickets.push({ body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('Authorization') })
        if (intercomStatus === 'throw') throw new TypeError('down')
        return Response.json({ id: '888' }, { status: intercomStatus })
      }
      return inner(input, init)
    })
    return { hits, tickets }
  }

  async function seedStuck(env: Env, status: string, payinMinsAgo: number, patch: Record<string, unknown> = {}) {
    await seed(env)
    await forceStatus(env, status, {
      events: [{ kind: 'payment_payin_completed', at: minsBefore(payinMinsAgo), event_id: 'e1' }],
      lastProviderCheckAt: null,
      ...patch,
    })
  }

  it('in flight 15+ min after payin → exactly one ticket, across repeated sweeps', async () => {
    const env = makeEnv(TICKET_ENV)
    await seedStuck(env, 'provider_submitted', 20)
    const { tickets } = mockWithIntercom('processing')
    await sweepInFlightStripeRecords(env, NOW)
    await sweepInFlightStripeRecords(env, new Date(NOW.getTime() + 120_000))
    expect(tickets).toHaveLength(1)
    const desc: string = tickets[0].body.ticket_attributes._default_description_
    expect(desc).toContain(`https://checkout.rozo.ai/status?id=${ROZO_ID}`)
    expect(desc).toContain('1.36 USD')
    expect(desc).toContain(minsBefore(20))
    expect(desc).not.toContain(KEY) // session id masked
    expect(desc).not.toContain('CDMQARoXBLOB')
    expect((await loadRec(env)).stuckTicketAt).toBe(NOW.toISOString())
  })

  it('under 15 min, paid, or payin older than 2 h → no ticket', async () => {
    for (const [status, mins] of [['provider_submitted', 10], ['paid', 30], ['manual_review', 60 * 3]] as const) {
      const env = makeEnv(TICKET_ENV)
      await seedStuck(env, status, mins)
      const { tickets } = mockWithIntercom('processing')
      await sweepInFlightStripeRecords(env, NOW)
      expect(tickets).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })

  it('in flight but not freshly checked against Stripe (throttled) → no ticket on a stale local status', async () => {
    const env = makeEnv(TICKET_ENV)
    // Checked just now by someone else (throttles this sweep's reconcile), but
    // the only reconcile outcome on record is 30 minutes old.
    await seedStuck(env, 'provider_submitted', 40, {
      lastProviderCheckAt: NOW.toISOString(),
      events: [
        { kind: 'payment_payin_completed', at: minsBefore(40), event_id: 'e1' },
        { kind: 'stripe_reconcile_checked', at: minsBefore(30), detail: { state: 'processing' } },
      ],
    })
    const { tickets } = mockWithIntercom('processing')
    await sweepInFlightStripeRecords(env, NOW)
    expect(tickets).toHaveLength(0)
  })

  it('in flight and Stripe read fails → no ticket (unpaid is not proven)', async () => {
    const env = makeEnv(TICKET_ENV)
    await seedStuck(env, 'provider_submitted', 20)
    const { tickets } = mockWithIntercom('processing')
    const inner = (globalThis.fetch as any).getMockImplementation()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('stripe.com')) return new Response('down', { status: 500 })
      return inner(input, init)
    })
    await sweepInFlightStripeRecords(env, NOW)
    expect((await loadRec(env)).events.some((e: any) => e.kind === 'stripe_reconcile_error')).toBe(true)
    expect(tickets).toHaveLength(0)
  })

  it('a record the provider confirms paid in this sweep is not ticketed', async () => {
    const env = makeEnv(TICKET_ENV)
    await seedStuck(env, 'provider_submitted', 20)
    const { tickets } = mockWithIntercom('fulfillment_complete')
    await sweepInFlightStripeRecords(env, NOW)
    expect((await loadRec(env)).status).toBe('paid')
    expect(tickets).toHaveLength(0)
  })

  it('manual_review (terminal) after payin → one ticket with the failure reason', async () => {
    const env = makeEnv(TICKET_ENV)
    await seedStuck(env, 'manual_review', 40, { failureReason: 'stripe session no longer resumable' })
    const { tickets } = mockWithIntercom('processing')
    await sweepInFlightStripeRecords(env, NOW)
    await sweepInFlightStripeRecords(env, NOW)
    expect(tickets).toHaveLength(1)
    expect(tickets[0].body.ticket_attributes._default_description_).toContain('no longer resumable')
  })

  it('no token → skipped and no marker claimed; Intercom failure → marker kept, no retry', async () => {
    const env1 = makeEnv({ ...TICKET_ENV, INTERCOM_TICKET_TOKEN: undefined })
    await seedStuck(env1, 'provider_submitted', 20)
    const a = mockWithIntercom('processing')
    await sweepInFlightStripeRecords(env1, NOW)
    expect(a.tickets).toHaveLength(0)
    expect((await casRead(env1, stripeKvKey(KEY))).value).not.toContain('stuckTicketAt')
    vi.restoreAllMocks()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env2 = makeEnv(TICKET_ENV)
    await seedStuck(env2, 'provider_submitted', 20)
    const b = mockWithIntercom('processing', 500)
    await sweepInFlightStripeRecords(env2, NOW)
    await sweepInFlightStripeRecords(env2, NOW)
    expect(b.tickets).toHaveLength(1)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('ic-test-token')
  })

  it('bounded: at most STUCK_TICKETS_PER_RUN tickets per sweep', async () => {
    const env = makeEnv(TICKET_ENV)
    for (let i = 0; i < 8; i++) {
      const k = `cpis_stuck${String(i).padStart(4, '0')}`
      await seedStripeRecord(env, { invoiceKey: k, merchantAccount: 'acct', invoiceAmountAtomic: '1000000', invoiceCurrency: 'usd', lockFingerprint: 'x', stripeUrl: `https://crypto.stripe.com/pay/${k}`, rozoPaymentId: null })
      const { value, version } = await casRead(env, stripeKvKey(k))
      const r = JSON.parse(value!)
      r.status = 'manual_review'
      r.events = [{ kind: 'payment_payout_completed', at: minsBefore(30) }]
      await (env.ATOMIC_STORE as any).get(null).fetch(new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey(k), expectedVersion: version, op: 'set', value: JSON.stringify(r) }) }))
    }
    const { tickets } = mockWithIntercom('processing')
    await sweepInFlightStripeRecords(env, NOW)
    expect(tickets).toHaveLength(5)
    await sweepInFlightStripeRecords(env, NOW)
    expect(tickets).toHaveLength(8)
    // No Rozo id → the status link falls back to the provider-qualified order id.
    expect(tickets[0].body.ticket_attributes._default_description_).toMatch(/status\?id=stripe_crypto_cpis_stuck/)
  })
})


// ── Ambiguous auto-retry (2026-10-26, cpis_1UUso…) ──────────────────────────
//
// pay-invoice answered 5xx before any Permit existed (public Base RPC / Stripe
// read failed). The router parked the record as provider_submitted_ambiguous
// and, by design, never re-fired; Stripe meanwhile still showed the session
// untouched in `checkout`. Founder 2026-10-26: retry on our own when Stripe
// proves nothing was purchased.
describe('ambiguous auto-retry', () => {
  afterEach(() => vi.restoreAllMocks())

  // Full settlement-path mock: Stripe reads answer `state`, the funder RPC
  // balance is plenty, pay-invoice answers `payInvoice` (default: accepted).
  function mockPath(state: string, payInvoice: () => Response = () => Response.json({ success: true })) {
    const calls = { payInvoice: 0, resume: 0 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('pay-invoice')) {
        calls.payInvoice++
        return payInvoice()
      }
      if (u.includes('resume_payin_session')) {
        calls.resume++
        return Response.json({ sessionId: KEY, clientSecret: 'cs_test', publishableKey: 'pk_test' })
      }
      if (u.includes('payin_session')) return Response.json(stripeSession(state))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    return calls
  }

  async function parkAmbiguous(env: Env, at: Date, extra: Record<string, unknown> = {}, detail: Record<string, unknown> = { status: 502 }) {
    await forceStatus(env, 'provider_submitted_ambiguous', {
      failureReason: 'pay-invoice ambiguous (status 502) — needs reconciliation',
      events: [{ kind: 'stripe_confirm_ambiguous', at: at.toISOString(), detail }],
      ...extra,
    })
  }

  it('cron: after the grace period, Stripe still in checkout → re-drives once through the normal path', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - AMBIGUOUS_RETRY_GRACE_MS - 1000))
    const calls = mockPath('checkout')
    const out = await sweepInFlightStripeRecords(env, new Date(t0))
    expect(calls.payInvoice).toBe(1)
    expect(out.transitions.some((t) => t.endsWith(':retry#1'))).toBe(true)
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_submitted')
    expect(rec.ambiguousRetries).toBe(1)
    const kinds = rec.events.map((e: any) => e.kind)
    expect(kinds).toContain('stripe_ambiguous_retry')
    expect(kinds.indexOf('stripe_ambiguous_retry')).toBeLessThan(kinds.indexOf('stripe_confirm_submitted'))
    // The retry is the same claim holder: no LINK_CLAIMED, and the event id is deterministic.
    expect(rec.webhookEventIds).toContain(`ambiguous-retry:${KEY}:1`)
  })

  it('cron: inside the grace period nothing is sent', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - 30_000))
    const calls = mockPath('checkout')
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect(calls.payInvoice).toBe(0)
    expect((await loadRec(env)).status).toBe('provider_submitted_ambiguous')
    const out = await retryAmbiguousStripeRecord(env, KEY, new Date(t0 + 1000), { source: 'cron' })
    expect(out).toMatchObject({ retried: false, reason: 'grace' })
  })

  it('cron: pay-invoice said signed:false → no grace period', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - 5_000), {}, { status: 502, signed: false })
    const calls = mockPath('checkout')
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect(calls.payInvoice).toBe(1)
    expect((await loadRec(env)).status).toBe('provider_submitted')
  })

  it.each(['processing', 'purchase_complete', 'fulfillment_initiated', 'requires_setup', 'unknown'])(
    'never re-fires while Stripe shows "%s" (a Permit may be with the relayer)',
    async (state) => {
      const env = makeEnv()
      await seed(env)
      const t0 = Date.now()
      await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS))
      const calls = mockPath(state)
      await sweepInFlightStripeRecords(env, new Date(t0))
      expect(calls.payInvoice).toBe(0)
      expect((await loadRec(env)).status).toBe('provider_submitted_ambiguous')
      const out = await retryAmbiguousStripeRecord(env, KEY, new Date(t0 + 60_000), { source: 'admin', evidence: 'x'.repeat(20), retriedBy: 'ops' })
      expect(out).toMatchObject({ retried: false, reason: 'live_state_unsafe', liveState: state })
      expect(calls.payInvoice).toBe(0)
    },
  )

  it('a checkout session that already carries a blockchain tx is not retried', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('pay-invoice')) throw new Error('must not be called')
      if (u.includes('resume_payin_session')) return Response.json({ sessionId: KEY, clientSecret: 'cs_test', publishableKey: 'pk_test' })
      if (u.includes('payin_session')) return Response.json(stripeSession('checkout', '0x' + 'ab'.repeat(32)))
      return new Response('unexpected', { status: 500 })
    })
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect((await loadRec(env)).status).toBe('provider_submitted_ambiguous')
  })

  it('cron: automatic attempts are capped; a second ambiguity after the cap waits for a human', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS), { ambiguousRetries: AMBIGUOUS_MAX_AUTO_RETRIES })
    const calls = mockPath('checkout')
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect(calls.payInvoice).toBe(0)
    expect(await retryAmbiguousStripeRecord(env, KEY, new Date(t0 + 60_000), { source: 'cron' })).toMatchObject({ retried: false, reason: 'retries_exhausted' })
    // Admin may still re-drive (live proof still required, and it was given).
    const out = await retryAmbiguousStripeRecord(env, KEY, new Date(t0 + 120_000), { source: 'admin', evidence: 'verified stripe session untouched', retriedBy: 'founder' })
    expect(out).toMatchObject({ retried: true, attempt: AMBIGUOUS_MAX_AUTO_RETRIES + 1 })
    expect(calls.payInvoice).toBe(1)
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_submitted')
    expect(rec.events.find((e: any) => e.kind === 'stripe_ambiguous_retry').detail).toMatchObject({ source: 'admin', retriedBy: 'founder' })
  })

  it('a retry that is ambiguous again is parked again (counted), never loops inside one sweep', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS))
    const calls = mockPath('checkout', () => new Response('upstream down', { status: 503 }))
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect(calls.payInvoice).toBe(1)
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_submitted_ambiguous')
    expect(rec.ambiguousRetries).toBe(1)
    // Next sweep right away: the new ambiguous answer restarts the grace period.
    await sweepInFlightStripeRecords(env, new Date(t0 + RECONCILE_MIN_INTERVAL_MS + 1000))
    expect(calls.payInvoice).toBe(1)
  })

  it('the daily-cap reservation of the ambiguous attempt is handed back before the retry reserves again', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    // Simulate what the ambiguous attempt left behind: one invoice reserved today.
    const { reserveDailySpend } = await import('../src/routes/stripe-fulfillment')
    await reserveDailySpend(env, new Date(t0), 1360000n)
    await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS))
    mockPath('checkout')
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect((await loadRec(env)).status).toBe('provider_submitted')
    // Exactly one invoice counted, not two.
    expect(await readDailySpentAtomic(env, new Date(t0))).toBe(1360000n)
  })

  it('codex P1: a failed live lookup never lets an older checkout read authorize a retry', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    // An earlier successful check saw `checkout`…
    await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS), {
      events: [
        { kind: 'stripe_confirm_ambiguous', at: new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS).toISOString(), detail: { status: 502 } },
        { kind: 'stripe_reconcile_checked', at: new Date(t0 - 2 * RECONCILE_MIN_INTERVAL_MS).toISOString(), detail: { state: 'checkout', blockchainTxId: null } },
      ],
      lastProviderCheckAt: new Date(t0 - 2 * RECONCILE_MIN_INTERVAL_MS).toISOString(),
    })
    // … but now Stripe is unreachable.
    let payInvoice = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (u.includes('pay-invoice')) {
        payInvoice++
        return Response.json({ success: true })
      }
      if (u.includes('resume_payin_session')) return new Response('boom', { status: 500 })
      return new Response('unexpected', { status: 500 })
    })
    await sweepInFlightStripeRecords(env, new Date(t0))
    expect(payInvoice).toBe(0)
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_submitted_ambiguous')
    expect(await retryAmbiguousStripeRecord(env, KEY, new Date(t0 + 1000), { source: 'cron' })).toMatchObject({ retried: false, reason: 'provider_check_failed' })
  })

  it('codex P1: a caller holding proof from an older attempt is refused at the CAS', async () => {
    const env = makeEnv()
    await seed(env)
    const t0 = Date.now()
    await parkAmbiguous(env, new Date(t0 - 10 * AMBIGUOUS_RETRY_GRACE_MS))
    // Between this caller's inspection and its CAS, another retry already
    // re-fired and went ambiguous again (generation 1, newer ambiguous event).
    let armed = false
    const ns: any = env.ATOMIC_STORE
    const stub = ns.get(null)
    const realFetch = stub.fetch.bind(stub)
    stub.fetch = async (req: Request) => {
      const body = await req.clone().json()
      if (!armed && body.key === stripeKvKey(KEY) && new URL(req.url).pathname === '/commit') {
        armed = true
        await forceStatus(env, 'provider_submitted_ambiguous', {
          ambiguousRetries: 1,
          events: [{ kind: 'stripe_confirm_ambiguous', at: new Date(t0 - 1000).toISOString(), detail: { status: 503 } }],
        })
      }
      return realFetch(req)
    }
    const calls = mockPath('checkout')
    const out = await retryAmbiguousStripeRecord(env, KEY, new Date(t0), { source: 'admin', evidence: 'operator verified session untouched', retriedBy: 'ops' })
    expect(out).toMatchObject({ retried: false, reason: 'lost_race' })
    expect(calls.payInvoice).toBe(0)
    const rec = await loadRec(env)
    expect(rec.status).toBe('provider_submitted_ambiguous')
    expect(rec.ambiguousRetries).toBe(1)
  })

  it('other statuses are untouched by the retry', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'provider_submitted')
    mockPath('checkout')
    expect(await retryAmbiguousStripeRecord(env, KEY, new Date(), { source: 'admin', evidence: 'x'.repeat(20), retriedBy: 'ops' })).toEqual({ retried: false, reason: 'not_ambiguous' })
    expect(await retryAmbiguousStripeRecord(env, 'cpis_nope', new Date(), { source: 'cron' })).toEqual({ retried: false, reason: 'no_record' })
  })

  describe('POST /admin/stripe-fulfillment/retry', () => {
    const post = (env: Env, body: unknown, secret = 'admin') =>
      handleStripeFulfillmentRetry(
        new Request('https://r/admin/stripe-fulfillment/retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
          body: JSON.stringify(body),
        }),
        env,
      )

    it('gates on the admin secret and refuses capability-bearing evidence', async () => {
      const env = makeEnv()
      await seed(env)
      expect((await post(env, { invoiceKey: KEY }, 'nope')).status).toBe(401)
      const bad = await post(env, { invoiceKey: KEY, evidence: 'see https://crypto.stripe.com/pay/CDMQ_blob_blob', retriedBy: 'ops' })
      expect(bad.status).toBe(400)
      expect((await post(env, { invoiceKey: KEY, evidence: 'short', retriedBy: 'ops' })).status).toBe(400)
    })

    it('re-drives an ambiguous record and reports what was sent', async () => {
      const env = makeEnv()
      await seed(env)
      await parkAmbiguous(env, new Date(Date.now() - 5_000))
      const calls = mockPath('checkout')
      const res = await post(env, { invoiceKey: ORDER, evidence: 'funder wallet shows no outgoing USDC since 18:41Z', retriedBy: 'founder' })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body).toMatchObject({ ok: true, attempt: 1, liveState: 'checkout' })
      expect(JSON.stringify(body)).not.toContain(KEY) // masked
      expect(calls.payInvoice).toBe(1)
      // Idempotent against the state machine: the record is no longer ambiguous.
      expect((await post(env, { invoiceKey: KEY, evidence: 'second try for no reason at all', retriedBy: 'founder' })).status).toBe(409)
    })

    it('refuses when Stripe shows the session past checkout', async () => {
      const env = makeEnv()
      await seed(env)
      await parkAmbiguous(env, new Date(Date.now() - 5_000))
      const calls = mockPath('processing')
      const res = await post(env, { invoiceKey: KEY, evidence: 'operator believes nothing was signed', retriedBy: 'ops' })
      expect(res.status).toBe(409)
      expect(calls.payInvoice).toBe(0)
    })
  })
})
