/**
 * NormalizedInvoice: Stripe session normalization, USD→USDC atomic conversion,
 * fingerprint determinism/mismatch, address masking, and secret-field
 * redaction (the normalized output must never carry secrets or full addresses).
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeStripeSession,
  fiatMinorToUsdcAtomic,
  formatUsdcAtomic,
  computeLockFingerprint,
  maskAddress,
  StripeResolveError,
  type StripePayinSession,
} from '../src/routes/invoice-provider'

// A representative live-checkout Stripe Payin Session (the Alchemy Insights
// fixture from the 2026-07-11 direct-skill E2E: $18.19, usdc.base).
function fixtureSession(overrides: Partial<StripePayinSession> = {}): StripePayinSession {
  return {
    id: 'cpis_testAlchemy001',
    object: 'crypto.payin_session',
    state: 'checkout',
    business_name: 'Alchemy Insights, Inc',
    merchant: 'acct_test123',
    livemode: true,
    payment_details: { amount: 1819, currency: 'usd' },
    // Secrets that MUST NOT leak into the normalized output:
    client_secret: 'cpis_secret_SHOULD_NOT_APPEAR',
    publishable_key: 'pk_live_SHOULD_NOT_APPEAR',
    spender_contract_addresses: { 'usdc.base': '0x1111111111111111111111111111111111111111' },
    active_wallet: { address: '0xABCDEF0123456789abcdef0123456789ABCDEF01', network: 'base' },
    supported_currencies: [
      {
        id: 'usdc.base',
        asset_code: 'usdc',
        chain_id: 8453,
        contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        currency_minor_units: 6,
        currency_network: 'base',
        mainnet: true,
        payment_options: ['wallet_connect', 'direct_deposit'],
      },
    ],
    valid_before: '2026-07-11T01:28:10.000Z',
    ...overrides,
  }
}

describe('fiatMinorToUsdcAtomic', () => {
  it('converts USD cents to USDC atomic (1 cent = 10_000 atomic)', () => {
    expect(fiatMinorToUsdcAtomic(1819n, 'usd')).toBe(18_190_000n)
    expect(fiatMinorToUsdcAtomic(1000n, 'usd')).toBe(10_000_000n)
    expect(fiatMinorToUsdcAtomic(1n, 'usd')).toBe(10_000n)
  })

  it('is case-insensitive on currency', () => {
    expect(fiatMinorToUsdcAtomic(500n, 'USD')).toBe(5_000_000n)
  })

  it('throws for a non-USD currency (never assume parity)', () => {
    expect(() => fiatMinorToUsdcAtomic(1000n, 'eur')).toThrow()
    expect(() => fiatMinorToUsdcAtomic(1000n, 'gbp')).toThrow()
  })
})

describe('formatUsdcAtomic', () => {
  it('formats whole amounts without decimals', () => {
    expect(formatUsdcAtomic(10_000_000n)).toBe('10')
  })
  it('formats fractional amounts, trimming trailing zeros', () => {
    expect(formatUsdcAtomic(18_190_000n)).toBe('18.19')
    expect(formatUsdcAtomic(9_523_809n)).toBe('9.523809')
  })
})

describe('computeLockFingerprint', () => {
  const base = {
    provider: 'stripe_crypto',
    invoiceKey: 'cpis_testAlchemy001',
    merchantAccount: 'acct_test123',
    fiatAmountMinor: '1819',
    fiatCurrency: 'usd',
    stablecoinAmountAtomic: '18190000',
    settlementChainId: '8453',
    settlementTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  }

  it('is deterministic (same inputs → same fingerprint)', async () => {
    const a = await computeLockFingerprint(base)
    const b = await computeLockFingerprint({ ...base })
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes when amount changes (mismatch detection)', async () => {
    const a = await computeLockFingerprint(base)
    const b = await computeLockFingerprint({ ...base, fiatAmountMinor: '1820' })
    expect(a).not.toBe(b)
  })

  it('changes when merchant account changes', async () => {
    const a = await computeLockFingerprint(base)
    const b = await computeLockFingerprint({ ...base, merchantAccount: 'acct_other' })
    expect(a).not.toBe(b)
  })

  it('is stable across settlement token address casing', async () => {
    const a = await computeLockFingerprint(base)
    const b = await computeLockFingerprint({
      ...base,
      settlementTokenAddress: base.settlementTokenAddress.toUpperCase(),
    })
    expect(a).toBe(b)
  })
})

describe('maskAddress', () => {
  it('masks an EVM address to first-6 + last-4', () => {
    expect(maskAddress('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toBe('0xABCD…EF01')
  })
  it('returns null for null/empty', () => {
    expect(maskAddress(null)).toBeNull()
    expect(maskAddress(undefined)).toBeNull()
    expect(maskAddress('   ')).toBeNull()
  })
  it('never returns a full address for short inputs — fully redacts to "…" (P2-1)', () => {
    // <=10 chars would reveal the whole value under first-6+last-4, so redact.
    expect(maskAddress('0x1234')).toBe('…')
    expect(maskAddress('short')).toBe('…')
    expect(maskAddress('0x12345678')).toBe('…') // exactly 10 chars
    // The masked form must never equal or contain the raw short input.
    expect(maskAddress('0x1234')).not.toContain('1234')
  })
})

describe('normalizeStripeSession', () => {
  it('normalizes an Alchemy usd/usdc.base session correctly', async () => {
    const inv = await normalizeStripeSession(fixtureSession())
    expect(inv.provider).toBe('stripe_crypto')
    expect(inv.invoiceKey).toBe('cpis_testAlchemy001')
    expect(inv.merchantTitle).toBe('Alchemy Insights, Inc')
    expect(inv.merchantAccount).toBe('acct_test123')
    expect(inv.fiatAmountMinor).toBe('1819')
    expect(inv.fiatCurrency).toBe('usd')
    expect(inv.stablecoinAmountAtomic).toBe('18190000')
    expect(inv.stablecoinAmount).toBe('18.19')
    expect(inv.state).toBe('checkout')
    expect(inv.payable).toBe(true)
    expect(inv.payableReason).toBeNull()
    expect(inv.validBefore).toBe('2026-07-11T01:28:10.000Z')
    expect(inv.settlement.chainId).toBe('8453')
    expect(inv.settlement.tokenSymbol).toBe('USDC')
    expect(inv.lockFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('marks payable=false when usdc.base offer lacks wallet_connect', async () => {
    const inv = await normalizeStripeSession(
      fixtureSession({
        supported_currencies: [
          {
            id: 'usdc.base',
            asset_code: 'usdc',
            chain_id: 8453,
            contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            currency_network: 'base',
            payment_options: ['direct_deposit'], // no wallet_connect
          },
        ],
      }),
    )
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toContain('wallet_connect')
  })

  it('marks payable=false when no usdc.base offer', async () => {
    const inv = await normalizeStripeSession(
      fixtureSession({ supported_currencies: [] }),
    )
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toContain('usdc.base')
  })

  it('marks payable=false for a non-entry state (processing)', async () => {
    const inv = await normalizeStripeSession(fixtureSession({ state: 'processing' }))
    expect(inv.payable).toBe(false)
    expect(inv.payableReason).toContain('processing')
  })

  it('throws unsupported for a non-USD currency', async () => {
    await expect(
      normalizeStripeSession(fixtureSession({ payment_details: { amount: 1000, currency: 'eur' } })),
    ).rejects.toBeInstanceOf(StripeResolveError)
  })

  // P1-2: amount must be a non-negative safe integer — never silently rounded.
  describe('amount validation (P1-2)', () => {
    it('throws for a negative amount', async () => {
      await expect(
        normalizeStripeSession(fixtureSession({ payment_details: { amount: -100, currency: 'usd' } })),
      ).rejects.toBeInstanceOf(StripeResolveError)
    })
    it('throws for a fractional amount (no silent round)', async () => {
      await expect(
        normalizeStripeSession(fixtureSession({ payment_details: { amount: 18.7, currency: 'usd' } })),
      ).rejects.toBeInstanceOf(StripeResolveError)
    })
    it('throws for a non-safe-integer amount', async () => {
      await expect(
        normalizeStripeSession(
          fixtureSession({ payment_details: { amount: Number.MAX_SAFE_INTEGER + 2, currency: 'usd' } }),
        ),
      ).rejects.toBeInstanceOf(StripeResolveError)
    })
    it('accepts a zero amount', async () => {
      const inv = await normalizeStripeSession(
        fixtureSession({ payment_details: { amount: 0, currency: 'usd' } }),
      )
      expect(inv.fiatAmountMinor).toBe('0')
      expect(inv.stablecoinAmountAtomic).toBe('0')
    })
  })

  // P1-3: usdc.base offer must be canonical Base mainnet USDC, not a look-alike.
  describe('strict usdc.base validation (P1-3)', () => {
    it('rejects a wrong chain_id (not payable, does not claim canonical settlement)', async () => {
      const inv = await normalizeStripeSession(
        fixtureSession({
          supported_currencies: [
            {
              id: 'usdc.base',
              asset_code: 'usdc',
              chain_id: 1, // wrong chain
              contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              currency_network: 'base',
              mainnet: true,
              payment_options: ['wallet_connect'],
            },
          ],
        }),
      )
      expect(inv.payable).toBe(false)
      expect(inv.payableReason).toContain('usdc.base')
    })
    it('rejects a wrong contract address', async () => {
      const inv = await normalizeStripeSession(
        fixtureSession({
          supported_currencies: [
            {
              id: 'usdc.base',
              asset_code: 'usdc',
              chain_id: 8453,
              contract_address: '0xdeadbeef00000000000000000000000000000000', // spoofed token
              currency_network: 'base',
              mainnet: true,
              payment_options: ['wallet_connect'],
            },
          ],
        }),
      )
      expect(inv.payable).toBe(false)
    })
    it('rejects mainnet=false', async () => {
      const inv = await normalizeStripeSession(
        fixtureSession({
          supported_currencies: [
            {
              id: 'usdc.base',
              asset_code: 'usdc',
              chain_id: 8453,
              contract_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              currency_network: 'base',
              mainnet: false, // testnet
              payment_options: ['wallet_connect'],
            },
          ],
        }),
      )
      expect(inv.payable).toBe(false)
    })
  })

  // P1-4: provider-controlled state is never reflected raw into a caller string.
  describe('state sanitization (P1-4)', () => {
    it('collapses an unknown/malicious state to "unknown"', async () => {
      const inv = await normalizeStripeSession(
        fixtureSession({ state: '<script>alert(1)</script>' }),
      )
      expect(inv.state).toBe('unknown')
      expect(inv.payable).toBe(false)
      // The raw injected string must not be reflected anywhere in the output.
      expect(JSON.stringify(inv)).not.toContain('<script>')
      expect(inv.payableReason).toContain('unknown')
    })
  })

  it('NEVER leaks secrets or full wallet addresses in the serialized output', async () => {
    const inv = await normalizeStripeSession(fixtureSession())
    const serialized = JSON.stringify(inv)
    expect(serialized).not.toContain('SHOULD_NOT_APPEAR')
    expect(serialized).not.toContain('pk_live_')
    expect(serialized).not.toContain('client_secret')
    // full active_wallet address must not appear (only its masked form)
    expect(serialized).not.toContain('0xABCDEF0123456789abcdef0123456789ABCDEF01')
    // masked form is present in transaction
    expect(serialized).toContain('0xABCD…EF01')
  })

  it('masks the active wallet address in transaction details', async () => {
    const inv = await normalizeStripeSession(fixtureSession())
    expect(inv.transaction?.walletAddressMasked).toBe('0xABCD…EF01')
  })
})
