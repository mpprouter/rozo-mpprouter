/**
 * Provider detection + Stripe blob extraction + Coinbase-regression tests.
 * Covers strict host allowlisting (look-alike hosts must NOT match) and
 * confirms normalizePayInvoiceBody still classifies Coinbase URLs unchanged.
 */

import { describe, it, expect } from 'vitest'
import {
  detectProvider,
  normalizeInvoiceUrl,
  extractStripeSessionBlob,
  extractPaymentLinkId,
  normalizePayInvoiceBody,
} from '../src/routes/pay-invoice-admin'

describe('detectProvider — strict host allowlist', () => {
  it('detects Stripe crypto checkout host', () => {
    expect(detectProvider('https://crypto.stripe.com/pay/CDM123abc')).toBe('stripe_crypto')
  })

  it('detects Coinbase payment-links host', () => {
    expect(detectProvider('https://payments.coinbase.com/payment-links/pl_abc')).toBe('coinbase')
  })

  it('detects Coinbase payment-sessions v3 host', () => {
    expect(
      detectProvider(
        'https://payments.coinbase.com/payment-sessions/paymentSession_abc-123',
      ),
    ).toBe('coinbase')
  })

  it('detects Coinbase commerce host', () => {
    expect(detectProvider('https://commerce.coinbase.com/payment-links/pl_abc')).toBe('coinbase')
  })

  it('rejects a look-alike host (crypto.stripe.com.evil.com)', () => {
    expect(detectProvider('https://crypto.stripe.com.evil.com/pay/CDM')).toBeNull()
  })

  it('rejects a look-alike host (evilcrypto.stripe.com is NOT crypto.stripe.com)', () => {
    // hostname is evilcrypto.stripe.com — not on the allowlist
    expect(detectProvider('https://evilcrypto.stripe.com/pay/CDM')).toBeNull()
  })

  it('rejects a subdomain of coinbase that is not on the allowlist', () => {
    expect(detectProvider('https://evil.coinbase.com/payment-links/pl_abc')).toBeNull()
  })

  it('rejects a totally unrelated host', () => {
    expect(detectProvider('https://example.com/pay/CDM')).toBeNull()
  })

  it('accepts http:// on allowlisted hosts (upgraded to https by normalizeInvoiceUrl)', () => {
    expect(detectProvider('http://crypto.stripe.com/pay/CDM')).toBe('stripe_crypto')
    expect(detectProvider('http://payments.coinbase.com/payment-links/pl_abc')).toBe('coinbase')
    expect(detectProvider('http://crypto.stripe.com.evil.com/pay/CDM')).toBeNull()
    expect(detectProvider('ftp://crypto.stripe.com/pay/CDM')).toBeNull()
  })

  it('rejects a malformed URL', () => {
    expect(detectProvider('not a url')).toBeNull()
  })

  it('is case-insensitive on host', () => {
    expect(detectProvider('https://CRYPTO.STRIPE.COM/pay/CDM')).toBe('stripe_crypto')
  })
})

describe('extractStripeSessionBlob', () => {
  it('extracts the /pay/<blob> segment for a valid Stripe URL', () => {
    expect(extractStripeSessionBlob('https://crypto.stripe.com/pay/CDM_abc-123')).toBe(
      'CDM_abc-123',
    )
  })

  it('extracts blob with a trailing query string', () => {
    expect(extractStripeSessionBlob('https://crypto.stripe.com/pay/CDMxyz?foo=bar')).toBe('CDMxyz')
  })

  it('returns null for a non-Stripe host even if /pay/ present', () => {
    expect(extractStripeSessionBlob('https://example.com/pay/CDMxyz')).toBeNull()
  })

  it('returns null for a Stripe host without /pay/ segment', () => {
    expect(extractStripeSessionBlob('https://crypto.stripe.com/other/CDM')).toBeNull()
  })

  it('returns null for a look-alike host', () => {
    expect(extractStripeSessionBlob('https://crypto.stripe.com.evil.com/pay/CDM')).toBeNull()
  })
})

describe('Coinbase regression — extractPaymentLinkId unchanged', () => {
  it('still extracts pl_ id', () => {
    expect(
      extractPaymentLinkId('https://payments.coinbase.com/payment-links/pl_abc123XYZ'),
    ).toBe('pl_abc123XYZ')
  })
})

describe('normalizePayInvoiceBody — provider_detected additive field', () => {
  it('sets provider_detected=coinbase for a Coinbase URL and keeps normalized unchanged', () => {
    const r = normalizePayInvoiceBody({
      url: 'https://payments.coinbase.com/payment-links/pl_abc',
    })
    expect(r.normalized).toEqual({ url: 'https://payments.coinbase.com/payment-links/pl_abc' })
    expect(r.provider_detected).toBe('coinbase')
    expect(r.link_id_detected).toBe('pl_abc')
  })

  it('sets provider_detected=stripe_crypto for a Stripe URL', () => {
    const r = normalizePayInvoiceBody({ url: 'https://crypto.stripe.com/pay/CDM123' })
    expect(r.normalized).toEqual({ url: 'https://crypto.stripe.com/pay/CDM123' })
    expect(r.provider_detected).toBe('stripe_crypto')
    // Stripe URL has no pl_ id
    expect(r.link_id_detected).toBeNull()
  })

  it('provider_detected is null for a plain payment_id (no URL)', () => {
    const r = normalizePayInvoiceBody({ payment_id: 'pl_abc' })
    expect(r.normalized).toEqual({ payment_id: 'pl_abc' })
    expect(r.provider_detected).toBeNull()
  })

  it('provider_detected is null for an unknown host URL', () => {
    const r = normalizePayInvoiceBody({ url: 'https://example.com/checkout' })
    expect(r.provider_detected).toBeNull()
  })
})

describe('normalizeInvoiceUrl — http:// is rewritten to https:// for known providers', () => {
  it('upgrades http on stripe and coinbase hosts', () => {
    expect(normalizeInvoiceUrl('http://crypto.stripe.com/pay/CDM')).toBe(
      'https://crypto.stripe.com/pay/CDM',
    )
    expect(normalizeInvoiceUrl('http://payments.coinbase.com/payment-links/pl_abc')).toBe(
      'https://payments.coinbase.com/payment-links/pl_abc',
    )
  })
  it('leaves https and unknown inputs byte-identical', () => {
    const https = 'https://crypto.stripe.com/pay/CDM'
    expect(normalizeInvoiceUrl(https)).toBe(https)
    expect(normalizeInvoiceUrl('http://example.com/pay/CDM')).toBe('http://example.com/pay/CDM')
    expect(normalizeInvoiceUrl('not a url')).toBe('not a url')
    expect(normalizeInvoiceUrl('pl_abc')).toBe('pl_abc')
  })
  it('normalizePayInvoiceBody exposes the https form and classifies the provider', () => {
    const r = normalizePayInvoiceBody({ url: 'http://crypto.stripe.com/pay/CDM' })
    expect(r.provider_detected).toBe('stripe_crypto')
    expect(r.normalized).toEqual({ url: 'https://crypto.stripe.com/pay/CDM' })
    const c = normalizePayInvoiceBody({ url: 'http://payments.coinbase.com/payment-links/pl_abc' })
    expect(c.provider_detected).toBe('coinbase')
    expect(c.link_id_detected).toBe('pl_abc')
  })
})
