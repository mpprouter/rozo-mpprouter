import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isStripeOrderId,
  stripeOrderId,
  invoiceKeyFromOrderId,
  stripeKvKey,
  dailySpentKey,
  maskInvoiceKey,
  seedStripeRecord,
  readDailySpentAtomic,
  reserveDailySpend,
  releaseDailySpend,
  handleStripeWebhookEvent,
  callStripePayInvoice,
} from '../src/routes/stripe-fulfillment'
import { casRead } from '../src/routes/stripe-atomic'
import {
  encryptCapability,
  decryptCapability,
  CapabilityCryptoError,
} from '../src/routes/invoice-capability-crypto'
import type { Env } from '../src/index'
import { readFunderReservedAtomic } from '../src/routes/funder-reservation'

// ── In-memory AtomicStoreDO mock ────────────────────────────────────────────
// Implements the DO's /read + /commit versioned-CAS contract so the code under
// test exercises the SAME linearizable path it uses in production. Storage is a
// single Map keyed by `v:<k>` / `n:<k>`, mirroring the real DO's key layout.
function makeDoNamespace() {
  const store = new Map<string, string>() // v:<k>
  const versions = new Map<string, number>() // n:<k>
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const body: any = await req.json()
      if (url.pathname === '/read') {
        return Response.json({
          value: store.get(body.key) ?? null,
          version: versions.get(body.key) ?? 0,
        })
      }
      if (url.pathname === '/commit') {
        const cur = versions.get(body.key) ?? 0
        if (cur !== body.expectedVersion) {
          return Response.json({ ok: false, value: store.get(body.key) ?? null, version: cur })
        }
        if (body.op === 'set') store.set(body.key, body.value)
        else store.delete(body.key)
        versions.set(body.key, body.expectedVersion + 1)
        return Response.json({ ok: true })
      }
      return new Response('Not Found', { status: 404 })
    },
  }
  return {
    _store: store,
    idFromName: (_n: string) => ({ name: _n }),
    get: (_id: any) => stub,
  }
}

// KV stub — still used for the shared Coinbase reserved-counter (unchanged).
function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

// Fixed 32-byte AES-256 key (base64) for capability encryption in tests.
const TEST_CAP_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')

function makeEnv(opts: { kv?: ReturnType<typeof makeKv>; ns?: ReturnType<typeof makeDoNamespace>; extra?: Partial<Env> } = {}): Env {
  const kv = opts.kv ?? makeKv()
  const ns = opts.ns ?? makeDoNamespace()
  return {
    MPP_STORE: kv as any,
    ATOMIC_STORE: ns as any,
    PAYINVOICE_ADMIN_SECRET: 'admin',
    ROZO_INTENTS_API_KEY: 'key',
    BASE_RPC_URL: undefined,
    INVOICE_CAPABILITY_ENCRYPTION_KEY: TEST_CAP_KEY,
    ...opts.extra,
  } as unknown as Env
}

// Read a fulfillment record out of the mock DO for assertions.
async function loadRec(env: Env, invoiceKey: string): Promise<any> {
  const { value } = await casRead(env, stripeKvKey(invoiceKey))
  return value ? JSON.parse(value) : null
}

describe('order-id + kv-key helpers', () => {
  it('classifies and round-trips provider-qualified order ids', () => {
    const oid = stripeOrderId('cpis_abc')
    expect(oid).toBe('stripe_crypto_cpis_abc')
    expect(isStripeOrderId(oid)).toBe(true)
    expect(isStripeOrderId('pl_coinbase')).toBe(false)
    expect(isStripeOrderId(null)).toBe(false)
    expect(invoiceKeyFromOrderId(oid)).toBe('cpis_abc')
  })

  it('uses a distinct v2 namespace (never collides with Coinbase key)', () => {
    expect(stripeKvKey('cpis_abc')).toBe('invoice-fulfillment:v2:stripe_crypto:cpis_abc')
    expect(stripeKvKey('cpis_abc')).not.toBe('invoice-fulfillment:cpis_abc')
  })

  it('masks the invoice key for logs (prefix + last 4)', () => {
    expect(maskInvoiceKey('cpis_1234567890abcd')).toBe('cpis_1234…abcd')
    expect(maskInvoiceKey('cpis_x')).toBe('cpis_…')
  })

  it('keys the daily ledger by UTC date', () => {
    const d = new Date(Date.UTC(2026, 6, 12, 23, 59))
    expect(dailySpentKey(d)).toBe('stripe-daily-spent:2026-07-12')
  })
})

