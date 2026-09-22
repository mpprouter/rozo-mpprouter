/**
 * quote-invoice for Stripe Crypto Payin links.
 *
 * The web checkout always quotes first (quote-invoice) for BOTH providers, so
 * the router must answer a crypto.stripe.com/pay/<blob> link itself instead of
 * proxying it to agentapi (which only knows Coinbase ids and replied
 * "Invalid Coinbase Payment Link"). Also pins the http:// -> https:// rewrite
 * on the same path. Read-only: no order, no money movement.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleQuoteInvoice } from '../src/routes/pay-invoice-admin'
import { verifyQuoteReceipt } from '../src/routes/quote-receipt'

const KEY = 'cpis_1UIMzfDSZgxV3MJKGYmbSlu0'
const URL_ = 'https://crypto.stripe.com/pay/CDMQARoXBLOBTUOQ'
const env = { PAYINVOICE_ADMIN_SECRET: 'test-secret' } as import('../src/index').Env

function session(state: string) {
  return {
    id: KEY, merchant: 'acct_x', business_name: 'Command Code', state,
    payment_details: { amount: 136, currency: 'usd' },
    supported_currencies: [{ id: 'usdc.base', currency_network: 'base', chain_id: 8453, asset_code: 'usdc', contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payment_options: ['wallet_connect'] }],
    transaction_details: {}, valid_before: '1789980699',
  }
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
function post(body: unknown) {
  return new Request('https://mpp.test/quote-invoice', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
afterEach(() => vi.restoreAllMocks())

describe('quote-invoice: Stripe branch', () => {
  it('quotes a live Stripe link without touching agentapi and issues a receipt keyed by cpis_*', async () => {
    const hits = mockStripe('ok')
    const res = await handleQuoteInvoice(post({ url: URL_, client: 'rozo-checkout-web' }), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(hits.some((h) => h.includes('agentapi.rozo.ai'))).toBe(false)
    expect(body).toMatchObject({
      ok: true, provider: 'stripe_crypto', linkId: KEY, merchant: 'Command Code',
      invoice: { amount: '1.36' }, original: '1.36', callerPays: '1.36', invoiceUrl: URL_, currency: 'USD',
    })
    expect(body.quote.originalAtomicUsdc).toBe('1360000')
    await expect(verifyQuoteReceipt(body.quoteReceipt, KEY, 'test-secret')).resolves.toMatchObject({
      amount: '1.36', merchant: 'Command Code',
    })
  })

  it('rewrites http:// to https:// before resolving (email/chat clients strip the scheme)', async () => {
    const hits = mockStripe('ok')
    const res = await handleQuoteInvoice(post({ url: URL_.replace('https://', 'http://') }), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(body.invoiceUrl).toBe(URL_)
    expect(hits.every((h) => h.startsWith('https://'))).toBe(true)
  })

  it('maps a dead session to LINK_USED_OR_EXPIRED (410) and never echoes the pay URL', async () => {
    mockStripe(410)
    const res = await handleQuoteInvoice(post({ url: URL_ }), env)
    const body = (await res.json()) as any
    expect(res.status).toBe(410)
    expect(body.code).toBe('LINK_USED_OR_EXPIRED')
    expect(JSON.stringify(body)).not.toContain('/pay/')
  })

  it('refuses a non-payable (already paid) session as LINK_USED_OR_EXPIRED', async () => {
    mockStripe('ok', 'paid')
    const res = await handleQuoteInvoice(post({ url: URL_ }), env)
    expect(res.status).toBe(410)
    expect(((await res.json()) as any).code).toBe('LINK_USED_OR_EXPIRED')
  })
})
