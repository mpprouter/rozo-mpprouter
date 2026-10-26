// Original payment links kept in the router's D1 (founder 2026-10-26).
import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import {
  saveOriginalPaymentLink,
  readOriginalPaymentLink,
  isStorablePaymentLink,
  coinbaseLinkFromId,
} from '../src/routes/payment-link-store'

function makeD1() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(new URL('../migrations/0005_checkout_payment_links.sql', import.meta.url), 'utf8'))
  const db: any = {
    prepare(q: string) {
      let args: any[] = []
      return {
        bind(...a: any[]) { args = a; return this },
        async run() { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } } },
        async first() { return (sql.prepare(q).get(...args) as any) ?? null },
        async all() { return { results: sql.prepare(q).all(...args) } },
      }
    },
  }
  return { db, sql }
}

const STRIPE = 'https://crypto.stripe.com/pay/CDMQARoXChVhY2N0XzFNeHV1MkRoaFBqOGk0UEEohL3-1gYyBj0ekJd2tTou4dj-WMEzVV5Q_B_4ctCdTstKkFfgQelSyJHbp3hl5OfP0KWwKe_JmPFCH8glVA'
const RPID = 'a655b492-20ea-42ed-8d16-77b7b7c6e7c0'

describe('payment-link-store', () => {
  it('stores and reads back a Stripe link keyed by the Rozo payment id', async () => {
    const { db, sql } = makeD1()
    const env: any = { COUPON_SECURITY_DB: db }
    expect(await saveOriginalPaymentLink(env, { rozoPaymentId: RPID, provider: 'stripe_crypto', orderRef: 'cpis_1UUsoSDhhPj8i4PAAucrTzbq', url: STRIPE }, 1000)).toBe(true)
    expect(await readOriginalPaymentLink(env, RPID)).toEqual({ rozoPaymentId: RPID, provider: 'stripe_crypto', orderRef: 'cpis_1UUsoSDhhPj8i4PAAucrTzbq', url: STRIPE })
    // Findable by the merchant-side reference too (what support usually has).
    expect((sql.prepare('SELECT url FROM checkout_payment_links WHERE order_ref = ?').get('cpis_1UUsoSDhhPj8i4PAAucrTzbq') as any).url).toBe(STRIPE)
  })

  it('upserts: a re-create for the same order keeps the newest url', async () => {
    const { db } = makeD1()
    const env: any = { COUPON_SECURITY_DB: db }
    await saveOriginalPaymentLink(env, { rozoPaymentId: RPID, provider: 'coinbase', orderRef: 'pl_a', url: 'https://payments.coinbase.com/payment-links/pl_a' }, 1)
    await saveOriginalPaymentLink(env, { rozoPaymentId: RPID, provider: 'coinbase', orderRef: 'pl_a', url: 'https://payments.coinbase.com/payment-links/pl_a?x=1' }, 2)
    expect((await readOriginalPaymentLink(env, RPID))?.url).toBe('https://payments.coinbase.com/payment-links/pl_a?x=1')
  })

  it('never throws: missing binding, bad url, or a D1 failure all return false', async () => {
    expect(await saveOriginalPaymentLink({} as any, { rozoPaymentId: RPID, provider: 'coinbase', orderRef: 'pl_a', url: 'https://payments.coinbase.com/payment-links/pl_a' })).toBe(false)
    const { db } = makeD1()
    const env: any = { COUPON_SECURITY_DB: db }
    expect(await saveOriginalPaymentLink(env, { rozoPaymentId: RPID, provider: 'stripe_crypto', orderRef: 'cpis_x', url: 'https://crypto.stripe.com.evil.com/pay/x' })).toBe(false)
    expect(await saveOriginalPaymentLink(env, { rozoPaymentId: RPID, provider: 'coinbase', orderRef: 'pl_a', url: 'http://payments.coinbase.com/payment-links/pl_a' })).toBe(false)
    const broken: any = { COUPON_SECURITY_DB: { prepare: () => ({ bind() { return this }, async run() { throw new Error('D1 down') } }) } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await saveOriginalPaymentLink(broken, { rozoPaymentId: RPID, provider: 'coinbase', orderRef: 'pl_a', url: 'https://payments.coinbase.com/payment-links/pl_a' })).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0][0]).not.toContain('payment-links/pl_a') // url never logged
    warn.mockRestore()
  })

  it('host allow-list and Coinbase id → link', () => {
    expect(isStorablePaymentLink('stripe_crypto', STRIPE)).toBe(true)
    expect(isStorablePaymentLink('coinbase', STRIPE)).toBe(false)
    expect(isStorablePaymentLink('coinbase', 'https://payments.coinbase.com/payment-sessions/paymentSession_1')).toBe(true)
    expect(coinbaseLinkFromId('pl_abc')).toBe('https://payments.coinbase.com/payment-links/pl_abc')
    expect(coinbaseLinkFromId('paymentSession_abc')).toBe('https://payments.coinbase.com/payment-sessions/paymentSession_abc')
    expect(coinbaseLinkFromId('cpis_abc')).toBeNull()
  })
})
