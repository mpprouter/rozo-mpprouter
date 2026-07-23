import { describe, it, expect } from 'vitest'
import {
  computeCallerPaysAtomic,
  parseUsdc,
  formatUsdc,
  formatTitleAmount,
  buildTitle,
  buildFullAmountTitle,
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
  function makeEnv() {
    return {
      PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
      ROZO_INTENTS_API_KEY: 'test-key',
    } as unknown as import('../src/index').Env
  }

  // Runs the handler with a body, capturing the JSON body POSTed to the Rozo
  // intents create endpoint. Quote upstream returns a fixed $105 OpenRouter
  // invoice; the order-lookup returns 404 (idempotency miss).
  async function run(body: Record<string, unknown>) {
    const { handleCreateInvoice } = await import('../src/routes/create-invoice')
    let createBody: any = null
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
      const res = await handleCreateInvoice(req, makeEnv())
      const json = JSON.parse(await res.text())
      return { status: res.status, json, createBody }
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
      // discount applied: invoice $10 -> caller pays $9.52 (10*100/105).
      expect(json.callerPays).toBe('9.523809')
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
