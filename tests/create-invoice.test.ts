import { describe, it, expect } from 'vitest'
import {
  computeCallerPaysAtomic,
  parseUsdc,
  formatUsdc,
  formatTitleAmount,
  buildTitle,
  resolveSource,
} from '../src/routes/create-invoice'

describe('parseUsdc', () => {
  it('parses integer dollars', () => {
    expect(parseUsdc('105')).toBe(105_000_000n)
  })

  it('parses .00 suffix', () => {
    expect(parseUsdc('10.00')).toBe(10_000_000n)
  })

  it('parses 2-decimal cents', () => {
    expect(parseUsdc('9.52')).toBe(9_520_000n)
  })

  it('parses full 6-decimal precision', () => {
    expect(parseUsdc('9.523809')).toBe(9_523_809n)
  })

  it('truncates beyond 6 decimals', () => {
    expect(parseUsdc('1.1234567')).toBe(1_123_456n)
  })

  it('rejects garbage', () => {
    expect(() => parseUsdc('abc')).toThrow()
  })
})

describe('formatUsdc', () => {
  it('strips trailing zeros', () => {
    expect(formatUsdc(100_000_000n)).toBe('100')
    expect(formatUsdc(10_000_000n)).toBe('10')
  })

  it('keeps non-zero fraction', () => {
    expect(formatUsdc(9_520_000n)).toBe('9.52')
    expect(formatUsdc(9_523_809n)).toBe('9.523809')
  })
})

describe('formatTitleAmount', () => {
  it('renders integers without decimal', () => {
    expect(formatTitleAmount(100_000_000n)).toBe('$100')
    expect(formatTitleAmount(5_000_000n)).toBe('$5')
  })

  it('renders non-integers with 2 decimals (truncated)', () => {
    expect(formatTitleAmount(9_520_000n)).toBe('$9.52')
    expect(formatTitleAmount(9_523_809n)).toBe('$9.52') // truncate, not round
  })

  it('handles $0.48 case', () => {
    expect(formatTitleAmount(480_000n)).toBe('$0.48')
  })
})

describe('computeCallerPaysAtomic — reference cases', () => {
  // Each row: invoice (USD) → expected callerPays (USD), expected discount (USD)
  const cases: Array<[string, string, string]> = [
    // small invoice: ratio (×100/105) wins over (invoice - 5)
    ['10', '9.523809', '0.476191'],
    ['50', '47.619047', '2.380953'],
    // breakeven: both formulas give the same answer
    ['105', '100', '5'],
    // large invoice: (invoice - 5) wins; discount capped at exactly $5
    ['210', '205', '5'],
    ['1000', '995', '5'],
  ]

  for (const [invoiceStr, expectedPaysStr, expectedDiscountStr] of cases) {
    it(`$${invoiceStr} → caller pays $${expectedPaysStr} (discount $${expectedDiscountStr})`, () => {
      const invoice = parseUsdc(invoiceStr)
      const pays = computeCallerPaysAtomic(invoice)
      const discount = invoice - pays
      expect(formatUsdc(pays)).toBe(expectedPaysStr)
      expect(formatUsdc(discount)).toBe(expectedDiscountStr)
      // Hard invariant: discount must never exceed $5.
      expect(discount).toBeLessThanOrEqual(5_000_000n)
    })
  }

  it('handles tiny invoices (under $5) without going negative', () => {
    // For $1 invoice: (invoice - 5) would be negative, so we clamp to 0
    // and use the ratio: 1 × 100 / 105 = 0.952380
    const invoice = parseUsdc('1')
    const pays = computeCallerPaysAtomic(invoice)
    expect(pays).toBeGreaterThan(0n)
    expect(pays).toBeLessThanOrEqual(invoice)
    // 1 × 1_000_000 × 100 / 105 = 952_380 atomic → formatUsdc strips
    // the trailing zero and returns "0.95238".
    expect(pays).toBe(952_380n)
    expect(formatUsdc(pays)).toBe('0.95238')
  })
})

describe('buildTitle', () => {
  it('formats the OpenRouter $105 → $100 example', () => {
    const title = buildTitle('OpenRouter, Inc.', parseUsdc('105'), parseUsdc('100'))
    expect(title).toBe('Pay OpenRouter, Inc. $100 (originally $105, $5 Discount)')
  })

  it('formats a small invoice with non-integer callerPays', () => {
    const invoice = parseUsdc('10')
    const pays = computeCallerPaysAtomic(invoice)
    const title = buildTitle('Acme', invoice, pays)
    // $10 - $9.523809 = $0.476191, displayed as $0.47 (truncated)
    expect(title).toBe('Pay Acme $9.52 (originally $10, $0.47 Discount)')
  })

  it('formats a large invoice with $5 cap', () => {
    const invoice = parseUsdc('210')
    const pays = computeCallerPaysAtomic(invoice)
    const title = buildTitle('OpenRouter, Inc.', invoice, pays)
    expect(title).toBe('Pay OpenRouter, Inc. $205 (originally $210, $5 Discount)')
  })
})

