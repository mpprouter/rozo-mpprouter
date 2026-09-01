import { describe, it, expect } from 'vitest'
import {
  computeCallerPaysAtomic,
  parseUsdc,
  formatUsdc,
  formatTitleAmount,
  buildTitle,
  buildFullAmountTitle,
  resolveSource,
  resolveClient,
  buildCheckoutTitle,
} from '../src/routes/create-invoice'
import {
  createQuoteReceipt,
  verifyQuoteReceipt,
} from '../src/routes/quote-receipt'
import {
  computeServiceFeeAtomic,
  isExactCheckoutWebClient,
  parseCheckoutWebFeeBps,
  resolveCheckoutPricing,
} from '../src/routes/checkout-web-pricing'

describe('quote receipt', () => {
  it('round-trips a signed quote and binds it to the payment id', async () => {
    const receipt = await createQuoteReceipt(
      'pl_test123',
      '105',
      'OpenRouter, Inc.',
      'test-secret',
      1_000,
    )
    await expect(
      verifyQuoteReceipt(receipt, 'pl_test123', 'test-secret', 1_001),
    ).resolves.toMatchObject({
      paymentId: 'pl_test123',
      amount: '105',
      merchant: 'OpenRouter, Inc.',
    })
    await expect(
      verifyQuoteReceipt(receipt, 'pl_other', 'test-secret', 1_001),
    ).resolves.toBeNull()
  })

  it('rejects tampered and expired receipts', async () => {
    const receipt = await createQuoteReceipt(
      'pl_test123',
      '105',
      'OpenRouter, Inc.',
      'test-secret',
      1_000,
    )
    await expect(
      verifyQuoteReceipt(`${receipt}x`, 'pl_test123', 'test-secret', 1_001),
    ).resolves.toBeNull()
    await expect(
      verifyQuoteReceipt(receipt, 'pl_test123', 'test-secret', 1_061),
    ).resolves.toBeNull()
  })

  it('rejects a signed v2 receipt above the code-level 100 bps ceiling', async () => {
    const receipt = await createQuoteReceipt(
      'pl_test123',
      '10',
      'OpenRouter, Inc.',
      'test-secret',
      1_000,
      {
        original: '10',
        serviceFee: '0.101',
        callerPays: '10.101',
        feeBps: 101,
        pricingVersion: 'checkout-web-fee-v1',
        client: 'rozo-checkout-web',
      },
    )
    await expect(
      verifyQuoteReceipt(receipt, 'pl_test123', 'test-secret', 1_001),
    ).resolves.toBeNull()
  })

  it('is issued by quote-invoice and can be verified against its link id', async () => {
    const { handleQuoteInvoice } = await import('../src/routes/pay-invoice-admin')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          linkId: 'paymentSession_test123',
          merchant: 'OpenRouter, Inc.',
          invoice: { amount: '1.05' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    try {
      const response = await handleQuoteInvoice(
        new Request('https://mpp.test/quote-invoice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payment_id: 'paymentSession_test123' }),
        }),
        { PAYINVOICE_ADMIN_SECRET: 'test-secret' } as import('../src/index').Env,
      )
      const body = await response.json() as any
      expect(response.status).toBe(200)
      expect(body.quoteReceipt).toEqual(expect.any(String))
      await expect(
        verifyQuoteReceipt(
          body.quoteReceipt,
          'paymentSession_test123',
          'test-secret',
        ),
      ).resolves.toMatchObject({ amount: '1.05', merchant: 'OpenRouter, Inc.' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('binds the browser fee snapshot and returns the same priced quote', async () => {
    const { handleQuoteInvoice } = await import('../src/routes/pay-invoice-admin')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({
        linkId: 'pl_fee_quote',
        merchant: 'OpenRouter, Inc.',
        invoice: { amount: '10.01' },
      })) as typeof fetch
    try {
      const response = await handleQuoteInvoice(
        new Request('https://mpp.test/quote-invoice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            payment_id: 'pl_fee_quote',
            client: 'rozo-checkout-web',
          }),
        }),
        {
          PAYINVOICE_ADMIN_SECRET: 'test-secret',
          CHECKOUT_WEB_FEE_BPS: '100',
        } as import('../src/index').Env,
      )
      const body = await response.json() as any
      expect(body).toMatchObject({
        original: '10.01',
        serviceFee: '0.11',
        callerPays: '10.12',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
      })
      expect(body.quote.callerPaysAtomicUsdc).toBe('10120000')
      await expect(
        verifyQuoteReceipt(body.quoteReceipt, 'pl_fee_quote', 'test-secret'),
      ).resolves.toMatchObject({
        v: 2,
        client: 'rozo-checkout-web',
        original: '10.01',
        serviceFee: '0.11',
        callerPays: '10.12',
        feeBps: 100,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('binds quote receipts to raw fee eligibility, not sanitized provenance', async () => {
    const { handleQuoteInvoice } = await import('../src/routes/pay-invoice-admin')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({
      linkId: 'pl_fee_quote',
      merchant: 'OpenRouter, Inc.',
      invoice: { amount: '10' },
    })) as typeof fetch
    try {
      const response = await handleQuoteInvoice(
        new Request('https://mpp.test/quote-invoice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            payment_id: 'pl_fee_quote',
            client: 'rozo-checkout-web!!!',
          }),
        }),
        {
          PAYINVOICE_ADMIN_SECRET: 'test-secret',
          CHECKOUT_WEB_FEE_BPS: '100',
        } as import('../src/index').Env,
      )
      const body = await response.json() as any
      expect(body.feeBps).toBe(0)
      await expect(
        verifyQuoteReceipt(body.quoteReceipt, 'pl_fee_quote', 'test-secret'),
      ).resolves.toMatchObject({ client: null, feeBps: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('browser checkout fee policy', () => {
  it('requires byte-for-byte exact browser client provenance', () => {
    expect(isExactCheckoutWebClient('rozo-checkout-web')).toBe(true)
    for (const raw of [
      ' rozo-checkout-web',
      'rozo-checkout-web ',
      'ROZO-CHECKOUT-WEB',
      'rozo-checkout-Web',
      'rozo-checkout-web!!!',
      'rozo-checkout-web/1.0',
      null,
      undefined,
    ]) {
      expect(isExactCheckoutWebClient(raw)).toBe(false)
    }
  })

  it('rounds a non-divisible 1% fee up to the next whole cent', () => {
    // $10.000001 -> 10.000001 cents -> 11 cents
    expect(computeServiceFeeAtomic(10_000_001n, 100)).toBe(110_000n)
    // dust still pays the 1-cent floor
    expect(computeServiceFeeAtomic(1n, 100)).toBe(10_000n)
    // $1.05 -> $0.0105 -> $0.02, so the user sees $1.07, never $1.0605
    expect(computeServiceFeeAtomic(1_050_000n, 100)).toBe(20_000n)
    // exact cents stay exact: $10 -> $0.10
    expect(computeServiceFeeAtomic(10_000_000n, 100)).toBe(100_000n)
  })

  it('defaults malformed, fractional, negative, and above-canary config to 0', () => {
    for (const raw of [undefined, '', '1.5', '-1', '101', '10000', 'abc']) {
      expect(parseCheckoutWebFeeBps(raw)).toBe(0)
    }
    expect(parseCheckoutWebFeeBps('100')).toBe(100)
  })

  it('hard-caps fee math at the approved 1% canary boundary', () => {
    expect(() => computeServiceFeeAtomic(10_000_000n, 101)).toThrow()
  })

  it('only prices the exact web client and strict OpenRouter allowlist', () => {
    const eligible = resolveCheckoutPricing(
      10_000_000n,
      'OpenRouter, Inc.',
      'rozo-checkout-web',
      '100',
    )
    expect(eligible.serviceFeeAtomic).toBe(100_000n)
    expect(eligible.callerPaysAtomic).toBe(10_100_000n)
    for (const [merchant, client] of [
      ['OpenRouter, Inc.', null],
      ['OpenRouter, Inc.', 'rozo-checkout-cli/1.0'],
      ['OpenRouter, Inc.', 'rozo-checkout-web!!!'],
      ['OpenRouter Support', 'rozo-checkout-web'],
      ['openrouter', 'rozo-checkout-web'],
    ] as const) {
      expect(resolveCheckoutPricing(10_000_000n, merchant, client, '100').feeBps).toBe(0)
    }
  })

  it('makes the charged total explicit in the display title', () => {
    const pricing = resolveCheckoutPricing(
      10_000_000n,
      'OpenRouter',
      'rozo-checkout-web',
      '100',
    )
    expect(buildCheckoutTitle('OpenRouter', pricing)).toBe(
      'Pay OpenRouter $10.10 (includes $0.10 service fee)',
    )

    const subCent = resolveCheckoutPricing(
      10_010_000n,
      'OpenRouter',
      'rozo-checkout-web',
      '100',
    )
    expect(buildCheckoutTitle('OpenRouter', subCent)).toBe(
      'Pay OpenRouter $10.12 (includes $0.11 service fee)',
    )
  })
})

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

describe('buildFullAmountTitle (OpenRouter line — no discount)', () => {
  it('renders the full invoice amount with no discount clause', () => {
    expect(buildFullAmountTitle('OpenRouter, Inc.', parseUsdc('105'))).toBe(
      'Pay OpenRouter, Inc. $105',
    )
  })
  it('renders non-integer amounts to 2 decimals', () => {
    expect(buildFullAmountTitle('Acme', parseUsdc('9.52'))).toBe('Pay Acme $9.52')
  })
  it('has no "originally" / "Discount" text', () => {
    const t = buildFullAmountTitle('OpenRouter, Inc.', parseUsdc('210'))
    expect(t).not.toMatch(/originally/i)
    expect(t).not.toMatch(/discount/i)
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

  it('resolves Lightning BTC (empty tokenAddress, no chain contract)', () => {
    const r = resolveSource({ chainId: 'lightning', tokenSymbol: 'BTC' })
    expect(r.error).toBeUndefined()
    expect(r.resolved).toEqual({
      chainId: 'lightning',
      tokenSymbol: 'BTC',
      tokenAddress: '',
      warnings: [],
    })
  })

  it('uppercases lightning tokenSymbol (btc → BTC)', () => {
    const r = resolveSource({ chainId: 'lightning', tokenSymbol: 'btc' })
    expect(r.resolved?.tokenSymbol).toBe('BTC')
  })

  it('rejects non-BTC token on lightning', () => {
    const r = resolveSource({ chainId: 'lightning', tokenSymbol: 'USDC' })
    expect(r.resolved).toBeUndefined()
    expect(r.error?.code).toBe('UNSUPPORTED_SOURCE')
    expect(r.error?.message).toMatch(/BTC/)
  })
})

// ── OpenRouter / Coinbase line: appId, no-discount, exactIn/exactOut split ───
// These drive handleCreateInvoice through the (non-Stripe) Coinbase path with a
// mocked quote-invoice upstream and a mocked Rozo intents API, then assert the
// intent-create body Rozo receives.
describe('handleCreateInvoice — OpenRouter/Coinbase line', () => {
  function makeEnv(feeBps?: string) {
    return {
      PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
      ROZO_INTENTS_API_KEY: 'test-key',
      CHECKOUT_WEB_FEE_BPS: feeBps,
    } as unknown as import('../src/index').Env
  }

  // Runs the handler with a body, capturing the JSON body POSTed to the Rozo
  // intents create endpoint. Quote upstream returns a fixed $105 OpenRouter
  // invoice; the order-lookup returns 404 (idempotency miss).
  async function run(
    body: Record<string, unknown>,
    feeBps?: string,
    merchant = 'OpenRouter, Inc.',
    quoteResponses: Response[] = [],
  ) {
    const { handleCreateInvoice } = await import('../src/routes/create-invoice')
    let createBody: any = null
    let quoteFetches = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('/quote-invoice')) {
        quoteFetches += 1
        const injected = quoteResponses.shift()
        if (injected) return injected
        return new Response(
          JSON.stringify({
            invoice: { amount: '105' },
            merchant,
            linkId: 'pl_test123',
          }),
          { status: 200 },
        )
      }
      if (u.includes('/payments/order/')) {
        return new Response('not found', { status: 404 }) // idempotency miss
      }
      // The create call is a POST to the payment-api root.
      if (u.includes('/payment-api')) {
        createBody = init?.body ? JSON.parse(init.body) : null
        return new Response(
          JSON.stringify({ id: 'rozo-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const req = new Request('https://mpp.test/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const res = await handleCreateInvoice(req, makeEnv(feeBps))
      const json = JSON.parse(await res.text())
      return { status: res.status, json, createBody, quoteFetches }
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  it('EVM default source → exactIn, appId=merchant_openrouter, full amount (no discount)', async () => {
    const { status, json, createBody } = await run({ payment_id: 'pl_test123' })
    expect(status).toBe(200)
    expect(createBody.appId).toBe('merchant_openrouter')
    expect(createBody.type).toBe('exactIn')
    // Full amount — NOT the discounted 100.
    expect(createBody.source.amount).toBe('105')
    expect(createBody.source.chainId).toBe('8453')
    expect(createBody.destination.amount).toBeUndefined()
    // Response reflects no discount.
    expect(json.callerPays).toBe('105')
    expect(json.discount).toBe('0')
    expect(json.title).toBe('Pay OpenRouter, Inc. $105')
  })

  it('retries a transient Coinbase session-readiness conflict before declaring the link expired', async () => {
    const transient = new Response(
      JSON.stringify({
        code: 'LINK_USED_OR_EXPIRED',
        message: 'Payment link has already been used or has expired.',
      }),
      { status: 409 },
    )
    const ready = new Response(
      JSON.stringify({
        invoice: { amount: '105' },
        merchant: 'OpenRouter, Inc.',
        linkId: 'paymentSession_test123',
      }),
      { status: 200 },
    )
    const { status, json, quoteFetches } = await run(
      { payment_id: 'paymentSession_test123' },
      undefined,
      'OpenRouter, Inc.',
      [transient, ready],
    )
    expect(status).toBe(200)
    expect(json.linkId).toBe('paymentSession_test123')
    expect(quoteFetches).toBe(2)
  })

  it('retries when LINK_USED_OR_EXPIRED is nested even if a different top-level code exists', async () => {
    const nestedConflict = new Response(
      JSON.stringify({
        code: 'UPSTREAM_ERROR',
        error: { code: 'LINK_USED_OR_EXPIRED' },
      }),
      { status: 409 },
    )
    const ready = new Response(
      JSON.stringify({
        invoice: { amount: '105' },
        merchant: 'OpenRouter, Inc.',
        linkId: 'paymentSession_test123',
      }),
      { status: 200 },
    )
    const { status, quoteFetches } = await run(
      { payment_id: 'paymentSession_test123' },
      undefined,
      'OpenRouter, Inc.',
      [nestedConflict, ready],
    )
    expect(status).toBe(200)
    expect(quoteFetches).toBe(2)
  })

  it('does not retry unrelated or malformed Coinbase 409 responses', async () => {
    for (const first of [
      new Response(JSON.stringify({ code: 'ORDER_ID_CONFLICT' }), { status: 409 }),
      new Response('not json', { status: 409 }),
      new Response('', { status: 409 }),
    ]) {
      const ready = new Response(
        JSON.stringify({ invoice: { amount: '105' }, merchant: 'OpenRouter, Inc.' }),
        { status: 200 },
      )
      const { status, quoteFetches } = await run(
        { payment_id: 'paymentSession_test123' },
        undefined,
        'OpenRouter, Inc.',
        [first, ready],
      )
      expect(status).toBe(409)
      expect(quoteFetches).toBe(1)
    }
  })

  it('does not retry generic-code conflicts that carry a definitive Coinbase state', async () => {
    for (const detail of [
      'payment session is not payable: PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
      'payment link is already fully used',
    ]) {
      const definitive = new Response(
        JSON.stringify({ code: 'LINK_USED_OR_EXPIRED', detail }),
        { status: 409 },
      )
      const ready = new Response(
        JSON.stringify({ invoice: { amount: '105' }, merchant: 'OpenRouter, Inc.' }),
        { status: 200 },
      )
      const { status, quoteFetches } = await run(
        { payment_id: 'paymentSession_test123' },
        undefined,
        'OpenRouter, Inc.',
        [definitive, ready],
      )
      expect(status).toBe(409)
      expect(quoteFetches).toBe(1)
    }
  })

  it('returns the second generic Coinbase conflict after exactly one retry', async () => {
    const conflict = () => new Response(
      JSON.stringify({ code: 'LINK_USED_OR_EXPIRED' }),
      { status: 409 },
    )
    const { status, json, quoteFetches } = await run(
      { payment_id: 'paymentSession_test123' },
      undefined,
      'OpenRouter, Inc.',
      [conflict(), conflict()],
    )
    expect(status).toBe(409)
    expect(json.code).toBe('LINK_USED_OR_EXPIRED')
    expect(quoteFetches).toBe(2)
  })

  it('Lightning source → exactOut, destination.amount full, source BTC no amount, appId=merchant_openrouter', async () => {
    const { status, createBody } = await run({
      payment_id: 'pl_test123',
      source: { chainId: 'lightning', tokenSymbol: 'BTC' },
    })
    expect(status).toBe(200)
    expect(createBody.appId).toBe('merchant_openrouter')
    expect(createBody.type).toBe('exactOut')
    expect(createBody.source).toEqual({ chainId: 'lightning', tokenSymbol: 'BTC' })
    expect(createBody.source.amount).toBeUndefined()
    expect(createBody.source.tokenAddress).toBeUndefined()
    // destination pins the full USDC the merchant receives.
    expect(createBody.destination.amount).toBe('105')
    expect(createBody.destination.chainId).toBe('8453')
    expect(createBody.destination.receiverAddress).toBe('0x2352Fa2970dBadD12d21808DB0F56CDEC8141739')
    expect(createBody.destination.tokenSymbol).toBe('USDC')
  })

  it('charges the same 1% browser fee on stablecoin and Lightning and persists its breakdown', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '105',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '105',
        serviceFee: '1.05',
        callerPays: '106.05',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
        client: 'rozo-checkout-web',
      },
    )
    for (const source of [
      undefined,
      { chainId: 'lightning', tokenSymbol: 'BTC' },
    ]) {
      const { status, json, createBody } = await run(
        {
          payment_id: 'pl_test123',
          client: 'rozo-checkout-web',
          quoteReceipt,
          ...(source ? { source } : {}),
        },
        '100',
      )
      expect(status).toBe(200)
      expect(json).toMatchObject({
        original: '105',
        serviceFee: '1.05',
        callerPays: '106.05',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
      })
      expect(createBody.type === 'exactOut'
        ? createBody.destination.amount
        : createBody.source.amount).toBe('106.05')
      expect(createBody.metadata).toMatchObject({
        client: 'rozo-checkout-web',
        original: '105',
        serviceFee: '1.05',
        callerPays: '106.05',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
      })
    }
  })

  it('refuses fee-bearing browser create without a v2 quote receipt', async () => {
    for (const source of [
      undefined,
      { chainId: 'lightning', tokenSymbol: 'BTC' },
    ]) {
      const { status, json, createBody } = await run(
        {
          payment_id: 'pl_test123',
          client: 'rozo-checkout-web',
          ...(source ? { source } : {}),
        },
        '100',
      )
      expect(status).toBe(409)
      expect(json.error.code).toBe('QUOTE_RECEIPT_REQUIRED')
      expect(createBody).toBeNull()
    }
  })

  it('keeps CLI/unknown clients and lookalike merchants at zero fee', async () => {
    const cli = await run(
      { payment_id: 'pl_test123', client: 'rozo-checkout-cli/1.0' },
      '100',
    )
    expect(cli.json.serviceFee).toBe('0')
    expect(cli.json.feeBps).toBe(0)

    const spoof = await run(
      { payment_id: 'pl_test123', client: 'rozo-checkout-web' },
      '100',
      'OpenRouter Support',
    )
    expect(spoof.json.serviceFee).toBe('0')
    expect(spoof.json.feeBps).toBe(0)

    const spoofClient = await run(
      { payment_id: 'pl_test123', client: 'rozo-checkout-web!!!' },
      '100',
    )
    expect(spoofClient.json.serviceFee).toBe('0')
    expect(spoofClient.json.feeBps).toBe(0)

    for (const client of [' rozo-checkout-web ', 'ROZO-CHECKOUT-WEB']) {
      const nonExact = await run({ payment_id: 'pl_test123', client }, '100')
      expect(nonExact.json.serviceFee).toBe('0')
      expect(nonExact.json.feeBps).toBe(0)
    }
  })

  it('uses a valid signed quote receipt without fetching the quote upstream again', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
    )
    const { status, createBody, quoteFetches } = await run({
      payment_id: 'pl_test123',
      quoteReceipt,
    })
    expect(status).toBe(200)
    expect(quoteFetches).toBe(0)
    expect(createBody.source.amount).toBe('77')
  })

  it('honors the exact signed v2 browser price across quote → create', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '77',
        serviceFee: '0.77',
        callerPays: '77.77',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
        client: 'rozo-checkout-web',
      },
    )
    // Even if the env changes during the receipt's 60-second TTL, the signed
    // snapshot is the price the browser was shown.
    const { status, json, createBody, quoteFetches } = await run({
      payment_id: 'pl_test123',
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '0')
    expect(status).toBe(200)
    expect(quoteFetches).toBe(0)
    expect(json.callerPays).toBe('77.77')
    expect(createBody.source.amount).toBe('77.77')
  })

  it('rejects a CLI receipt on the browser instead of silently repricing it', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '77',
        serviceFee: '0',
        callerPays: '77',
        feeBps: 0,
        pricingVersion: 'checkout-web-fee-v1',
        client: 'rozo-checkout-cli/1.0',
      },
    )
    const { status, json, createBody } = await run({
      payment_id: 'pl_test123',
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '100')
    expect(status).toBe(409)
    expect(json.error.code).toBe('QUOTE_RECEIPT_INVALID_OR_EXPIRED')
    expect(createBody).toBeNull()
  })

  it('keeps zero-fee legacy fallback for a tampered receipt', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
    )
    const { status, json, createBody, quoteFetches } = await run({
      payment_id: 'pl_test123',
      quoteReceipt: `${quoteReceipt}x`,
    })
    expect(status).toBe(200)
    expect(json.serviceFee).toBe('0')
    expect(quoteFetches).toBe(1)
    expect(createBody.source.amount).toBe('105')
  })

  it('keeps zero-fee legacy fallback for an expired receipt', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
      1_000,
    )
    const { status, json, createBody, quoteFetches } = await run({
      payment_id: 'pl_test123',
      quoteReceipt,
    })
    expect(status).toBe(200)
    expect(json.serviceFee).toBe('0')
    expect(quoteFetches).toBe(1)
    expect(createBody.source.amount).toBe('105')
  })

  it('rejects an invalid receipt once the browser fee is active', async () => {
    const { status, json, createBody } = await run({
      payment_id: 'pl_test123',
      client: 'rozo-checkout-web',
      quoteReceipt: 'tampered.receipt',
    }, '100')
    expect(status).toBe(409)
    expect(json.error.code).toBe('QUOTE_RECEIPT_INVALID_OR_EXPIRED')
    expect(createBody).toBeNull()
  })

  it('cannot replay a zero-fee sanitized-lookalike receipt as the exact browser client', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '105',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '105',
        serviceFee: '0',
        callerPays: '105',
        feeBps: 0,
        pricingVersion: 'checkout-web-fee-v1',
        client: null,
      },
    )
    const { status, json, createBody } = await run({
      payment_id: 'pl_test123',
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '100')
    expect(status).toBe(409)
    expect(json.error.code).toBe('QUOTE_RECEIPT_INVALID_OR_EXPIRED')
    expect(createBody).toBeNull()
  })

  it('ignores a client-mismatched receipt while pricing is disabled', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '77',
        serviceFee: '0',
        callerPays: '77',
        feeBps: 0,
        pricingVersion: 'checkout-web-fee-v1',
        client: null,
      },
    )
    const { status, json, createBody } = await run({
      payment_id: 'pl_test123',
      client: 'rozo-checkout-cli/1.0',
      quoteReceipt,
    })
    expect(status).toBe(200)
    expect(json.serviceFee).toBe('0')
    expect(createBody.source.amount).toBe('77')
  })

  it('rejects legacy v1 pricing when an enabled fee would change the shown total', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '77',
      'OpenRouter, Inc.',
      'test-admin-secret',
    )
    const { status, json, createBody } = await run({
      payment_id: 'pl_test123',
      client: 'rozo-checkout-web',
      quoteReceipt,
    }, '100')
    expect(status).toBe(409)
    expect(json.error.code).toBe('QUOTE_RECEIPT_INVALID_OR_EXPIRED')
    expect(createBody).toBeNull()
  })
})

