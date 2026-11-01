import { describe, it, expect } from 'vitest'
import {
  canonicalCoinbaseCheckoutUrl,
  normalizeInvoiceUrl,
  normalizePayInvoiceBody,
} from '../src/routes/pay-invoice-admin'
import { classifyUpiUrl } from '../src/routes/upi-invoice'

const SESSION = 'paymentSession_31532424-74fd-474a-9f2f-fcf5f5d6ee82'
const UUID = '31532424-74fd-474a-9f2f-fcf5f5d6ee82'
const CANON = `https://payments.coinbase.com/payment-sessions/${SESSION}`
const WRAPPER =
  `https://wallet.coinbase.com/base-pay?paymentSessionId=${SESSION}` +
  '&baseURL=https%3A%2F%2Fapi.cdp.coinbase.com%2Fplatform&amount=10.50&asset=usdc'

describe('canonicalCoinbaseCheckoutUrl', () => {
  it('maps the Base wallet wrapper to the payment-sessions URL', () => {
    expect(canonicalCoinbaseCheckoutUrl(WRAPPER)).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl(`  ${WRAPPER}  `)).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl(WRAPPER.replace('wallet.coinbase.com', 'WALLET.Coinbase.com'))).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl(WRAPPER.replace('/base-pay?', '/base-pay/?'))).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl(WRAPPER.replace('https://', 'http://'))).toBe(CANON)
  })

  it('prefixes a bare UUID session id inside the wrapper', () => {
    expect(canonicalCoinbaseCheckoutUrl(`https://wallet.coinbase.com/base-pay?paymentSessionId=${UUID}`)).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl(`https://wallet.coinbase.com/base-pay?paymentSessionId=${UUID.toUpperCase()}`)).toBe(CANON)
  })

  it('maps bare ids and scheme-less payments.coinbase.com URLs', () => {
    expect(canonicalCoinbaseCheckoutUrl(SESSION)).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl('pl_01abc')).toBe('https://payments.coinbase.com/payment-links/pl_01abc')
    expect(canonicalCoinbaseCheckoutUrl(`payments.coinbase.com/payment-sessions/${SESSION}?x=1`)).toBe(CANON)
    expect(canonicalCoinbaseCheckoutUrl('payments.coinbase.com/payment-links/pl_01abc')).toBe(
      'https://payments.coinbase.com/payment-links/pl_01abc',
    )
  })

  it('refuses look-alike hosts, other paths and bad or ambiguous ids', () => {
    const bad = [
      WRAPPER.replace('wallet.coinbase.com', 'wallet.coinbase.com.evil.com'),
      WRAPPER.replace('wallet.coinbase.com', 'evilwallet.coinbase.com'),
      WRAPPER.replace('wallet.coinbase.com', 'evil.com'),
      WRAPPER.replace('/base-pay', '/base-pay-x'),
      WRAPPER.replace('/base-pay', '/other'),
      'https://wallet.coinbase.com/base-pay',
      'https://wallet.coinbase.com/base-pay?paymentSessionId=',
      'https://wallet.coinbase.com/base-pay?paymentSessionId=not-an-id',
      `https://wallet.coinbase.com/base-pay?paymentSessionId=pl_abc`,
      `https://wallet.coinbase.com/base-pay?paymentSessionId=${SESSION}&paymentSessionId=${SESSION}`,
      `javascript://wallet.coinbase.com/base-pay?paymentSessionId=${SESSION}`,
      'payments.coinbase.com/elsewhere/x',
      `${SESSION} extra`,
      'pl_abc/../x',
      '',
      'not a url',
    ]
    for (const s of bad) expect(canonicalCoinbaseCheckoutUrl(s), s).toBeNull()
  })
})

describe('normalizeInvoiceUrl / normalizePayInvoiceBody with other spellings', () => {
  it('existing canonical, http and Stripe inputs are unchanged', () => {
    expect(normalizeInvoiceUrl(CANON)).toBe(CANON)
    expect(normalizeInvoiceUrl(CANON.replace('https://', 'http://'))).toBe(CANON)
    expect(normalizeInvoiceUrl('https://crypto.stripe.com/pay/CDM')).toBe('https://crypto.stripe.com/pay/CDM')
    expect(normalizeInvoiceUrl('https://example.com/x')).toBe('https://example.com/x')
  })

  it('detects the link id for the wrapper and for a bare id', () => {
    for (const url of [WRAPPER, SESSION]) {
      const r = normalizePayInvoiceBody({ url })
      expect(r.normalized).toEqual({ url: CANON })
      expect(r.raw_url).toBe(CANON)
      expect(r.link_id_detected).toBe(SESSION)
      expect(r.provider_detected).toBe('coinbase')
    }
  })

  it('leaves look-alike wrappers unrecognized', () => {
    const evil = WRAPPER.replace('wallet.coinbase.com', 'wallet.coinbase.com.evil.com')
    const r = normalizePayInvoiceBody({ url: evil })
    expect(r.link_id_detected).toBeNull()
    expect(r.provider_detected).toBeNull()
  })
})

describe('classifyUpiUrl with other spellings', () => {
  it('stores the canonical URL for the wrapper and a bare id', () => {
    for (const url of [WRAPPER, SESSION]) {
      expect(classifyUpiUrl(url)).toEqual({ provider: 'coinbase_v3', invoiceKey: SESSION, payUrl: CANON })
    }
    expect(classifyUpiUrl('pl_01abc')).toEqual({
      provider: 'coinbase_v1',
      invoiceKey: 'pl_01abc',
      payUrl: 'https://payments.coinbase.com/payment-links/pl_01abc',
    })
  })

  it('rejects look-alike and malformed wrappers', () => {
    expect(classifyUpiUrl(WRAPPER.replace('wallet.coinbase.com', 'evilwallet.coinbase.com'))).toBeNull()
    expect(classifyUpiUrl(`${WRAPPER}&paymentSessionId=${SESSION}`)).toBeNull()
    expect(classifyUpiUrl('https://wallet.coinbase.com/base-pay?paymentSessionId=bad')).toBeNull()
  })
})
