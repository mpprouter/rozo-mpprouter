import { describe, it, expect } from 'vitest'
import { redactIdentifiers, identifierKeys, ipPrefix } from '../src/utils/redact'

const SECRET = 'unit-test-hmac-secret'

describe('ipPrefix', () => {
  it('reduces IPv4 to a /24 network', () => {
    expect(ipPrefix('203.0.113.47')).toBe('203.0.113.0/24')
  })
  it('reduces IPv6 to a /48 network', () => {
    expect(ipPrefix('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48')
  })
  it('collapses missing/garbage IPs to a single bucket', () => {
    expect(ipPrefix('')).toBe('unknown')
    expect(ipPrefix(null)).toBe('unknown')
    expect(ipPrefix('not-an-ip')).toBe('unknown')
  })
})

describe('redactIdentifiers', () => {
  it('produces hex HMAC digests, never the plaintext', async () => {
    const r = await redactIdentifiers(SECRET, {
      code: '12345678',
      paymentId: 'pl_abcDEF123',
      ip: '203.0.113.47',
    })
    for (const h of [r.codeHash, r.paymentIdHash, r.pairHash, r.ipPrefixHash]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    }
    // No digest may contain the plaintext of any input.
    const blob = JSON.stringify(r)
    expect(blob).not.toContain('12345678')
    expect(blob).not.toContain('pl_abcDEF123')
    expect(blob).not.toContain('203.0.113.47')
  })

  it('is deterministic under the same key and diverges under a different key', async () => {
    const a = await redactIdentifiers(SECRET, { code: '12345678', ip: '1.2.3.4' })
    const b = await redactIdentifiers(SECRET, { code: '12345678', ip: '1.2.3.4' })
    const c = await redactIdentifiers('other-key', { code: '12345678', ip: '1.2.3.4' })
    expect(a.codeHash).toBe(b.codeHash)
    expect(a.codeHash).not.toBe(c.codeHash) // key rotation severs correlation
  })

  it('leaves code/paymentId/pair null when the input is absent', async () => {
    const r = await redactIdentifiers(SECRET, { ip: '1.2.3.4' })
    expect(r.codeHash).toBeNull()
    expect(r.paymentIdHash).toBeNull()
    expect(r.pairHash).toBeNull()
    expect(r.ipPrefixHash).toMatch(/^[0-9a-f]{64}$/) // always present
  })

  it('domain-separates code vs payment id digests (no cross-column collision)', async () => {
    // Same string used as a code and as a payment id must hash differently.
    const asCode = await redactIdentifiers(SECRET, { code: '12345678' })
    const asPid = await redactIdentifiers(SECRET, { paymentId: '12345678' })
    expect(asCode.codeHash).not.toBe(asPid.paymentIdHash)
  })

  it('pair digest depends on BOTH code and payment id', async () => {
    const p1 = (await redactIdentifiers(SECRET, { code: '11111111', paymentId: 'pl_a' })).pairHash
    const p2 = (await redactIdentifiers(SECRET, { code: '11111111', paymentId: 'pl_b' })).pairHash
    const p3 = (await redactIdentifiers(SECRET, { code: '22222222', paymentId: 'pl_a' })).pairHash
    expect(new Set([p1, p2, p3]).size).toBe(3)
  })
})

describe('identifierKeys', () => {
  it('mirrors the redaction digests for DO counter keys', async () => {
    const ids = await identifierKeys(SECRET, { code: '12345678', paymentId: 'pl_x', ip: '1.2.3.4' })
    const red = await redactIdentifiers(SECRET, { code: '12345678', paymentId: 'pl_x', ip: '1.2.3.4' })
    expect(ids.code).toBe(red.codeHash)
    expect(ids.pair).toBe(red.pairHash)
    expect(ids.ipPrefix).toBe(red.ipPrefixHash)
  })
})
