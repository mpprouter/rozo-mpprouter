/**
 * Unit tests for the router→merchant 402 sanitizer
 * (src/mpp/tempo-client.ts sanitize402Response).
 *
 * Root cause it defends (docs/rootcause-invalid-base64-json-header-2026-06-24.md):
 * mppx 0.7.0's x402 parser rejects the WHOLE `payment-required` header if any
 * `accepts[]` offer has a non-EVM network (e.g. a `solana:` offer), which also
 * discards the usable www-authenticate (Tempo) challenge and 502s the request.
 *
 * The oracle in these tests is mppx's OWN parser (Transport.http().getChallenges),
 * so we assert the real downstream behavior, not a reimplementation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Transport } from 'mppx/client'
import { sanitize402Response } from '../src/mpp/tempo-client'

const EVM_OFFER = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '20000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}
const SOLANA_OFFER = {
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  amount: '20000',
  asset: 'So11111111111111111111111111111111111111112',
  payTo: 'HvBMG7ezcwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  maxTimeoutSeconds: 300,
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

function paymentRequired(accepts: unknown[]): string {
  return b64({
    x402Version: 2,
    resource: { url: 'https://merchant.example/api/send' },
    accepts,
    extensions: {},
  })
}

function resp402(headers: Record<string, string>): Response {
  return new Response('{"detail":"payment required"}', {
    status: 402,
    headers,
  })
}

/** True iff mppx's real parser accepts the (possibly-sanitized) response. */
function mppxParses(r: Response): boolean {
  try {
    const t = Transport.http()
    t.getChallenges ? t.getChallenges(r) : t.getChallenge(r)
    return true
  } catch {
    return false
  }
}

afterEach(() => vi.restoreAllMocks())

describe('sanitize402Response', () => {
  it('passes through non-402 responses untouched', () => {
    const r = new Response('ok', { status: 200, headers: { 'payment-required': 'garbage' } })
    expect(sanitize402Response(r)).toBe(r)
  })

  it('passes through 402 with no payment-required header untouched', () => {
    const r = resp402({ 'www-authenticate': 'Payment id="x", method="tempo", intent="charge"' })
    expect(sanitize402Response(r)).toBe(r)
  })

  it('leaves an already-parseable header untouched (fast path)', () => {
    // EVM-only header that mppx already accepts.
    const r = resp402({ 'payment-required': paymentRequired([EVM_OFFER]) })
    // Precondition: mppx accepts it as-is.
    expect(mppxParses(r)).toBe(true)
    const out = sanitize402Response(r)
    expect(out).toBe(r) // same object — no rewrite
  })

  it('drops a poisoning solana offer so mppx can parse the rewrite', () => {
    const r = resp402({ 'payment-required': paymentRequired([EVM_OFFER, SOLANA_OFFER]) })
    // Precondition: the unsanitized header poisons mppx.
    expect(mppxParses(r)).toBe(false)
    const out = sanitize402Response(r)
    expect(out).not.toBe(r)
    // The rewrite must now be parseable by mppx's real parser.
    expect(mppxParses(out)).toBe(true)
    // And it must still carry a payment-required header (EVM offer kept).
    expect(out.headers.get('payment-required')).toBeTruthy()
    const decoded = JSON.parse(Buffer.from(out.headers.get('payment-required')!, 'base64').toString())
    expect(decoded.accepts).toHaveLength(1)
    expect(decoded.accepts[0].network).toBe('eip155:8453')
  })

  it('strips payment-required and falls back to www-authenticate when no EVM offer survives', () => {
    const r = resp402({
      'payment-required': paymentRequired([SOLANA_OFFER]), // only non-EVM
      'www-authenticate': 'Payment id="x", realm="m", method="tempo", intent="charge", request="eyJ9"',
    })
    const out = sanitize402Response(r)
    expect(out.headers.get('payment-required')).toBeNull() // stripped
    expect(out.headers.get('www-authenticate')).toBeTruthy() // preserved
  })

  it('forwards UNCHANGED (does not swallow) when unparseable AND no www-authenticate fallback', () => {
    // Solana-only, no www-authenticate: nothing we can pay → must surface
    // mppx's own error, not silently strip into a no-challenge response.
    const r = resp402({ 'payment-required': paymentRequired([SOLANA_OFFER]) })
    const out = sanitize402Response(r)
    // payment-required preserved so mppx raises its real InvalidJsonHeaderError.
    expect(out.headers.get('payment-required')).toBe(r.headers.get('payment-required'))
    expect(mppxParses(out)).toBe(false)
  })

  it('handles base64/JSON garbage: strip to www-authenticate if present', () => {
    const r = resp402({
      'payment-required': '!!!not base64 json!!!',
      'www-authenticate': 'Payment id="x", method="tempo", intent="charge"',
    })
    const out = sanitize402Response(r)
    expect(out.headers.get('payment-required')).toBeNull()
    expect(out.headers.get('www-authenticate')).toBeTruthy()
  })

  it('caps oversized headers without parsing them (DoS guard)', () => {
    const huge = 'A'.repeat(17 * 1024) // > 16 KiB cap
    const r = resp402({
      'payment-required': huge,
      'www-authenticate': 'Payment id="x", method="tempo", intent="charge"',
    })
    const out = sanitize402Response(r)
    // Oversized + www-authenticate present → strip.
    expect(out.headers.get('payment-required')).toBeNull()
  })

  it('does NOT feed an oversized header into mppx parsing (codex #1 — size check precedes parse)', () => {
    const canParse = vi.fn(() => false)
    const huge = 'A'.repeat(17 * 1024) // > 16 KiB cap
    const r = resp402({
      'payment-required': huge,
      'www-authenticate': 'Payment id="x", method="tempo", intent="charge"',
    })
    const out = sanitize402Response(r, canParse)
    expect(out.headers.get('payment-required')).toBeNull() // stripped
    // The size guard must short-circuit BEFORE any parse attempt.
    expect(canParse).not.toHaveBeenCalled()
  })

  it('STRIPS an oversized header (never returns it to mppx) even with no www-authenticate fallback', () => {
    // codex R2: returning the oversized header unchanged would let mppx
    // (this wrapper sits under Mppx.create) re-parse 17 KiB of attacker
    // bytes. The header must ALWAYS be stripped; the 402 then carries no
    // challenge and mppx raises a clean "no challenge" error.
    const canParse = vi.fn(() => false)
    const huge = 'A'.repeat(17 * 1024)
    const r = resp402({ 'payment-required': huge })
    const out = sanitize402Response(r, canParse)
    expect(out.headers.get('payment-required')).toBeNull() // stripped, not returned
    expect(canParse).not.toHaveBeenCalled() // never parsed
  })

  it('preserves the kept EVM offer byte-for-byte semantically (no payTo/amount drift)', () => {
    const r = resp402({ 'payment-required': paymentRequired([EVM_OFFER, SOLANA_OFFER]) })
    const out = sanitize402Response(r)
    const decoded = JSON.parse(Buffer.from(out.headers.get('payment-required')!, 'base64').toString())
    expect(decoded.accepts[0]).toEqual(EVM_OFFER) // identical offer, no mutation
  })
})
