// Stripe Crypto records never reported delivery to Rozo, so rozo-intents-api
// paged "merchant has not confirmed delivery" for every paid Stripe order
// (2026-10-21: 826b0206, 0ff129a3). These pin the report-only path.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  seedStripeRecord,
  stripeKvKey,
  reportStripeDelivered,
  sweepInFlightStripeRecords,
} from '../src/routes/stripe-fulfillment'
import { DELIVERED_MAX_ATTEMPTS } from '../src/routes/coinbase-sweep'
import { casRead } from '../src/routes/stripe-atomic'
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

const KEY = 'cpis_testdelivereda'
const ROZO_ID = '826b0206-0000-4000-8000-000000000001'
const STRIPE_URL = 'https://crypto.stripe.com/pay/CDMQARoXBLOB'

function makeEnvOn(extra: Partial<Env> = {}): Env {
  return makeEnv({ ROZO_DELIVERED_REPORT_ENABLED: 'true', ...extra } as Partial<Env>)
}

async function seed(env: Env, key = KEY, rozoId: string | null = ROZO_ID) {
  await seedStripeRecord(env, {
    invoiceKey: key,
    merchantAccount: 'acct_1T333NDSZgxV3MJK',
    invoiceAmountAtomic: '1360000',
    invoiceCurrency: 'usd',
    lockFingerprint: 'sha256:zz',
    stripeUrl: key === KEY ? STRIPE_URL : `${STRIPE_URL}B`,
    rozoPaymentId: rozoId,
  })
}

async function loadRec(env: Env, key = KEY): Promise<any> {
  const { value } = await casRead(env, stripeKvKey(key))
  return value ? JSON.parse(value) : null
}

async function forceStatus(env: Env, status: string, patch: Record<string, unknown> = {}, key = KEY) {
  const rec = await loadRec(env, key)
  Object.assign(rec, { status }, patch)
  const { version } = await casRead(env, stripeKvKey(key))
  await (env.ATOMIC_STORE as any).get(null).fetch(
    new Request('https://x/commit', {
      method: 'POST',
      body: JSON.stringify({ key: stripeKvKey(key), expectedVersion: version, op: 'set', value: JSON.stringify(rec) }),
    }),
  )
}

const NOW = new Date('2026-10-21T14:20:00Z')
const PAID_AT = '2026-10-21T14:13:51.000Z'

// /delivered answers `deliveredStatus`; Stripe answers fulfillment_complete;
// anything else (pay-invoice included) is recorded and fails.
function mockFetch(deliveredStatus: number) {
  const hits: Array<{ url: string; body: any }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let body: any = null
    try {
      body = init?.body ? JSON.parse(init.body) : null
    } catch {
      body = init?.body ?? null
    }
    hits.push({ url: u, body })
    if (u.endsWith('/delivered')) return new Response('{}', { status: deliveredStatus })
    if (u.includes('resume_payin_session')) {
      return Response.json({ sessionId: KEY, clientSecret: 'cs_test', publishableKey: 'pk_test' })
    }
    if (u.includes('payin_session')) {
      return Response.json({
        id: KEY,
        merchant: 'acct_1T333NDSZgxV3MJK',
        business_name: 'Command Code',
        state: 'fulfillment_complete',
        payment_details: { amount: 136, currency: 'usd' },
        supported_currencies: [
          { id: 'usdc.base', currency_network: 'base', chain_id: 8453, asset_code: 'usdc',
            contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payment_options: ['direct_deposit', 'wallet_connect'] },
        ],
        transaction_details: {},
        valid_before: '1900000000',
      })
    }
    return new Response('unexpected ' + u, { status: 500 })
  })
  return hits
}

const delivered = (hits: Array<{ url: string }>) => hits.filter((h) => h.url.endsWith('/delivered'))
const payInvoice = (hits: Array<{ url: string }>) => hits.filter((h) => h.url.includes('pay-invoice'))

afterEach(() => vi.restoreAllMocks())

