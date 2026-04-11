/**
 * Tests for the overpay tolerance policy, header parser, and
 * dispatch classifier in the stellar.x402 branch.
 *
 * Policy (locked in during tasks/todo.md design conversation):
 *   - signed < merchant         → reject
 *   - signed === merchant       → accept
 *   - overpay ≤ max(10¢, 10% of merchant) → accept (router margin)
 *   - overpay > both            → reject
 *
 * Base units assume Stellar USDC (7 decimals): 10¢ = 1_000_000.
 */
import { describe, it, expect } from 'vitest'
import {
  isAmountAcceptable,
  isStellarX402ForThisRouter,
  parseStellarX402Header,
} from './stellar-x402-server'

// 1 USD = 10_000_000 base units at 7 decimals
const usdc = (n: number) => BigInt(n * 10_000_000)
const cents = (n: number) => BigInt(n * 100_000)

describe('isAmountAcceptable (stellar usdc, 7 decimals)', () => {
  it('rejects underpay', () => {
    const result = isAmountAcceptable(usdc(1) - 1n, usdc(1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/underpay/)
  })

  it('accepts exact match', () => {
    expect(isAmountAcceptable(usdc(1), usdc(1)).ok).toBe(true)
  })

  it('accepts 5¢ overpay on $1 quote (absolute rule)', () => {
    expect(isAmountAcceptable(usdc(1) + cents(5), usdc(1)).ok).toBe(true)
  })

  it('accepts exactly 10¢ overpay on $1 quote (boundary)', () => {
    expect(isAmountAcceptable(usdc(1) + cents(10), usdc(1)).ok).toBe(true)
  })

  it('rejects 15¢ overpay on $1 quote (exceeds both limits)', () => {
    // 10% of $1 = 10¢, absolute tolerance = 10¢
    // 15¢ > 10¢ AND 15¢ > 10¢ → reject
    expect(isAmountAcceptable(usdc(1) + cents(15), usdc(1)).ok).toBe(false)
  })

  it('accepts 30¢ overpay on $5 quote (relative rule kicks in)', () => {
    // 10% of $5 = 50¢; 30¢ < 50¢ → accept (relative rule, even though
    // absolute rule of 10¢ would have rejected)
    expect(isAmountAcceptable(usdc(5) + cents(30), usdc(5)).ok).toBe(true)
  })

  it('rejects $1 overpay on $5 quote', () => {
    // 10% of $5 = 50¢, $1 > 50¢ AND $1 > 10¢ → reject
    expect(isAmountAcceptable(usdc(5) + usdc(1), usdc(5)).ok).toBe(false)
  })

  it('accepts 5¢ overpay on $0.01 quote (small-quote friendly via absolute rule)', () => {
    // 10% of 1¢ = 0.1¢ → floors to 0 in bigint
    // 5¢ < 10¢ absolute → accept
    expect(isAmountAcceptable(cents(1) + cents(5), cents(1)).ok).toBe(true)
  })

  it('rejects 11¢ overpay on $0.01 quote (just past absolute)', () => {
    // 11¢ > 10¢ absolute AND 11¢ > 0.1¢ (floored to 0) relative → reject
    expect(isAmountAcceptable(cents(1) + cents(11), cents(1)).ok).toBe(false)
  })

  it('handles bigint overflow edge', () => {
    const huge = 2n ** 64n
    expect(isAmountAcceptable(huge, huge).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------
// parse + dispatch
// ---------------------------------------------------------------------

const ROUTER_PAY_TO = 'GCTGI65YXLLJJ2NWC6OJNHGZWE6HCMZLNODL4DUJ2NRYTKHMC2YMVDQL'
const FAKE_ENV = {
  X402_ENABLED: 'true',
  STELLAR_NETWORK: 'stellar:pubnet',
  STELLAR_X402_PAY_TO: ROUTER_PAY_TO,
} as any

/**
 * Build a minimal x402 V2 payload with the given payTo. The
 * `payload` field contains what looks like a Stellar exact scheme
 * auth entry (from + nonce) — not actually signed, but enough to
 * round-trip through parseStellarX402Header and exercise the
 * classifier.
 */
function buildV2Payload(
  payTo: string,
  network = 'stellar:pubnet',
  amount = '100000', // 0.01 USDC at 7 decimals
) {
  const inner = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network,
      amount,
      asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      payTo,
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload: {
      from: 'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7',
      nonce: '1234567890',
      transaction: 'AAAA...', // placeholder
    },
  }
  const b64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64')
  return `Payment ${b64}`
}

describe('parseStellarX402Header', () => {
  it('returns null on missing Payment prefix', () => {
    expect(parseStellarX402Header('Bearer xyz')).toBeNull()
  })

  it('returns null on garbage after Payment prefix', () => {
    expect(parseStellarX402Header('Payment not-base64!!!')).toBeNull()
  })

  it('returns null on non-JSON base64 content', () => {
    const b64 = Buffer.from('hello world', 'utf8').toString('base64')
    expect(parseStellarX402Header(`Payment ${b64}`)).toBeNull()
  })

  it('returns null on JSON that is not a PaymentPayload', () => {
    const b64 = Buffer.from('{"x402Version":99}', 'utf8').toString('base64')
    expect(parseStellarX402Header(`Payment ${b64}`)).toBeNull()
  })

  it('returns null on V1 payloads (we only support V2)', () => {
    const v1 = {
      x402Version: 1,
      scheme: 'exact',
      network: 'stellar:pubnet',
      payload: {},
    }
    const b64 = Buffer.from(JSON.stringify(v1), 'utf8').toString('base64')
    expect(parseStellarX402Header(`Payment ${b64}`)).toBeNull()
  })

  it('parses a valid V2 payload', () => {
    const header = buildV2Payload(ROUTER_PAY_TO)
    const result = parseStellarX402Header(header)
    expect(result).not.toBeNull()
    expect(result!.x402Version).toBe(2)
    expect(result!.accepted.payTo).toBe(ROUTER_PAY_TO)
  })
})

describe('isStellarX402ForThisRouter', () => {
  it('returns false when X402_ENABLED is "false"', () => {
    const header = buildV2Payload(ROUTER_PAY_TO)
    const envOff = { ...FAKE_ENV, X402_ENABLED: 'false' }
    expect(isStellarX402ForThisRouter(header, envOff)).toBe(false)
  })

  it('returns false for a credential paying a different address', () => {
    const header = buildV2Payload(
      'GDDIFFERENT2K7XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    )
    expect(isStellarX402ForThisRouter(header, FAKE_ENV)).toBe(false)
  })

  it('returns false for a credential on the wrong network', () => {
    const header = buildV2Payload(ROUTER_PAY_TO, 'stellar:testnet')
    expect(isStellarX402ForThisRouter(header, FAKE_ENV)).toBe(false)
  })

  it('returns true for a correctly-addressed credential', () => {
    const header = buildV2Payload(ROUTER_PAY_TO)
    expect(isStellarX402ForThisRouter(header, FAKE_ENV)).toBe(true)
  })

  it('returns false for non-Payment headers', () => {
    expect(isStellarX402ForThisRouter('Bearer abc', FAKE_ENV)).toBe(false)
  })

  it('returns false for empty header', () => {
    expect(isStellarX402ForThisRouter('', FAKE_ENV)).toBe(false)
  })

  it('stellar address comparison is case-sensitive (unlike EVM)', () => {
    // Stellar G... addresses encode curve data — lowercasing changes
    // the identity. A lowercased payTo must NOT match.
    const header = buildV2Payload(ROUTER_PAY_TO.toLowerCase())
    expect(isStellarX402ForThisRouter(header, FAKE_ENV)).toBe(false)
  })
})