describe('daily-spend ledger (atomic reserve/release)', () => {
  it('reads 0 when unset; reserve advances and returns the pre-spend', async () => {
    const env = makeEnv()
    const now = new Date(Date.UTC(2026, 6, 12))
    expect(await readDailySpentAtomic(env, now)).toBe(0n)
    expect(await reserveDailySpend(env, now, 5_000_000n)).toBe(0n) // pre-spend was 0
    expect(await readDailySpentAtomic(env, now)).toBe(5_000_000n)
    expect(await reserveDailySpend(env, now, 3_000_000n)).toBe(5_000_000n)
    expect(await readDailySpentAtomic(env, now)).toBe(8_000_000n)
  })

  it('refuses a reservation that would exceed the daily cap (returns null, no advance)', async () => {
    const env = makeEnv({ extra: { STRIPE_FULFILLMENT_DAILY_CAP_USD: '200' } as any })
    const now = new Date(Date.UTC(2026, 6, 12))
    await reserveDailySpend(env, now, 190_000_000n) // $190 spent
    const rejected = await reserveDailySpend(env, now, 30_000_000n) // +$30 → $220 > $200
    expect(rejected).toBeNull()
    expect(await readDailySpentAtomic(env, now)).toBe(190_000_000n) // unchanged
  })

  it('releases reserved headroom, never below zero', async () => {
    const env = makeEnv()
    const now = new Date(Date.UTC(2026, 6, 12))
    await reserveDailySpend(env, now, 5_000_000n)
    await releaseDailySpend(env, now, 3_000_000n)
    expect(await readDailySpentAtomic(env, now)).toBe(2_000_000n)
    await releaseDailySpend(env, now, 999_000_000n)
    expect(await readDailySpentAtomic(env, now)).toBe(0n)
  })
})

describe('seedStripeRecord', () => {
  it('persists locked fields incl. the Stripe URL (never in the event log)', async () => {
    const env = makeEnv()
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_seed',
      merchantAccount: 'acct_seed',
      invoiceAmountAtomic: '18190000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:abc',
      stripeUrl: 'https://crypto.stripe.com/pay/SECRETBLOB',
      rozoPaymentId: 'rp1',
    })
    const rec = await loadRec(env, 'cpis_seed')
    expect(rec.merchantAccount).toBe('acct_seed')
    expect(rec.invoiceAmountAtomic).toBe('18190000')
    expect(rec.lockFingerprint).toBe('sha256:abc')
    expect(rec.status).toBe('rozo_payment_created')
    // The URL is stored ENCRYPTED (design §6): the plaintext / replayable blob
    // must NOT appear anywhere in the persisted record, and there is no
    // plaintext stripeUrl field.
    expect(rec.stripeUrl).toBeUndefined()
    expect(rec.stripeUrlEncrypted).toBeTruthy()
    expect(JSON.stringify(rec)).not.toContain('SECRETBLOB')
    expect(JSON.stringify(rec)).not.toContain('crypto.stripe.com')
    // ...and it decrypts back to the original URL.
    expect(await decryptCapability(rec.stripeUrlEncrypted, env)).toBe(
      'https://crypto.stripe.com/pay/SECRETBLOB',
    )
    expect(JSON.stringify(rec.events)).not.toContain('SECRETBLOB')
  })

  it('is monotonic: a re-seed NEVER rolls an in-flight record backward (P0-3)', async () => {
    const env = makeEnv()
    const args = {
      invoiceKey: 'cpis_mono',
      merchantAccount: 'acct_m',
      invoiceAmountAtomic: '10000000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:m',
      stripeUrl: 'https://crypto.stripe.com/pay/M',
      rozoPaymentId: 'rp-m',
    }
    await seedStripeRecord(env, args)
    // Simulate the webhook having advanced the record to provider_submitted.
    const rec = await loadRec(env, 'cpis_mono')
    rec.status = 'provider_submitted'
    // write it back through the DO at the current version
    const { version } = await casRead(env, stripeKvKey('cpis_mono'))
    await (env.ATOMIC_STORE as any).get(null).fetch(
      new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey('cpis_mono'), expectedVersion: version, op: 'set', value: JSON.stringify(rec) }) }),
    )
    // A duplicate/concurrent create-invoice re-seeds — must NOT roll back.
    await seedStripeRecord(env, args)
    const after = await loadRec(env, 'cpis_mono')
    expect(after.status).toBe('provider_submitted')
  })
})

