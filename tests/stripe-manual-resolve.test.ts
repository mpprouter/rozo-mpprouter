import { describe, it, expect } from 'vitest'
import { seedStripeRecord, stripeKvKey, resolveManualReview } from '../src/routes/stripe-fulfillment'
import { handleStripeFulfillmentResolve } from '../src/routes/stripe-fulfillment-admin'
import { casRead } from '../src/routes/stripe-atomic'
import type { Env } from '../src/index'

function makeDoNamespace() {
  const store = new Map<string, string>()
  const versions = new Map<string, number>()
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const body: any = await req.json()
      if (url.pathname === '/read') return Response.json({ value: store.get(body.key) ?? null, version: versions.get(body.key) ?? 0 })
      if (url.pathname === '/commit') {
        const cur = versions.get(body.key) ?? 0
        if (cur !== body.expectedVersion) return Response.json({ ok: false, value: store.get(body.key) ?? null, version: cur })
        store.set(body.key, body.value)
        versions.set(body.key, cur + 1)
        return Response.json({ ok: true })
      }
      return new Response('Not Found', { status: 404 })
    },
  }
  return { idFromName: (n: string) => ({ name: n }), get: (_id: any) => stub }
}
const TEST_CAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
function makeEnv(extra: Partial<Env> = {}): Env {
  return { ATOMIC_STORE: makeDoNamespace() as any, PAYINVOICE_ADMIN_SECRET: 'admin-secret', INVOICE_CAPABILITY_ENCRYPTION_KEY: TEST_CAP_KEY, ...extra } as unknown as Env
}
const KEY = 'cpis_1UGa8xDSZgxV3MJKdwgCzGep'
const TX = '0x69001289a3b3178d6d24aa123b2ae11765e84fca7a7eb62d8e100d201f83c247'
const EVIDENCE = 'Stripe live session read 08:10Z showed fulfillment_complete; owner confirmed Stripe page PAID'
async function seed(env: Env, status: string) {
  await seedStripeRecord(env, { invoiceKey: KEY, merchantAccount: 'acct', invoiceAmountAtomic: '1360000', invoiceCurrency: 'usd', lockFingerprint: 'x', stripeUrl: 'https://crypto.stripe.com/pay/BLOB', rozoPaymentId: 'rp' })
  const { value, version } = await casRead(env, stripeKvKey(KEY))
  const rec = JSON.parse(value!); rec.status = status
  await (env.ATOMIC_STORE as any).get(null).fetch(new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey(KEY), expectedVersion: version, op: 'set', value: JSON.stringify(rec) }) }))
}
async function load(env: Env) { return JSON.parse((await casRead(env, stripeKvKey(KEY))).value!) }
function post(body: unknown, secret: string | null = 'admin-secret') {
  return new Request('https://x/admin/stripe-fulfillment/resolve', { method: 'POST', headers: secret ? { 'x-admin-secret': secret } : {}, body: JSON.stringify(body) })
}
const good = { invoiceKey: KEY, resolution: 'paid', evidence: EVIDENCE, txHash: TX, resolvedBy: 'shawn' }

describe('resolveManualReview', () => {
  it('manual_review → paid records who/when/evidence/tx', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const now = new Date('2026-09-17T09:00:00Z')
    const out = await resolveManualReview(env, KEY, { resolution: 'paid', evidence: EVIDENCE, txHash: TX, resolvedBy: 'shawn', now })
    expect(out).toEqual({ kind: 'resolved', status: 'paid', paidAt: now.toISOString() })
    const rec = await load(env)
    expect(rec.status).toBe('paid'); expect(rec.paidAt).toBe(now.toISOString()); expect(rec.failureReason).toBeNull()
    expect(rec.manualResolution).toEqual({ resolution: 'paid', evidence: EVIDENCE, txHash: TX, resolvedBy: 'shawn', at: now.toISOString() })
    expect(rec.providerResult.blockchainTxId).toBe(TX)
    expect(rec.events.at(-1).kind).toBe('manual_review_resolved_paid')
  })
  it('is idempotent on repeat', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const a = { resolution: 'paid' as const, evidence: EVIDENCE, txHash: TX, resolvedBy: 'shawn', now: new Date() }
    await resolveManualReview(env, KEY, a)
    expect((await resolveManualReview(env, KEY, a)).kind).toBe('already_resolved')
  })
  it.each(['paid', 'provider_paying', 'provider_submitted', 'provider_submitted_ambiguous', 'failed_provider', 'payout_seen', 'rozo_payment_created'])(
    'refuses to resolve from %s (monotonic, reconciler-only for in-flight)', async (status) => {
      const env = makeEnv(); await seed(env, status)
      const out = await resolveManualReview(env, KEY, { resolution: 'paid', evidence: EVIDENCE, txHash: TX, resolvedBy: 'shawn', now: new Date() })
      expect(out).toEqual({ kind: 'not_manual_review', status })
      expect((await load(env)).status).toBe(status)
    })
  it('manual_review → failed_provider', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const out = await resolveManualReview(env, KEY, { resolution: 'failed_provider', evidence: EVIDENCE, txHash: null, resolvedBy: 'shawn', now: new Date() })
    expect(out.kind).toBe('resolved')
    const rec = await load(env); expect(rec.status).toBe('failed_provider'); expect(rec.paidAt).toBeNull()
  })
  it('no_record for unknown key', async () => {
    expect((await resolveManualReview(makeEnv(), 'cpis_none', { resolution: 'paid', evidence: EVIDENCE, txHash: TX, resolvedBy: 's', now: new Date() })).kind).toBe('no_record')
  })
})

