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
    mockStripe('succeeded')
    const out = await reconcileStripeRecordWithProvider(env, KEY, new Date())
    expect(out).toMatchObject({ transition: 'paid' })
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
    // swallow it; force a throw from the shared-pool reservation instead.
    ;(env.MPP_STORE as any).get = async () => { throw new Error('kv down') }
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
    // … and the very next step (releasing the shared-pool reservation via KV)
    // throws. Before the safety net this left the record at provider_paying.
    const realPut = (env.MPP_STORE as any).put
    ;(env.MPP_STORE as any).put = async (k: string, v: string) => {
      if (payInvoiceCalls > 0 && k === 'funder-reserved-atomic') throw new Error('kv down after sign')
      return realPut(k, v)
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
    // Restore KV so the replay below can run its accounting.
    ;(env.MPP_STORE as any).put = realPut
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
