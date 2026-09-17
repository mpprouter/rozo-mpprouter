// A paid Stripe link reopened after Stripe stopped resuming the session must
// still name the invoice + router state (read-only) instead of a bare 410.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleInvoiceDetails } from '../src/routes/invoice-details'
import { seedStripeRecord, stripeKvKey } from '../src/routes/stripe-fulfillment'
import { indexStripeSession, lookupStripeSession } from '../src/routes/stripe-session-index'
import { casRead } from '../src/routes/stripe-atomic'

const URL_ = 'https://crypto.stripe.com/pay/CDMQARoXBLOBTUOQ'
const KEY = 'cpis_1UGa8xDSZgxV3MJKdwgCzGep'
const ROZO = '38b281ad-4a74-413d-84dd-100a4914bc7e'

function makeDoNamespace() {
  const store = new Map<string, string>(); const versions = new Map<string, number>()
  const stub = { async fetch(req: Request) {
    const url = new URL(req.url); const body: any = await req.json()
    if (url.pathname === '/read') return Response.json({ value: store.get(body.key) ?? null, version: versions.get(body.key) ?? 0 })
    if (url.pathname === '/commit') { const cur = versions.get(body.key) ?? 0; if (cur !== body.expectedVersion) return Response.json({ ok: false }); store.set(body.key, body.value); versions.set(body.key, cur + 1); return Response.json({ ok: true }) }
    if (url.pathname === '/scan') return Response.json({ values: [...store.entries()].filter(([k]) => k.startsWith(body.prefix)).map(([, v]) => v) })
    return new Response('nf', { status: 404 }) } }
  return { idFromName: () => ({}), get: () => stub }
}
class FakeKV { store = new Map<string, string>(); async get(k: string) { return this.store.get(k) ?? null } async put(k: string, v: string) { this.store.set(k, v) } }
function makeEnv() {
  return { MPP_STORE: new FakeKV(), ATOMIC_STORE: makeDoNamespace(), INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'), PAYINVOICE_ADMIN_SECRET: 's' } as any
}
function req(url: string) {
  return new Request('https://router.test/v1/services/rozo-agent-api/invoice-details', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ url }) })
}
function session(state: string) {
  return { id: KEY, merchant: 'acct_x', business_name: 'Command Code', state, payment_details: { amount: 136, currency: 'usd' },
    supported_currencies: [{ id: 'usdc.base', currency_network: 'base', chain_id: 8453, asset_code: 'usdc', contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payment_options: ['wallet_connect'] }], transaction_details: {}, valid_before: '1789980699' }
}
function mockStripe(resume: 'ok' | 410, state = 'checkout') {
  const hits: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    hits.push(u)
    if (u.includes('resume_payin_session')) return resume === 'ok' ? Response.json({ sessionId: KEY, clientSecret: 'cs', publishableKey: 'pk' }) : new Response('gone', { status: 410 })
    if (u.includes('payin_session')) return Response.json(session(state))
    return new Response('unexpected ' + u, { status: 500 })
  })
  return hits
}
async function setPaid(env: any) {
  await seedStripeRecord(env, { invoiceKey: KEY, merchantAccount: 'acct_x', invoiceAmountAtomic: '1360000', invoiceCurrency: 'usd', lockFingerprint: 'x', stripeUrl: URL_, rozoPaymentId: ROZO })
  const { value, version } = await casRead(env, stripeKvKey(KEY)); const r = JSON.parse(value!); r.status = 'paid'; r.paidAt = '2026-09-17T09:19:31.692Z'
  await env.ATOMIC_STORE.get().fetch(new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey(KEY), expectedVersion: version, op: 'set', value: JSON.stringify(r) }) }))
}
afterEach(() => vi.restoreAllMocks())

describe('stripe session index', () => {
  it('stores only a hash of the blob, round-trips the cpis id', async () => {
    const env = makeEnv()
    await indexStripeSession(env, URL_, KEY)
    expect(await lookupStripeSession(env, URL_)).toBe(KEY)
    expect(JSON.stringify([...env.MPP_STORE.store.entries()])).not.toContain('CDMQARoXBLOBTUOQ')
    expect(await lookupStripeSession(env, 'https://crypto.stripe.com/pay/OTHER')).toBeNull()
    await indexStripeSession(env, URL_, 'pl_notstripe') // ignored
    expect(await lookupStripeSession(env, URL_)).toBe(KEY)
  })
})

describe('invoice-details on a paid / expired Stripe link', () => {
  it('a successful resolve indexes the link', async () => {
    const env = makeEnv(); mockStripe('ok')
    const res = await handleInvoiceDetails(req(URL_), env)
    expect(res.status).toBe(200)
    expect(await lookupStripeSession(env, URL_)).toBe(KEY)
  })

  it('410 after Stripe stops resuming: still names invoiceKey, rozo_payment_id, routerState (no Stripe retry)', async () => {
    const env = makeEnv(); await setPaid(env); await indexStripeSession(env, URL_, KEY)
    const hits = mockStripe(410)
    const res = await handleInvoiceDetails(req(URL_), env)
    const body: any = await res.json()
    expect(res.status).toBe(410)
    expect(body).toMatchObject({ ok: false, reason: 'expired', invoiceKey: KEY, rozo_payment_id: ROZO })
    expect(body.routerState.status).toBe('paid')
    expect(body.routerState.paidAt).toBe('2026-09-17T09:19:31.692Z')
    expect(JSON.stringify(body)).not.toContain('CDMQARoXBLOBTUOQ')
    expect(hits.filter((u) => u.includes('resume_payin_session')).length).toBe(1)
  })

  it('410 on a pre-index record: backfills from the fulfillment record (no Stripe call, blob never stored)', async () => {
    const env = makeEnv(); await setPaid(env) // seeded with URL_, but NOT indexed
    const hits = mockStripe(410)
    const body: any = await (await handleInvoiceDetails(req(URL_), env)).json()
    expect(body).toMatchObject({ reason: 'expired', invoiceKey: KEY, rozo_payment_id: ROZO })
    expect(body.routerState.status).toBe('paid')
    expect(hits.filter((u) => u.includes('stripe.com')).length).toBe(1) // only the failed resume
    expect(JSON.stringify([...env.MPP_STORE.store.entries()])).not.toContain('CDMQARoXBLOBTUOQ')
    // Indexed now: a second lookup needs no scan.
    expect(await lookupStripeSession(env, URL_)).toBe(KEY)
    // A different blob does not match this record.
    const other: any = await (await handleInvoiceDetails(req('https://crypto.stripe.com/pay/SOMEOTHERBLOB'), env)).json()
    expect(other.invoiceKey).toBeUndefined()
  })

  it('410 on a link we never saw stays a bare expired', async () => {
    const env = makeEnv(); mockStripe(410)
    const body: any = await (await handleInvoiceDetails(req(URL_), env)).json()
    expect(body).toEqual({ ok: false, provider: 'stripe_crypto', error: 'resume_payin_session failed (410)', reason: 'expired' })
  })

  it('not-payable (fulfillment_complete) session carries router state too', async () => {
    const env = makeEnv(); await setPaid(env); mockStripe('ok', 'fulfillment_complete')
    const body: any = await (await handleInvoiceDetails(req(URL_), env)).json()
    expect(body.ok).toBe(true)
    expect(body.invoice.payable).toBe(false)
    expect(body).toMatchObject({ invoiceKey: KEY, rozo_payment_id: ROZO })
    expect(body.routerState.status).toBe('paid')
    expect(body.callerPays).toBe('1.38')
  })
})