describe('reportStripeDelivered', () => {
  it('paid → reports once with the orderId reference and sets the flag', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT })
    const hits = mockFetch(200)
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('reported')
    expect(delivered(hits)).toHaveLength(1)
    expect(delivered(hits)[0].url).toContain(`/payments/${ROZO_ID}/delivered`)
    expect(delivered(hits)[0].body).toEqual({ reference: `stripe_crypto_${KEY}` })
    const rec = await loadRec(env)
    expect(rec.deliveredReported).toBe(true)
    expect(rec.status).toBe('paid')
    expect(rec.events.some((e: any) => e.kind === 'delivered_reported')).toBe(true)
    // Second call is a no-op.
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('skipped')
    expect(delivered(hits)).toHaveLength(1)
  })

  it('409 within the pending window is not counted as an attempt', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT })
    mockFetch(409)
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('pending')
    const rec = await loadRec(env)
    expect(rec.deliveredReported ?? false).toBe(false)
    expect(rec.deliveredReportAttempts ?? 0).toBe(0)
    expect(rec.deliveredPendingAt).toBe(NOW.toISOString())
  })

  it('non-200 counts an attempt; give-up stops further calls', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT })
    const hits = mockFetch(500)
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('failed')
    let rec = await loadRec(env)
    expect(rec.deliveredReportAttempts).toBe(1)
    expect(rec.deliveredReported ?? false).toBe(false)
    for (let i = 1; i < DELIVERED_MAX_ATTEMPTS; i++) await reportStripeDelivered(env, KEY, NOW)
    rec = await loadRec(env)
    expect(rec.deliveredReportAttempts).toBe(DELIVERED_MAX_ATTEMPTS)
    expect(rec.alertedDeliveredGiveUp).toBe(true)
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('skipped')
    expect(delivered(hits)).toHaveLength(DELIVERED_MAX_ATTEMPTS)
  })

  it('already reported → no call', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT, deliveredReported: true })
    const hits = mockFetch(200)
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('skipped')
    expect(hits).toHaveLength(0)
  })

  it('reporting disabled → no call', async () => {
    const env = makeEnv()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT })
    const hits = mockFetch(200)
    expect(await reportStripeDelivered(env, KEY, NOW)).toBe('skipped')
    expect(hits).toHaveLength(0)
  })

  it('not paid (in flight / failed) → no call', async () => {
    const env = makeEnvOn()
    await seed(env)
    const hits = mockFetch(200)
    for (const s of ['provider_submitted', 'provider_submitted_ambiguous', 'failed_provider', 'manual_review']) {
      await forceStatus(env, s)
      expect(await reportStripeDelivered(env, KEY, NOW)).toBe('skipped')
    }
    expect(hits).toHaveLength(0)
  })
})

describe('sweepInFlightStripeRecords delivered backfill', () => {
  it('backfills a paid unreported record and never calls pay-invoice', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT })
    const OTHER = 'cpis_testdeliveredb'
    await seed(env, OTHER, '0ff129a3-0000-4000-8000-000000000002')
    await forceStatus(env, 'paid', { paidAt: '2026-10-21T11:11:52.000Z' }, OTHER)
    const hits = mockFetch(200)
    await sweepInFlightStripeRecords(env, NOW)
    expect(delivered(hits)).toHaveLength(2)
    expect(payInvoice(hits)).toHaveLength(0)
    expect((await loadRec(env)).deliveredReported).toBe(true)
    expect((await loadRec(env, OTHER)).deliveredReported).toBe(true)
    expect((await loadRec(env)).status).toBe('paid')
    // Next tick: nothing left to report.
    await sweepInFlightStripeRecords(env, NOW)
    expect(delivered(hits)).toHaveLength(2)
  })

  it('reports in the same tick a record the reconcile loop just moved to paid', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'provider_submitted')
    const hits = mockFetch(200)
    const out = await sweepInFlightStripeRecords(env, NOW)
    expect(out.transitions).toHaveLength(1)
    const rec = await loadRec(env)
    expect(rec.status).toBe('paid')
    expect(rec.deliveredReported).toBe(true)
    expect(delivered(hits)).toHaveLength(1)
    expect(payInvoice(hits)).toHaveLength(0)
  })

  it('pending records wait before being re-asked', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT, deliveredPendingAt: '2026-10-21T14:18:00.000Z' })
    const hits = mockFetch(200)
    await sweepInFlightStripeRecords(env, NOW)
    expect(delivered(hits)).toHaveLength(0)
    await sweepInFlightStripeRecords(env, new Date('2026-10-21T14:25:00Z'))
    expect(delivered(hits)).toHaveLength(1)
  })

  it('a throwing Rozo call does not break the sweep', async () => {
    const env = makeEnvOn()
    await seed(env)
    await forceStatus(env, 'paid', { paidAt: PAID_AT })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('boom') })
    await expect(sweepInFlightStripeRecords(env, NOW)).resolves.toBeDefined()
    expect((await loadRec(env)).deliveredReportAttempts).toBe(1)
  })
})