describe('POST /admin/stripe-fulfillment/resolve', () => {
  it('401 without/with wrong secret; 500 when unconfigured', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    expect((await handleStripeFulfillmentResolve(post(good, null), env)).status).toBe(401)
    expect((await handleStripeFulfillmentResolve(post(good, 'nope'), env)).status).toBe(401)
    expect((await handleStripeFulfillmentResolve(post(good), makeEnv({ PAYINVOICE_ADMIN_SECRET: undefined as any }))).status).toBe(500)
    expect((await load(env)).status).toBe('manual_review')
  })
  it('resolves and never echoes the capability', async () => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const res = await handleStripeFulfillmentResolve(post({ ...good, invoiceKey: `stripe_crypto_${KEY}` }), env)
    const body: any = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, status: 'paid', changed: true })
    expect(body.paidAt).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain('BLOB')
    expect(body.invoiceKey).toBe('cpis_1UGa…zGep')
  })
  it('409 when not manual_review', async () => {
    const env = makeEnv(); await seed(env, 'provider_paying')
    const res = await handleStripeFulfillmentResolve(post(good), env)
    expect(res.status).toBe(409)
  })
  it('404 unknown record', async () => {
    expect((await handleStripeFulfillmentResolve(post({ ...good, invoiceKey: 'cpis_none' }), makeEnv())).status).toBe(404)
  })
  it.each([
    [{ ...good, txHash: '0x1234' }, 'bad tx hash'],
    [{ ...good, txHash: undefined }, 'missing tx for paid'],
    [{ ...good, evidence: 'short' }, 'evidence too short'],
    [{ ...good, evidence: 'see https://crypto.stripe.com/pay/CDMQARoX for the receipt' }, 'evidence with pay URL'],
    [{ ...good, evidence: 'see https://crypto.stripe.com:443/pay/CDMQARoX for the receipt' }, 'pay URL with port'],
    [{ ...good, evidence: 'see https://crypto.stripe.com./pay/CDMQARoX for the receipt' }, 'pay URL with trailing dot'],
    [{ ...good, evidence: 'see HTTPS://CRYPTO.STRIPE.COM/PAY/CDMQARoX for the receipt' }, 'pay URL uppercase'],
    [{ ...good, evidence: 'see crypto.stripe.com/pay/CDMQARoX for the receipt' }, 'schemeless pay URL'],
    [{ ...good, evidence: 'see https://crypto.stripe.com/setup/CDMQARoX for the receipt' }, 'setup URL'],
    [{ ...good, evidence: 'client_secret cs_test_abcdefghijklmnop was used' }, 'client secret'],
    [{ ...good, resolvedBy: '' }, 'missing resolvedBy'],
    [{ ...good, resolution: 'refunded' }, 'unknown resolution'],
    [{ ...good, invoiceKey: 'pl_coinbase' }, 'non-Stripe key'],
  ])('400 on %#: %s', async (body) => {
    const env = makeEnv(); await seed(env, 'manual_review')
    const res = await handleStripeFulfillmentResolve(post(body), env)
    expect(res.status).toBe(400)
    expect((await load(env)).status).toBe('manual_review')
  })
  it('405 on GET', async () => {
    expect((await handleStripeFulfillmentResolve(new Request('https://x/', { method: 'GET' }), makeEnv())).status).toBe(405)
  })
})