describe('invoice capability encryption (design §6)', () => {
  const URL = 'https://crypto.stripe.com/pay/CDMxxSECRETBLOBxx'

  it('round-trips: decrypt(encrypt(url)) === url', async () => {
    const env = makeEnv()
    const blob = await encryptCapability(URL, env)
    expect(await decryptCapability(blob, env)).toBe(URL)
  })

  it('ciphertext never contains the plaintext URL or the /pay/ blob', async () => {
    const env = makeEnv()
    const blob = await encryptCapability(URL, env)
    expect(blob).not.toContain('crypto.stripe.com')
    expect(blob).not.toContain('CDMxxSECRETBLOBxx')
    expect(blob.startsWith('v1:')).toBe(true) // self-describing, key-id prefixed
  })

  it('uses a fresh IV each time (same plaintext → different blob)', async () => {
    const env = makeEnv()
    const a = await encryptCapability(URL, env)
    const b = await encryptCapability(URL, env)
    expect(a).not.toBe(b)
    expect(await decryptCapability(a, env)).toBe(URL)
    expect(await decryptCapability(b, env)).toBe(URL)
  })

  it('decrypt fails under a different key (auth-tag rejects it)', async () => {
    const env1 = makeEnv()
    const otherKey = Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
    const env2 = makeEnv({ extra: { INVOICE_CAPABILITY_ENCRYPTION_KEY: otherKey } as any })
    const blob = await encryptCapability(URL, env1)
    await expect(decryptCapability(blob, env2)).rejects.toBeInstanceOf(CapabilityCryptoError)
  })

  it('fails closed: encrypt throws when no key is configured', async () => {
    const env = makeEnv({ extra: { INVOICE_CAPABILITY_ENCRYPTION_KEY: undefined } as any })
    await expect(encryptCapability(URL, env)).rejects.toBeInstanceOf(CapabilityCryptoError)
  })

  it('seed fails closed (no plaintext fallback) when no key is configured', async () => {
    const env = makeEnv({ extra: { INVOICE_CAPABILITY_ENCRYPTION_KEY: undefined } as any })
    await expect(
      seedStripeRecord(env, {
        invoiceKey: 'cpis_nokey',
        merchantAccount: 'acct_x',
        invoiceAmountAtomic: '1000000',
        invoiceCurrency: 'usd',
        lockFingerprint: 'sha256:x',
        stripeUrl: URL,
        rozoPaymentId: 'rp',
      }),
    ).rejects.toBeInstanceOf(CapabilityCryptoError)
    // Nothing persisted — no partial/plaintext record left behind.
    expect(await loadRec(env, 'cpis_nokey')).toBeNull()
  })

  it('rotation: a blob sealed with the previous key still decrypts', async () => {
    const oldKey = Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    const newKey = Buffer.from(new Uint8Array(32).fill(2)).toString('base64')
    const oldEnv = makeEnv({
      extra: { INVOICE_CAPABILITY_ENCRYPTION_KEY: oldKey, INVOICE_CAPABILITY_KEY_ID: 'v1' } as any,
    })
    const blob = await encryptCapability(URL, oldEnv)
    // After rotation: current key is v2, old key kept as previous for decrypt.
    const rotated = makeEnv({
      extra: {
        INVOICE_CAPABILITY_ENCRYPTION_KEY: newKey,
        INVOICE_CAPABILITY_KEY_ID: 'v2',
        INVOICE_CAPABILITY_ENCRYPTION_KEY_PREVIOUS: oldKey,
        INVOICE_CAPABILITY_KEY_ID_PREVIOUS: 'v1',
      } as any,
    })
    expect(await decryptCapability(blob, rotated)).toBe(URL)
  })

  it('decrypt rejects a malformed blob', async () => {
    const env = makeEnv()
    await expect(decryptCapability('not-a-blob', env)).rejects.toBeInstanceOf(CapabilityCryptoError)
  })
})