describe('resolveSource', () => {
  it('defaults to Base USDC when no source given', () => {
    const r = resolveSource(undefined)
    expect(r.error).toBeUndefined()
    expect(r.resolved).toEqual({
      chainId: '8453',
      tokenSymbol: 'USDC',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      warnings: [],
    })
  })

  it('defaults to Base USDC when source is null', () => {
    const r = resolveSource(null)
    expect(r.resolved?.chainId).toBe('8453')
  })

  it('resolves Stellar USDC and injects the canonical issuer', () => {
    const r = resolveSource({ chainId: 1500, tokenSymbol: 'USDC' })
    expect(r.error).toBeUndefined()
    expect(r.resolved?.chainId).toBe('1500')
    expect(r.resolved?.tokenSymbol).toBe('USDC')
    expect(r.resolved?.tokenAddress).toBe(
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    )
    expect(r.resolved?.warnings).toEqual([])
  })

  it('accepts chainId as a string', () => {
    const r = resolveSource({ chainId: '1500', tokenSymbol: 'USDC' })
    expect(r.resolved?.chainId).toBe('1500')
  })

  it('uppercases tokenSymbol', () => {
    const r = resolveSource({ chainId: 1, tokenSymbol: 'usdt' })
    expect(r.resolved?.tokenSymbol).toBe('USDT')
    expect(r.resolved?.tokenAddress).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7')
  })

  it('resolves Ethereum USDC and USDT to correct contracts', () => {
    expect(resolveSource({ chainId: 1, tokenSymbol: 'USDC' }).resolved?.tokenAddress).toBe(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    )
    expect(resolveSource({ chainId: 1, tokenSymbol: 'USDT' }).resolved?.tokenAddress).toBe(
      '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    )
  })

  it('ignores caller-supplied tokenAddress and warns', () => {
    const r = resolveSource({
      chainId: 1500,
      tokenSymbol: 'USDC',
      tokenAddress: 'USDC:GBADTESTNETWRONGISSUERABCDEFGHIJKLMNOPQR',
    })
    expect(r.resolved?.tokenAddress).toBe(
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    )
    expect(r.resolved?.warnings).toHaveLength(1)
    expect(r.resolved?.warnings[0]).toMatch(/ignored/i)
    expect(r.resolved?.warnings[0]).toMatch(/tokenAddress/)
  })

  it('rejects unsupported chainId', () => {
    const r = resolveSource({ chainId: 42, tokenSymbol: 'USDC' })
    expect(r.resolved).toBeUndefined()
    expect(r.error?.code).toBe('UNSUPPORTED_SOURCE')
    expect(r.error?.message).toMatch(/42/)
    expect(r.error?.supported).toBeDefined()
  })

  it('rejects USDT on Base (whitelist enforced)', () => {
    const r = resolveSource({ chainId: 8453, tokenSymbol: 'USDT' })
    expect(r.error?.code).toBe('UNSUPPORTED_SOURCE')
    expect(r.error?.message).toMatch(/USDT/)
    expect(r.error?.message).toMatch(/8453/)
  })

  it('rejects USDT on Stellar (only USDC supported there)', () => {
    const r = resolveSource({ chainId: 1500, tokenSymbol: 'USDT' })
    expect(r.error?.code).toBe('UNSUPPORTED_SOURCE')
  })

  it('rejects EURC (intentionally not in whitelist)', () => {
    const r = resolveSource({ chainId: 1, tokenSymbol: 'EURC' })
    expect(r.error?.code).toBe('UNSUPPORTED_SOURCE')
  })

  it('rejects missing chainId', () => {
    const r = resolveSource({ tokenSymbol: 'USDC' })
    expect(r.error?.code).toBe('INVALID_SOURCE')
    expect(r.error?.message).toMatch(/chainId/)
  })

  it('rejects missing tokenSymbol', () => {
    const r = resolveSource({ chainId: 1500 })
    expect(r.error?.code).toBe('INVALID_SOURCE')
    expect(r.error?.message).toMatch(/tokenSymbol/)
  })

  it('rejects non-object source', () => {
    const r = resolveSource('stellar')
    expect(r.error?.code).toBe('INVALID_SOURCE')
  })
})

// ── P0-1: Stripe rejection must NEVER echo the URL or /pay/<blob> ────────────
// The 501 returned for a Stripe crypto URL must not include normalized_input,
// the raw URL, or the replayable session blob. Regression test for the
// codex-flagged session-hash leak.
describe('handleCreateInvoice — Stripe URL rejection (P0-1)', () => {
  const STRIPE_URL =
    'https://crypto.stripe.com/pay/CDMSuperSecretReplayableBlob_ABC123xyz'

  function makeEnv() {
    return {
      PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
      ROZO_INTENTS_API_KEY: 'test-key',
    } as unknown as import('../src/index').Env
  }

  async function callWith(url: string) {
    const { handleCreateInvoice } = await import('../src/routes/create-invoice')
    const req = new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const res = await handleCreateInvoice(req, makeEnv())
    const body = await res.text()
    return { status: res.status, body }
  }

  it('returns 501 for a Stripe URL without leaking the URL or blob', async () => {
    const { status, body } = await callWith(STRIPE_URL)
    expect(status).toBe(501)
    // The full URL, the /pay/ path, and the opaque blob must all be absent.
    expect(body).not.toContain('crypto.stripe.com')
    expect(body).not.toContain('CDMSuperSecretReplayableBlob_ABC123xyz')
    expect(body).not.toContain('/pay/')
    expect(body).not.toContain('normalized_input')
    // It should still be a helpful, provider-tagged response.
    const json = JSON.parse(body)
    expect(json.provider).toBe('stripe_crypto')
    expect(json.code).toBe('QUOTE_FETCH_FAILED')
  })
})