// ── Stripe create-invoice must NEVER echo the URL or /pay/<blob> ─────────────
// create-invoice now resolves the Stripe session and (on success) creates a
// Rozo intent. Whatever the outcome (success, unpayable, expired, upstream
// error), the response must never contain the URL, the /pay/ path, or the
// replayable session blob. Regression test for the codex-flagged session-hash
// leak.
describe('handleCreateInvoice — Stripe URL never leaks the blob', () => {
  const BLOB = 'CDMSuperSecretReplayableBlob_ABC123xyz'
  const STRIPE_URL = `https://crypto.stripe.com/pay/${BLOB}`

  function makeEnv() {
    return {
      PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
      ROZO_INTENTS_API_KEY: 'test-key',
      MPP_STORE: makeKvStub(),
      ATOMIC_STORE: makeDoStub(),
      // AES-256 key (base64 of 32 bytes) so seedStripeRecord can encrypt the
      // capability instead of failing closed.
      INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    } as unknown as import('../src/index').Env
  }

  // Minimal in-memory KV stub.
  function makeKvStub() {
    const store = new Map<string, string>()
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    }
  }

  // Minimal AtomicStoreDO stub (/read + /commit CAS) for seedStripeRecord.
  function makeDoStub() {
    const store = new Map<string, string>()
    const versions = new Map<string, number>()
    const stub = {
      async fetch(req: Request) {
        const url = new URL(req.url)
        const b: any = await req.json()
        if (url.pathname === '/read') {
          return Response.json({ value: store.get(b.key) ?? null, version: versions.get(b.key) ?? 0 })
        }
        const cur = versions.get(b.key) ?? 0
        if (cur !== b.expectedVersion) {
          return Response.json({ ok: false, value: store.get(b.key) ?? null, version: cur })
        }
        if (b.op === 'set') store.set(b.key, b.value)
        else store.delete(b.key)
        versions.set(b.key, b.expectedVersion + 1)
        return Response.json({ ok: true })
      },
    }
    return { idFromName: (n: string) => ({ name: n }), get: () => stub }
  }

  async function callWith(url: string, env = makeEnv()) {
    const { handleCreateInvoice } = await import('../src/routes/create-invoice')
    const req = new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    const res = await handleCreateInvoice(req, env)
    const body = await res.text()
    return { status: res.status, body }
  }

  function assertNoLeak(body: string) {
    expect(body).not.toContain('crypto.stripe.com')
    expect(body).not.toContain(BLOB)
    expect(body).not.toContain('/pay/')
    expect(body).not.toContain('normalized_input')
  }

  it('never leaks the URL/blob when Stripe resolution fails (fake blob)', async () => {
    // A fake blob makes resume_payin_session 404 -> StripeResolveError; the
    // response must still be blob-free and provider-tagged.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as typeof fetch
    try {
      const { status, body } = await callWith(STRIPE_URL)
      // 410 expired (Stripe 404 maps to expired) — the exact code isn't the
      // point; the no-leak invariant is.
      expect([410, 502]).toContain(status)
      assertNoLeak(body)
      const json = JSON.parse(body)
      expect(json.provider).toBe('stripe_crypto')
      expect(json.ok).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never leaks the URL/blob on the success path (mocked Stripe + Rozo)', async () => {
    const env = makeEnv()
    const originalFetch = globalThis.fetch
    // Mock: resume_payin_session -> query payin_session -> Rozo order lookup
    // (404 miss) -> Rozo create intent.
    globalThis.fetch = (async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('/resume_payin_session')) {
        return new Response(
          JSON.stringify({
            sessionId: 'cpis_test123',
            clientSecret: 'cs_secret_should_never_leak',
            publishableKey: 'pk_live_should_never_leak',
            mode: 'pay',
          }),
          { status: 200 },
        )
      }
      if (u.includes('/payin_session')) {
        return new Response(
          JSON.stringify({
            id: 'cpis_test123',
            state: 'checkout',
            business_name: 'Test Merchant',
            merchant: 'acct_test',
            payment_details: { amount: 1000, currency: 'usd' },
            supported_currencies: [
              {
                id: 'usdc.base',
                chain_id: 8453,
                currency_network: 'base',
                mainnet: true,
                asset_code: 'usdc',
                currency_minor_units: 6,
                contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                payment_options: ['wallet_connect'],
              },
            ],
            valid_before: '2999-01-01T00:00:00.000Z',
          }),
          { status: 200 },
        )
      }
      if (u.includes('/payments/order/')) {
        return new Response('not found', { status: 404 }) // idempotency miss
      }
      if (u.includes('/payment-api')) {
        return new Response(
          JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const { status, body } = await callWith(STRIPE_URL, env)
      expect(status).toBe(200)
      assertNoLeak(body)
      // client_secret / publishable key must never leak either.
      expect(body).not.toContain('cs_secret_should_never_leak')
      expect(body).not.toContain('pk_live_should_never_leak')
      const json = JSON.parse(body)
      expect(json.provider).toBe('stripe_crypto')
      expect(json.invoiceKey).toBe('cpis_test123')
      expect(json.merchantAccount).toBe('acct_test')
      // No discount (founder decision 2026-08-18): caller pays the full amount.
      expect(json.callerPays).toBe('10')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fails closed (503, no payable link) when the capability key is unset (P1-1)', async () => {
    const env = makeEnv()
    // Remove the capability key: seedStripeRecord must refuse rather than store
    // the replayable URL in plaintext, and create-invoice must NOT hand back a
    // payable Rozo link for an order it can never settle.
    ;(env as any).INVOICE_CAPABILITY_ENCRYPTION_KEY = undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('/resume_payin_session')) {
        return new Response(
          JSON.stringify({ sessionId: 'cpis_test123', clientSecret: 'cs_x', publishableKey: 'pk_x', mode: 'pay' }),
          { status: 200 },
        )
      }
      if (u.includes('/payin_session')) {
        return new Response(
          JSON.stringify({
            id: 'cpis_test123',
            state: 'checkout',
            business_name: 'Test Merchant',
            merchant: 'acct_test',
            payment_details: { amount: 1000, currency: 'usd' },
            supported_currencies: [
              {
                id: 'usdc.base',
                chain_id: 8453,
                currency_network: 'base',
                mainnet: true,
                asset_code: 'usdc',
                currency_minor_units: 6,
                contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                payment_options: ['wallet_connect'],
              },
            ],
            valid_before: '2999-01-01T00:00:00.000Z',
          }),
          { status: 200 },
        )
      }
      if (u.includes('/payments/order/')) return new Response('not found', { status: 404 })
      if (u.includes('/payment-api')) {
        return new Response(
          JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const { status, body } = await callWith(STRIPE_URL, env)
      expect(status).toBe(503)
      // No payable link handed back.
      expect(body).not.toContain('pay.rozo.ai')
      assertNoLeak(body)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ── Already-paid vs expired disambiguation on quote-upstream 409/410 ─────────
describe('handleCreateInvoice — already-paid vs expired', () => {
  function makeEnv() {
    return {
      PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
      ROZO_INTENTS_API_KEY: 'test-key',
    } as unknown as import('../src/index').Env
  }

  async function runWithQuoteError(status: number, detail: string) {
    const { handleCreateInvoice } = await import('../src/routes/create-invoice')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('/quote-invoice')) return new Response(detail, { status })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const req = new Request('https://mpp.test/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://payments.coinbase.com/payment-sessions/paymentSession_e8d9fb75-eab1-4621-ae94-379b7f2836f6',
        }),
      })
      const res = await handleCreateInvoice(req, makeEnv())
      return { status: res.status, json: JSON.parse(await res.text()) }
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  it('CAPTURE_SUCCEEDED session → PAYMENT_ALREADY_PAID with payment_status', async () => {
    const { status, json } = await runWithQuoteError(
      409,
      JSON.stringify({ error: 'payment session is not payable: PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' }),
    )
    expect(status).toBe(409)
    expect(json.code).toBe('PAYMENT_ALREADY_PAID')
    expect(json.message).toMatch(/already been paid/i)
    expect(json.payment_status).toBe('PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED')
  })

  it('fully-used v1 link → PAYMENT_ALREADY_PAID', async () => {
    const { status, json } = await runWithQuoteError(
      409,
      JSON.stringify({ error: 'payment link already fully used (1/1)' }),
    )
    expect(status).toBe(409)
    expect(json.code).toBe('PAYMENT_ALREADY_PAID')
  })

  it('expired session (410) → LINK_USED_OR_EXPIRED unchanged', async () => {
    const { status, json } = await runWithQuoteError(
      410,
      JSON.stringify({ error: 'payment session expired' }),
    )
    expect(status).toBe(410)
    expect(json.code).toBe('LINK_USED_OR_EXPIRED')
  })

  it('other non-payable status (409) → LINK_USED_OR_EXPIRED with payment_status passthrough', async () => {
    const { status, json } = await runWithQuoteError(
      409,
      JSON.stringify({ error: 'payment session is not payable: PAYMENT_SESSION_STATUS_EXPIRED' }),
    )
    expect(status).toBe(409)
    expect(json.code).toBe('LINK_USED_OR_EXPIRED')
    expect(json.payment_status).toBe('PAYMENT_SESSION_STATUS_EXPIRED')
  })
})

// ── Coinbase line: reuse of an existing intent ──────────────────────────────
// The reuse gate used to be expiry-only, so an unexpired order was handed back
// regardless of its status and regardless of the source the caller asked for.
// A caller wanting Solana USDT got a Stellar USDC link with reused:true / 200.
describe('handleCreateInvoice — Coinbase reuse gate', () => {
  function makeEnv(feeBps?: string) {
    return {
      PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
      ROZO_INTENTS_API_KEY: 'test-key',
      CHECKOUT_WEB_FEE_BPS: feeBps,
    } as unknown as import('../src/index').Env
  }

  /** Runs the handler with an existing order row and a scripted rotation reply. */
  async function runReuse(
    existing: any,
    body: Record<string, unknown>,
    checkout: () => Response = () => new Response('{}', { status: 200 }),
    feeBps?: string,
  ) {
    const { handleCreateInvoice } = await import('../src/routes/create-invoice')
    let createBody: any = null
    let checkoutBody: any = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('/quote-invoice')) {
        return new Response(
          JSON.stringify({
            invoice: { amount: '105' },
            merchant: 'OpenRouter, Inc.',
            linkId: 'pl_test123',
          }),
          { status: 200 },
        )
      }
      if (u.includes('/payments/order/')) {
        return new Response(JSON.stringify(existing), { status: 200 })
      }
      if (u.includes('/checkout')) {
        checkoutBody = init?.body ? JSON.parse(init.body) : null
        return checkout()
      }
      if (u.includes('/payment-api')) {
        createBody = init?.body ? JSON.parse(init.body) : null
        return new Response(
          JSON.stringify({ id: 'rozo-new', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const req = new Request('https://mpp.test/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const res = await handleCreateInvoice(req, makeEnv(feeBps))
      return { status: res.status, json: JSON.parse(await res.text()), createBody, checkoutBody }
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  const unpaidStellar = {
    id: 'rozo-existing',
    status: 'payment_unpaid',
    paymentLink: 'https://pay.rozo.ai/existing',
    expiresAt: '2999-01-01T00:00:00.000Z',
    source: { chainId: '1500', tokenSymbol: 'USDC', amount: '105' },
  }

  it('rotates an unpaid order onto the requested source (the lost-sale incident)', async () => {
    const { status, json, createBody, checkoutBody } = await runReuse(
      unpaidStellar,
      { payment_id: 'pl_test123', source: { chainId: '900', tokenSymbol: 'USDT' } },
      () =>
        new Response(
          JSON.stringify({
            id: 'rozo-existing',
            status: 'payment_unpaid',
            paymentLink: 'https://pay.rozo.ai/rotated',
            expiresAt: '2999-03-01T00:00:00.000Z',
            source: { chainId: '900', tokenSymbol: 'USDT' },
          }),
          { status: 200 },
        ),
    )
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.sourceRotated).toBe(true)
    expect(checkoutBody).toEqual({ source: { chainId: '900', tokenSymbol: 'USDT' } })
    expect(json.source).toEqual({ chainId: '900', tokenSymbol: 'USDT' })
    expect(json.paymentLink).toBe('https://pay.rozo.ai/rotated')
    expect(json.expiresAt).toBe('2999-03-01T00:00:00.000Z')
    // Reuse means no second order under the same pl_ id.
    expect(createBody).toBeNull()
  })

  it('keeps serving the existing order (with a warning) when rotation fails', async () => {
    const { status, json } = await runReuse(
      unpaidStellar,
      { payment_id: 'pl_test123', source: { chainId: '900', tokenSymbol: 'USDT' } },
      () => new Response(JSON.stringify({ error: 'checkoutNotAllowed' }), { status: 400 }),
    )
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.sourceMismatch).toBe(true)
    expect(json.source).toEqual({ chainId: '1500', tokenSymbol: 'USDC' })
    expect(json.warnings.join(' ')).toContain('checkoutNotAllowed')
    expect(json.warnings.join(' ')).toContain('was not applied')
  })

  it('does not rotate when the requested source already matches', async () => {
    const { json, checkoutBody } = await runReuse(unpaidStellar, {
      payment_id: 'pl_test123',
      source: { chainId: '1500', tokenSymbol: 'USDC' },
    })
    expect(json.reused).toBe(true)
    expect(checkoutBody).toBeNull()
    expect(json.sourceRotated).toBeUndefined()
    expect(json.sourceMismatch).toBeUndefined()
    expect(json.warnings).toBeUndefined()
  })

  it('fails closed when a legacy lookup omits both source amount and pricing metadata', async () => {
    const { status, json, createBody } = await runReuse(
      {
        ...unpaidStellar,
        source: { chainId: '1500', tokenSymbol: 'USDC' },
      },
      { payment_id: 'pl_test123', source: { chainId: '1500', tokenSymbol: 'USDC' } },
    )
    expect(status).toBe(409)
    expect(json.error.code).toBe('LEGACY_PRICING_ORDER_PENDING')
    expect(createBody).toBeNull()
  })

  it('fails closed when a lightning lookup omits both destination amount and pricing metadata', async () => {
    const { status, json, createBody } = await runReuse(
      {
        ...unpaidStellar,
        source: { chainId: 'lightning', tokenSymbol: 'BTC' },
      },
      { payment_id: 'pl_test123' },
    )
    expect(status).toBe(409)
    expect(json.error.code).toBe('LEGACY_PRICING_ORDER_PENDING')
    expect(createBody).toBeNull()
  })

  it('never rotates a lightning order — warns instead', async () => {
    const { json, checkoutBody } = await runReuse(
      {
        ...unpaidStellar,
        source: { chainId: 'lightning', tokenSymbol: 'BTC' },
        destination: { amount: '105' },
      },
      { payment_id: 'pl_test123', source: { chainId: '900', tokenSymbol: 'USDT' } },
    )
    expect(checkoutBody).toBeNull()
    expect(json.sourceMismatch).toBe(true)
    expect(json.source).toEqual({ chainId: 'lightning', tokenSymbol: 'BTC' })
  })

  it('rejects a zero-fee pending order when the browser canary price is now 1%', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '105',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '105',
        serviceFee: '1.05',
        callerPays: '106.05',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
        client: 'rozo-checkout-web',
      },
    )
    const { status, json, checkoutBody } = await runReuse(
      unpaidStellar,
      {
        payment_id: 'pl_test123',
        client: 'rozo-checkout-web',
        quoteReceipt,
        source: { chainId: '1500', tokenSymbol: 'USDC' },
      },
      () => new Response('{}', { status: 200 }),
      '100',
    )
    expect(status).toBe(409)
    expect(json.error.code).toBe('LEGACY_PRICING_ORDER_PENDING')
    expect(checkoutBody).toBeNull()
  })

  it('rejects a fee-bearing row with unreadable amount after rollback to zero', async () => {
    const { status, json } = await runReuse(
      {
        ...unpaidStellar,
        source: { chainId: '1500', tokenSymbol: 'USDC' },
        metadata: {
          original: '105',
          serviceFee: '1.05',
          callerPays: '106.05',
          feeBps: 100,
          pricingVersion: 'checkout-web-fee-v1',
        },
      },
      { payment_id: 'pl_test123', source: { chainId: '1500', tokenSymbol: 'USDC' } },
    )
    expect(status).toBe(409)
    expect(json.error.code).toBe('LEGACY_PRICING_ORDER_PENDING')
  })

  it('reuses a fee-priced pending order when lookup omits metadata but amount matches', async () => {
    const quoteReceipt = await createQuoteReceipt(
      'pl_test123',
      '105',
      'OpenRouter, Inc.',
      'test-admin-secret',
      Math.floor(Date.now() / 1000),
      {
        original: '105',
        serviceFee: '1.05',
        callerPays: '106.05',
        feeBps: 100,
        pricingVersion: 'checkout-web-fee-v1',
        client: 'rozo-checkout-web',
      },
    )
    const { status, json, createBody } = await runReuse(
      {
        ...unpaidStellar,
        source: { ...unpaidStellar.source, amount: '106.05' },
      },
      {
        payment_id: 'pl_test123',
        client: 'rozo-checkout-web',
        quoteReceipt,
      },
      () => new Response('{}', { status: 200 }),
      '100',
    )
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.callerPays).toBe('106.05')
    expect(createBody).toBeNull()
  })

  it('409s an unexpired order that is no longer unpaid instead of reusing it', async () => {
    const { status, json, createBody } = await runReuse(
      { ...unpaidStellar, status: 'payment_completed' },
      { payment_id: 'pl_test123', source: { chainId: '900', tokenSymbol: 'USDT' } },
    )
    expect(status).toBe(409)
    expect(json.ok).toBe(false)
    expect(json.error.code).toBe('ORDER_ALREADY_ACTIVE')
    expect(json.status).toBe('payment_completed')
    expect(json.rozoPaymentId).toBe('rozo-existing')
    expect(json.linkId).toBe('pl_test123')
    expect(createBody).toBeNull()
  })
})


describe('caller provenance', () => {
  it('keeps a well-formed client label', () => {
    expect(resolveClient('rozo-checkout-cli/1.2.3')).toBe('rozo-checkout-cli/1.2.3')
    expect(resolveClient('  checkout-web  ')).toBe('checkout-web')
  })

  it('drops non-strings and empty labels instead of failing the payment', () => {
    // Provenance is telemetry on a money path: malformed input is discarded,
    // never turned into a 400 that would stop the order.
    for (const bad of [undefined, null, 42, {}, [], true, '', '   ']) {
      expect(resolveClient(bad)).toBeNull()
    }
  })

  it('strips anything that could survive into stored JSONB as markup or SQL', () => {
    expect(resolveClient('cli<script>"' + String.fromCharCode(10) + ' x')).toBe('cliscript x')
    expect(resolveClient("a'; DROP TABLE t; --")).toBe('a DROP TABLE t --')
    // Same charset the canonical attribution whitelist enforces, plus `/`.
    expect(resolveClient('a:b@c+d%e&f=g')).toBe('abcdefg')
  })

  it('caps the label and bounds the input before scanning it', () => {
    expect(resolveClient('a'.repeat(200))).toHaveLength(64)
    // A multi-megabyte value must not cost a full-length regex pass to discard.
    const huge = 'a'.repeat(5_000_000)
    const started = Date.now()
    expect(resolveClient(huge)).toHaveLength(64)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