describe('callStripePayInvoice', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends the required lock binding + daily ledger to pay-invoice', async () => {
    let sentBody: any = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      sentBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
    const r = await callStripePayInvoice(makeEnv(), {
      stripeUrl: 'https://crypto.stripe.com/pay/X',
      expectedMerchantAccount: 'acct_x',
      expectedAmountAtomic: '18190000',
      spentTodayAtomic: '5000000',
    })
    expect(r.ok).toBe(true)
    expect(sentBody.expected_merchant_account).toBe('acct_x')
    expect(sentBody.expected_amount_atomic).toBe('18190000')
    expect(sentBody.spent_today_atomic).toBe('5000000')
    expect(sentBody.url).toBe('https://crypto.stripe.com/pay/X')
  })

  it('detects the fail-closed disabled 403 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Stripe fulfillment disabled (fail-closed).', code: 'stripe_fulfillment_disabled' }), { status: 403 }),
    )
    const r = await callStripePayInvoice(makeEnv(), {
      stripeUrl: 'https://crypto.stripe.com/pay/X',
      expectedMerchantAccount: 'acct_x',
      expectedAmountAtomic: '1',
      spentTodayAtomic: '0',
    })
    expect(r.disabled).toBe(true)
    expect(r.ok).toBe(false)
  })
})

