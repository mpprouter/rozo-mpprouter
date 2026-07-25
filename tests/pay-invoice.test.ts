/**
 * Regression tests for pay-invoice alias normalization, pl_ extraction,
 * and structured error responses.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizePayInvoiceBody,
  extractCoinbaseCheckoutId,
  extractPaymentLinkId,
} from '../src/routes/pay-invoice-admin'

// ── extractPaymentLinkId ─────────────────────────────────────────────────────

describe('extractPaymentLinkId', () => {
  it('extracts pl_ id from a Coinbase payment link URL', () => {
    expect(
      extractPaymentLinkId('https://commerce.coinbase.com/payment-links/pl_abc123XYZ'),
    ).toBe('pl_abc123XYZ')
  })

  it('extracts pl_ id with query string present', () => {
    expect(
      extractPaymentLinkId('https://payments.coinbase.com/payment-links/pl_XYZ?ref=test'),
    ).toBe('pl_XYZ')
  })

  it('returns null for a URL without pl_ path', () => {
    expect(
      extractPaymentLinkId('https://example.com/checkout/abc123'),
    ).toBeNull()
  })

  it('returns null for a plain payment_id string (not a URL)', () => {
    expect(extractPaymentLinkId('pl_abc123')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(extractPaymentLinkId('')).toBeNull()
  })
})

describe('extractCoinbaseCheckoutId', () => {
  it('extracts a Coinbase payment session v3 id', () => {
    expect(
      extractCoinbaseCheckoutId(
        'https://payments.coinbase.com/payment-sessions/paymentSession_a5306b93-e4b7-4c28-8799-f991da38bf22',
      ),
    ).toBe('paymentSession_a5306b93-e4b7-4c28-8799-f991da38bf22')
  })

  it('keeps extracting legacy payment link ids', () => {
    expect(
      extractCoinbaseCheckoutId('https://payments.coinbase.com/payment-links/pl_abc123'),
    ).toBe('pl_abc123')
  })

  it('rejects a Coinbase-shaped path on an untrusted host', () => {
    expect(
      extractCoinbaseCheckoutId(
        'https://example.com/payment-sessions/paymentSession_abc123',
      ),
    ).toBeNull()
  })
})

// ── normalizePayInvoiceBody — canonical fields ────────────────────────────────

describe('normalizePayInvoiceBody — canonical fields', () => {
  it('accepts canonical { url }', () => {
    const r = normalizePayInvoiceBody({ url: 'https://example.com/pay' })
    expect(r.normalized).toEqual({ url: 'https://example.com/pay' })
    expect(r.error).toBeUndefined()
  })

  it('accepts canonical { payment_id }', () => {
    const r = normalizePayInvoiceBody({ payment_id: 'pl_test123' })
    expect(r.normalized).toEqual({ payment_id: 'pl_test123' })
    expect(r.error).toBeUndefined()
  })

  it('trims whitespace from canonical fields', () => {
    const r = normalizePayInvoiceBody({ url: '  https://example.com/pay  ' })
    expect(r.normalized).toEqual({ url: 'https://example.com/pay' })
  })
})

// ── normalizePayInvoiceBody — url aliases ────────────────────────────────────

describe('normalizePayInvoiceBody — url aliases', () => {
  const aliases: Array<[string, string]> = [
    ['url', 'https://example.com/pay'],
    ['payment_link', 'https://example.com/pay'],
    ['link', 'https://example.com/pay'],
    ['invoice_url', 'https://example.com/pay'],
  ]

  for (const [field, value] of aliases) {
    it(`accepts { ${field} } and normalizes to { url }`, () => {
      const r = normalizePayInvoiceBody({ [field]: value })
      expect(r.normalized).toEqual({ url: value })
      expect(r.error).toBeUndefined()
    })
  }
})

// ── normalizePayInvoiceBody — id aliases ─────────────────────────────────────

describe('normalizePayInvoiceBody — id aliases', () => {
  const aliases: Array<[string, string]> = [
    ['payment_id', 'pl_abc'],
    ['id', 'pl_abc'],
    ['invoice_id', 'pl_abc'],
    ['paymentLinkId', 'pl_abc'],
  ]

  for (const [field, value] of aliases) {
    it(`accepts { ${field} } and normalizes to { payment_id }`, () => {
      const r = normalizePayInvoiceBody({ [field]: value })
      expect(r.normalized).toEqual({ payment_id: value })
      expect(r.error).toBeUndefined()
    })
  }
})

// ── normalizePayInvoiceBody — URL-only with pl_ extraction ───────────────────

describe('normalizePayInvoiceBody — pl_ detection from URL', () => {
  it('detects link_id_detected when url contains pl_ path', () => {
    const r = normalizePayInvoiceBody({
      url: 'https://commerce.coinbase.com/payment-links/pl_abc123',
    })
    expect(r.normalized).toEqual({ url: 'https://commerce.coinbase.com/payment-links/pl_abc123' })
    expect(r.link_id_detected).toBe('pl_abc123')
  })

  it('link_id_detected is null for plain URL without pl_ path', () => {
    const r = normalizePayInvoiceBody({ url: 'https://example.com/checkout' })
    expect(r.link_id_detected).toBeNull()
  })

  it('uses payment_id when both url and id provided (payment_id wins)', () => {
    const r = normalizePayInvoiceBody({
      url: 'https://commerce.coinbase.com/payment-links/pl_fromurl',
      payment_id: 'pl_explicit',
    })
    expect(r.normalized).toEqual({ payment_id: 'pl_explicit' })
    expect(r.link_id_detected).toBe('pl_fromurl')
  })

  it('alias payment_link with pl_ URL detects link_id_detected', () => {
    const r = normalizePayInvoiceBody({
      payment_link: 'https://payments.coinbase.com/payment-links/pl_XYZ',
    })
    expect(r.normalized).toEqual({ url: 'https://payments.coinbase.com/payment-links/pl_XYZ' })
    expect(r.link_id_detected).toBe('pl_XYZ')
  })

  it('accepts a Coinbase payment session v3 URL unchanged and detects its id', () => {
    const url =
      'https://payments.coinbase.com/payment-sessions/paymentSession_a5306b93-e4b7-4c28-8799-f991da38bf22'
    const r = normalizePayInvoiceBody({ url })
    expect(r.normalized).toEqual({ url })
    expect(r.provider_detected).toBe('coinbase')
    expect(r.link_id_detected).toBe(
      'paymentSession_a5306b93-e4b7-4c28-8799-f991da38bf22',
    )
  })
})

// ── normalizePayInvoiceBody — error cases ────────────────────────────────────

describe('normalizePayInvoiceBody — INVALID_INPUT errors', () => {
  it('returns INVALID_INPUT when body is null', () => {
    const r = normalizePayInvoiceBody(null)
    expect(r.normalized).toBeNull()
    expect(r.error?.code).toBe('INVALID_INPUT')
  })

  it('returns INVALID_INPUT when body is a string', () => {
    const r = normalizePayInvoiceBody('not-an-object')
    expect(r.normalized).toBeNull()
    expect(r.error?.code).toBe('INVALID_INPUT')
  })

  it('returns INVALID_INPUT when no recognized field is present', () => {
    const r = normalizePayInvoiceBody({ foo: 'bar' })
    expect(r.normalized).toBeNull()
    expect(r.error?.code).toBe('INVALID_INPUT')
  })

  it('returns INVALID_INPUT when all recognized fields are empty strings', () => {
    const r = normalizePayInvoiceBody({ url: '', payment_id: '  ' })
    expect(r.normalized).toBeNull()
    expect(r.error?.code).toBe('INVALID_INPUT')
  })

  it('error includes route_capabilities for discoverability', () => {
    const r = normalizePayInvoiceBody({})
    expect(r.error?.route_capabilities).toBeDefined()
    expect(Array.isArray(r.error?.route_capabilities)).toBe(true)
  })

  it('error includes hint for discoverability', () => {
    const r = normalizePayInvoiceBody({})
    expect(typeof r.error?.hint).toBe('string')
    expect(r.error!.hint!.length).toBeGreaterThan(0)
  })
})

// ── normalizePayInvoiceBody — raw field tracking ─────────────────────────────

describe('normalizePayInvoiceBody — raw field tracking', () => {
  it('tracks raw_url when url alias is used', () => {
    const r = normalizePayInvoiceBody({ payment_link: 'https://x.com/pay' })
    expect(r.raw_url).toBe('https://x.com/pay')
    expect(r.raw_id).toBe('')
  })

  it('tracks raw_id when id alias is used', () => {
    const r = normalizePayInvoiceBody({ invoice_id: 'pl_abc' })
    expect(r.raw_id).toBe('pl_abc')
    expect(r.raw_url).toBe('')
  })
})
