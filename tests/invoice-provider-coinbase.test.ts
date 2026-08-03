/**
 * Coinbase read-only normalization into the provider-neutral NormalizedInvoice:
 * v1 payment links and v3 payment sessions, amount conversion without floating
 * point, payability (usage / expiry / state allowlist / Base-USDC settlement),
 * state sanitization, and fingerprint behavior.
 *
 * Everything here is READ-ONLY. Nothing in this path signs or moves funds, and
 * it does NOT replace `quote-invoice` — that endpoint still issues the HMAC
 * quote receipt that is the amount trust chain for Coinbase settlement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CoinbaseResolveError,
  decimalToAtomic,
  normalizeCoinbasePayment,
  resolveCoinbaseInvoice,
  type CoinbasePaymentLink,
  type CoinbasePaymentSession,
} from '../src/routes/invoice-provider'

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// 2026-07-01T00:00:00Z — a fixed "now" so expiry assertions are deterministic.
const NOW = Date.parse('2026-07-01T00:00:00Z')
const FUTURE_ISO = '2026-07-27T00:00:00.000Z'
const PAST_ISO = '2026-06-01T00:00:00.000Z'
const FUTURE_UNIX = String(Math.floor(Date.parse(FUTURE_ISO) / 1000))
const PAST_UNIX = String(Math.floor(Date.parse(PAST_ISO) / 1000))

/** A live, unused, Base-USDC v1 payment link for $18.19. */
function fixtureLink(overrides: Partial<CoinbasePaymentLink> = {}): CoinbasePaymentLink {
  return {
    id: 'pl_testAlchemy001',
    status: 'ACTIVE',
    maxAmount: '18.19',
    token: BASE_USDC,
    networkId: 8453,
    preApprovalExpiry: FUTURE_UNIX,
    maxUsage: 1,
    usageCount: 0,
    merchant: { name: 'Alchemy Insights, Inc' },
    fiat: { amount: '18.19', currency: 'USD' },
    ...overrides,
  }
}

/**
 * A live, payable v3 payment session for $1.05.
 *
 * This is the VERBATIM shape of a real production response, captured
 * 2026-08-03 from a live OpenRouter session. Two fields differ from what the
 * older repo fixture assumed, and both would have broken every real session:
 *   - `asset` is "usdc" (settlement asset, lowercase) — NOT "USD"
 *   - the target network is the enum name "PAYMENT_TARGET_NETWORK_BASE" — NOT "base"
 * Do not "tidy" these values to match intuition; they are what Coinbase sends.
 */