describe('handleStripeWebhookEvent', () => {
  afterEach(() => vi.restoreAllMocks())

  async function seed(env: Env, key = 'cpis_wh') {
    await seedStripeRecord(env, {
      invoiceKey: key,
      merchantAccount: 'acct_wh',
      invoiceAmountAtomic: '10000000', // $10
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:zz',
      stripeUrl: 'https://crypto.stripe.com/pay/WHBLOB',
      rozoPaymentId: 'rp-wh',
    })
  }

  const evt = (over: Partial<any> = {}) => ({
    eventId: 'ev', eventType: 'payment_payout_completed',
    orderId: 'stripe_crypto_cpis_wh', rozoPaymentId: 'rp-wh', invoiceAmountStr: '10.00',
    ...over,
  })

  it('records provider_disabled (not a failure) when pay-invoice is fail-closed', async () => {
    const env = makeEnv()
    await seed(env)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        return new Response(
          JSON.stringify({ code: 'stripe_fulfillment_disabled', error: 'disabled' }),
          { status: 403 },
        )
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16) }),
        { status: 200 },
      )
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    const summary = await handleStripeWebhookEvent(env, evt({ eventId: 'ev1' }), now)
    expect(summary.status).toBe('provider_disabled')
    expect(await readFunderReservedAtomic(env)).toBe(0n)
    // no money moved → daily ledger back to 0 (reservation released).
    expect(await readDailySpentAtomic(env, now)).toBe(0n)
  })

  it('does not double-fire while a settlement is in flight (guard, P0-1)', async () => {
    const env = makeEnv()
    await seed(env)
    // Force provider_paying via the DO.
    const rec = await loadRec(env, 'cpis_wh')
    rec.status = 'provider_paying'
    const { version } = await casRead(env, stripeKvKey('cpis_wh'))
    await (env.ATOMIC_STORE as any).get(null).fetch(
      new Request('https://x/commit', { method: 'POST', body: JSON.stringify({ key: stripeKvKey('cpis_wh'), expectedVersion: version, op: 'set', value: JSON.stringify(rec) }) }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const summary = await handleStripeWebhookEvent(env, evt({ eventId: 'ev2' }), new Date(Date.UTC(2026, 6, 12)))
    expect(summary.already_in_flight).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('two concurrent events → only ONE reaches pay-invoice (double-sign serializer)', async () => {
    const env = makeEnv()
    await seed(env)
    let payInvoiceCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        payInvoiceCalls++
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    // Fire two settlement-driving events concurrently against the same invoice.
    const [a, b] = await Promise.all([
      handleStripeWebhookEvent(env, evt({ eventId: 'evA' }), now),
      handleStripeWebhookEvent(env, evt({ eventId: 'evB', eventType: 'payment_payin_completed' }), now),
    ])
    // Exactly one settles; the other is guarded as in_flight (or defers).
    expect(payInvoiceCalls).toBe(1)
    const settled = [a, b].filter((r) => r.status === 'provider_submitted')
    expect(settled.length).toBe(1)
    // Daily ledger advanced by exactly ONE invoice amount.
    expect(await readDailySpentAtomic(env, now)).toBe(10_000_000n)
  })

  it('transport failure → provider_submitted_ambiguous (NON-retryable, no re-fire) (P0-2)', async () => {
    const env = makeEnv()
    await seed(env)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        throw new Error('network reset')
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    const first = await handleStripeWebhookEvent(env, evt({ eventId: 'ev-amb1' }), now)
    expect(first.status).toBe('provider_submitted_ambiguous')
    expect(first.ambiguous).toBe(true)
    // A subsequent event MUST be guarded — no second pay-invoice attempt.
    let secondCalledPayInvoice = false
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) { secondCalledPayInvoice = true; return new Response('{}', { status: 200 }) }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const second = await handleStripeWebhookEvent(env, evt({ eventId: 'ev-amb2' }), now)
    expect(second.already_in_flight).toBe(true)
    expect(secondCalledPayInvoice).toBe(false)
  })

  it('falls into manual_review when the locked binding is missing', async () => {
    const env = makeEnv()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const summary = await handleStripeWebhookEvent(env, evt({ eventId: 'ev3', orderId: 'stripe_crypto_cpis_missing', rozoPaymentId: null }), new Date(Date.UTC(2026, 6, 12)))
    expect(summary.deferred).toBe('missing_lock_binding')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('manual_review is terminal: a later event never reclaims + auto-submits (P1)', async () => {
    const env = makeEnv()
    // First event with no seeded lock binding → manual_review, no fetch.
    const first = await handleStripeWebhookEvent(env, evt({ eventId: 'evmr1', orderId: 'stripe_crypto_cpis_mr', rozoPaymentId: null }), new Date(Date.UTC(2026, 6, 12)))
    expect(first.deferred).toBe('missing_lock_binding')
    // Now a fully-valid seed appears late AND a payout event arrives. The
    // record is already manual_review — it must NOT be reclaimed for settlement.
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_mr',
      orderId: 'stripe_crypto_cpis_mr',
      merchantAccount: 'acct_mr',
      invoiceAmountAtomic: '10000000',
      lockFingerprint: 'sha256:mr',
      stripeUrl: 'https://crypto.stripe.com/pay/CDMmr',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const summary = await handleStripeWebhookEvent(env, evt({ eventId: 'evmr2', orderId: 'stripe_crypto_cpis_mr', eventType: 'payment_payout_completed' }), new Date(Date.UTC(2026, 6, 12)))
    // Stays terminal manual_review; pay-invoice is never called.
    expect(fetchSpy).not.toHaveBeenCalled()
    const rec = await loadRec(env, 'cpis_mr')
    expect(rec.status).toBe('manual_review')
  })

  it('advances to provider_submitted + bumps daily ledger on accept; stores WHITELISTED result (P1-2)', async () => {
    const env = makeEnv()
    await seed(env)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        // Downstream echoes a secret-shaped field — must NOT be stored verbatim.
        return new Response(JSON.stringify({ success: true, state: 'purchase_complete', client_secret: 'cs_LEAK', url: 'https://crypto.stripe.com/pay/LEAK' }), { status: 200 })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    const summary = await handleStripeWebhookEvent(env, evt({ eventId: 'ev4' }), now)
    expect(summary.status).toBe('provider_submitted')
    expect(await readDailySpentAtomic(env, now)).toBe(10_000_000n)
    const rec = await loadRec(env, 'cpis_wh')
    // Whitelisted projection only — no client_secret / url leaked into storage.
    expect(JSON.stringify(rec.providerResult)).not.toContain('cs_LEAK')
    expect(JSON.stringify(rec.providerResult)).not.toContain('crypto.stripe.com/pay/LEAK')
    expect(rec.providerResult.success).toBe(true)
    expect(rec.providerResult.state).toBe('purchase_complete')
  })
})