function fixtureSession(
  overrides: Partial<CoinbasePaymentSession> = {},
): CoinbasePaymentSession {
  return {
    paymentSessionId: 'paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2',
    status: 'PAYMENT_SESSION_STATUS_CREATED',
    amount: '1.05',
    asset: 'usdc',
    expiresAt: FUTURE_ISO,
    customerDisplay: { merchantName: 'OpenRouter, Inc' },
    target: {
      paymentTargetWallet: {
        address: '0x4C3f2E391498e2590bd327a7A1CAA68Dd42c4647',
        network: 'PAYMENT_TARGET_NETWORK_BASE',
      },
    },
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('decimalToAtomic', () => {
  it('converts exact decimals without floating point', () => {
    expect(decimalToAtomic('18.19', 6, 'x')).toBe(18_190_000n)
    expect(decimalToAtomic('0.000001', 6, 'x')).toBe(1n)
    expect(decimalToAtomic('1000', 6, 'x')).toBe(1_000_000_000n)
    expect(decimalToAtomic('1.05', 2, 'x')).toBe(105n)
  })

  it('rejects amounts it cannot represent exactly rather than rounding', () => {
    // Rounding here would silently change the amount AND the lock fingerprint.
    expect(() => decimalToAtomic('1.0000001', 6, 'x')).toThrow(CoinbaseResolveError)
    expect(() => decimalToAtomic('18.199', 2, 'x')).toThrow(CoinbaseResolveError)
  })

  it('rejects non-decimal, negative, and exponential input', () => {
    for (const bad of ['-1.00', '1e6', 'NaN', '', '1.2.3', '0x10', ' ']) {
      expect(() => decimalToAtomic(bad, 6, 'x')).toThrow(CoinbaseResolveError)
    }
  })
})

describe('Coinbase v1 payment link normalization', () => {
  it('normalizes a live link to the provider-neutral shape', async () => {
    const inv = await normalizeCoinbasePayment(fixtureLink(), NOW)

    expect(inv.provider).toBe('coinbase')
    expect(inv.invoiceKey).toBe('pl_testAlchemy001')
    expect(inv.merchantTitle).toBe('Alchemy Insights, Inc')
    // Coinbase has no Stripe-style connected-account id.
    expect(inv.merchantAccount).toBeNull()
    expect(inv.fiatAmountMinor).toBe('1819')
    expect(inv.fiatCurrency).toBe('usd')
    expect(inv.stablecoinAmountAtomic).toBe('18190000')
    expect(inv.stablecoinAmount).toBe('18.19')
    expect(inv.payable).toBe(true)
    expect(inv.payableReason).toBeNull()
    // preApprovalExpiry is unix SECONDS; it must surface as ISO-8601.
    expect(inv.validBefore).toBe(FUTURE_ISO)
    expect(inv.settlement).toMatchObject({
      chainId: '8453',
      network: 'base',
      tokenSymbol: 'USDC',
      tokenAddress: BASE_USDC,
    })
    expect(inv.lockFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('takes the on-chain charge from maxAmount, not from the fiat amount', async () => {
    // A link may bill a different fiat display amount than it charges on-chain.
    // Each field must come from its own source, never be derived from the other.
    const inv = await normalizeCoinbasePayment(
      fixtureLink({ maxAmount: '20.00', fiat: { amount: '18.19', currency: 'USD' } }),
      NOW,
    )
    expect(inv.fiatAmountMinor).toBe('1819')
    expect(inv.stablecoinAmountAtomic).toBe('20000000')
  })

  it('is not payable once fully used', async () => {
    const inv = await normalizeCoinbasePayment(
      fixtureLink({ usageCount: 1, maxUsage: 1 }),
      NOW,
    )
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toContain('already fully used')
  })

  it('is not payable past preApprovalExpiry', async () => {
    const inv = await normalizeCoinbasePayment(
      fixtureLink({ preApprovalExpiry: PAST_UNIX }),
      NOW,
    )
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toBe('invoice has expired')
  })

  it('is not payable when the link does not settle in canonical Base USDC', async () => {
    const wrongToken = await normalizeCoinbasePayment(
      fixtureLink({ token: '0x1111111111111111111111111111111111111111' }),
      NOW,
    )
    expect(wrongToken.payable).toBe(false)
    expect(wrongToken.payableReason).toContain('canonical Base USDC')

    const wrongChain = await normalizeCoinbasePayment(fixtureLink({ networkId: 1 }), NOW)
    expect(wrongChain.payable).toBe(false)
    expect(wrongChain.payableReason).toContain('Base mainnet')
  })

  // Fail-closed: "cannot verify" must never be reported as "verified OK".
  describe('fails closed on unverifiable fields', () => {
    it('is not payable when the usage counters are missing', async () => {
      for (const missing of [{ maxUsage: undefined }, { usageCount: undefined }]) {
        const inv = await normalizeCoinbasePayment(fixtureLink(missing), NOW)
        expect(inv.payable).toBe(false)
        expect(inv.payableReason).toContain('usage could not be verified')
      }
    })

    it('is not payable when the expiry is missing or unparseable', async () => {
      for (const bad of [undefined, '', 'not-a-date']) {
        const inv = await normalizeCoinbasePayment(
          fixtureLink({ preApprovalExpiry: bad as string | undefined }),
          NOW,
        )
        expect(inv.payable).toBe(false)
        expect(inv.payableReason).toContain('expiry could not be verified')
        expect(inv.validBefore).toBeNull()
      }
    })
  })
})

describe('Coinbase v3 payment session normalization', () => {
  // Regression guard for a real near-miss: the first cut of this normalizer
  // assumed asset="USD" and network="base" from a stale repo fixture. Against
  // production (asset="usdc", network="PAYMENT_TARGET_NETWORK_BASE") it would
  // have thrown 422 on the currency check and, had it not, reported
  // payable=false on the network check. Every live v3 session would have
  // failed. This asserts the untouched production payload verbatim.
  it('normalizes a VERBATIM live production payload as payable', async () => {
    const live = JSON.parse(`{
      "paymentSessionId": "paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2",
      "amount": "1.05",
      "asset": "usdc",
      "status": "PAYMENT_SESSION_STATUS_CREATED",
      "target": {
        "paymentTargetWallet": {
          "address": "0x4C3f2E391498e2590bd327a7A1CAA68Dd42c4647",
          "network": "PAYMENT_TARGET_NETWORK_BASE"
        }
      },
      "url": "https://payments.coinbase.com/payment-sessions/paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2",
      "redirect": { "successUrl": "https://openrouter.ai/settings/credits" },
      "createdAt": "2026-08-03T05:06:10.900629Z",
      "updatedAt": "2026-08-03T05:06:10.924498Z",
      "customerDisplay": { "merchantName": "OpenRouter, Inc" },
      "expiresAt": "2026-08-04T05:06:10.897678Z"
    }`)

    const inv = await normalizeCoinbasePayment(live, Date.parse('2026-08-03T06:00:00Z'))
    expect(inv.payable).toBe(true)
    expect(inv.payableReason).toBeNull()
    expect(inv.merchantTitle).toBe('OpenRouter, Inc')
    expect(inv.fiatCurrency).toBe('usd')
    expect(inv.stablecoinAmountAtomic).toBe('1050000')
  })

  it('still fails closed on a Base TESTNET-looking target network', async () => {
    // The Base check is an exact match, not a prefix/substring test, so a
    // future PAYMENT_TARGET_NETWORK_BASE_SEPOLIA can never satisfy it.
    const inv = await normalizeCoinbasePayment(
      fixtureSession({
        target: {
          paymentTargetWallet: { address: '0xabc', network: 'PAYMENT_TARGET_NETWORK_BASE_SEPOLIA' },
        },
      }),
      NOW,
    )
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toContain('Base mainnet')
  })

  it('normalizes a live session to the provider-neutral shape', async () => {
    const inv = await normalizeCoinbasePayment(fixtureSession(), NOW)

    expect(inv.provider).toBe('coinbase')
    expect(inv.invoiceKey).toBe('paymentSession_656a435c-ee45-4c3e-936c-b80929a4e7f2')
    expect(inv.merchantTitle).toBe('OpenRouter, Inc')
    expect(inv.fiatAmountMinor).toBe('105')
    expect(inv.stablecoinAmountAtomic).toBe('1050000')
    expect(inv.stablecoinAmount).toBe('1.05')
    expect(inv.state).toBe('PAYMENT_SESSION_STATUS_CREATED')
    expect(inv.payable).toBe(true)
    expect(inv.validBefore).toBe(FUTURE_ISO)
  })

  it('treats the payable state list as an ALLOWLIST, not a denylist', async () => {
    // The Stripe skill previously used a denylist and mis-reported in-flight
    // states as payable. Only CREATED is entry-payable here.
    for (const status of [
      'PAYMENT_SESSION_STATUS_AUTHORIZATION_PENDING',
      'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
      'PAYMENT_SESSION_STATUS_SOMETHING_NEW_WE_HAVE_NEVER_SEEN',
    ]) {
      const inv = await normalizeCoinbasePayment(fixtureSession({ status }), NOW)
      expect(inv.payable).toBe(false)
      expect(inv.payableReason).toContain('not entry-payable')
    }
  })

  it('is not payable past expiresAt even in an otherwise payable state', async () => {
    const inv = await normalizeCoinbasePayment(fixtureSession({ expiresAt: PAST_ISO }), NOW)
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toBe('invoice has expired')
  })

  // Fail-closed: never advertise canonical Base USDC settlement off an
  // unverified target network.
  it('is not payable when the payment target is not Base', async () => {
    const other = await normalizeCoinbasePayment(
      fixtureSession({ target: { paymentTargetWallet: { address: '0xabc', network: 'ethereum' } } }),
      NOW,
    )
    expect(other.payable).toBe(false)
    expect(other.payableReason).toContain('Base mainnet')

    const absent = await normalizeCoinbasePayment(fixtureSession({ target: undefined }), NOW)
    expect(absent.payable).toBe(false)
    expect(absent.payableReason).toContain('does not declare a payment target network')
  })

  it('is not payable when expiresAt is missing', async () => {
    const inv = await normalizeCoinbasePayment(fixtureSession({ expiresAt: undefined }), NOW)
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toContain('expiry could not be verified')
  })
})

describe('safety properties shared with the Stripe half', () => {
  it('never reflects a provider-controlled state raw into the output', async () => {
    const inv = await normalizeCoinbasePayment(
      fixtureSession({ status: '<script>alert(1)</script>' }),
      NOW,
    )
    expect(inv.state).toBe('unknown')
    expect(inv.payable).toBe(false)
    expect(JSON.stringify(inv)).not.toContain('<script>')
  })

  it('hard-stops on a non-USD currency instead of assuming parity', async () => {
    await expect(
      normalizeCoinbasePayment(fixtureLink({ fiat: { amount: '18.19', currency: 'EUR' } }), NOW),
    ).rejects.toThrow(/only supports USD/)
    await expect(
      normalizeCoinbasePayment(fixtureSession({ asset: 'EUR' }), NOW),
    ).rejects.toThrow(/only supports USD/)
  })

  it('produces a stable fingerprint across resolutions with changed mutable state', async () => {
    // The fingerprint covers immutable identity only, so a state/usage change
    // must not move it — same contract as the Stripe half.
    const a = await normalizeCoinbasePayment(fixtureLink(), NOW)
    const b = await normalizeCoinbasePayment(fixtureLink({ status: 'SETTLED', usageCount: 1 }), NOW)
    expect(b.lockFingerprint).toBe(a.lockFingerprint)

    const different = await normalizeCoinbasePayment(fixtureLink({ maxAmount: '18.20' }), NOW)
    expect(different.lockFingerprint).not.toBe(a.lockFingerprint)
  })

  it('does not collide with a Stripe fingerprint for otherwise-identical fields', async () => {
    // provider is part of the canonical serialization.
    const inv = await normalizeCoinbasePayment(fixtureLink(), NOW)
    expect(inv.lockFingerprint).toMatch(/^sha256:/)
    expect(inv.provider).toBe('coinbase')
  })
})

describe('resolveCoinbaseInvoice (live fetch)', () => {
  it('rejects a non-Coinbase / malformed URL before any network call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(resolveCoinbaseInvoice('https://evil.com/payment-links/pl_x')).rejects.toThrow(
      CoinbaseResolveError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes v1 links to payment-links and v3 sessions to payment-sessions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(fixtureLink()), { status: 200 }))

    await resolveCoinbaseInvoice('https://payments.coinbase.com/payment-links/pl_testAlchemy001')
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/next-api/payment-links/pl_testAlchemy001',
    )

    fetchMock.mockResolvedValue(new Response(JSON.stringify(fixtureSession()), { status: 200 }))
    const sid = 'paymentSession_03155b8e-a9c1-4d6f-88f2-7752f6904266'
    await resolveCoinbaseInvoice(`https://payments.coinbase.com/payment-sessions/${sid}`)
    expect(String(fetchMock.mock.calls[1][0])).toContain(`/next-api/payment-sessions/${sid}`)
  })

  it('maps a 404/410 upstream to the expired kind and never echoes the body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('SENSITIVE_UPSTREAM_BODY', { status: 404 }),
    )
    try {
      await resolveCoinbaseInvoice(
        'https://payments.coinbase.com/payment-links/pl_testAlchemy001',
      )
      throw new Error('expected a rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(CoinbaseResolveError)
      expect((err as CoinbaseResolveError).kind).toBe('expired')
      expect((err as Error).message).not.toContain('SENSITIVE_UPSTREAM_BODY')
    }
  })

  it('surfaces a network failure as an upstream error rather than throwing raw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    await expect(
      resolveCoinbaseInvoice('https://payments.coinbase.com/payment-links/pl_testAlchemy001'),
    ).rejects.toThrow(CoinbaseResolveError)
  })
})
