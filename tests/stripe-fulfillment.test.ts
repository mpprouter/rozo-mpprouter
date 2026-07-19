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

  // Finding 4: a 2xx with an empty / HTML / truncated body proves nothing —
  // pay-invoice MAY have signed. It must be AMBIGUOUS, never a confirmed
  // success (which would mark provider_submitted and fence off retries).
  it('treats an unparseable 2xx body as ambiguous, not success (finding 4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>gateway</html>', { status: 200 }),
    )
    const r = await callStripePayInvoice(makeEnv(), {
      stripeUrl: 'https://crypto.stripe.com/pay/X',
      expectedMerchantAccount: 'acct_x',
      expectedAmountAtomic: '1',
      spentTodayAtomic: '0',
    })
    expect(r.ok).toBe(false)
    expect(r.ambiguous).toBe(true)
    expect(r.disabled).toBe(false)
  })

  it('treats a 2xx JSON body without an affirmative field as ambiguous (finding 4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ note: 'accepted for processing' }), { status: 200 }),
    )
    const r = await callStripePayInvoice(makeEnv(), {
      stripeUrl: 'https://crypto.stripe.com/pay/X',
      expectedMerchantAccount: 'acct_x',
      expectedAmountAtomic: '1',
      spentTodayAtomic: '0',
    })
    expect(r.ok).toBe(false)
    expect(r.ambiguous).toBe(true)
  })

  it('confirms success only with an explicit affirmative field (finding 4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    )
    const r = await callStripePayInvoice(makeEnv(), {
      stripeUrl: 'https://crypto.stripe.com/pay/X',
      expectedMerchantAccount: 'acct_x',
      expectedAmountAtomic: '1',
      spentTodayAtomic: '0',
    })
    expect(r.ok).toBe(true)
    expect(r.ambiguous).toBe(false)
  })

  // Finding 5: a parseable 429 is a DEFINITE-but-temporary rejection where
  // pay-invoice did NOT sign. It is NOT ambiguous — it is retryable.
  it('classifies a parseable 429 as non-ambiguous, non-ok (retryable) (finding 5)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
    )
    const r = await callStripePayInvoice(makeEnv(), {
      stripeUrl: 'https://crypto.stripe.com/pay/X',
      expectedMerchantAccount: 'acct_x',
      expectedAmountAtomic: '1',
      spentTodayAtomic: '0',
    })
    expect(r.ok).toBe(false)
    expect(r.ambiguous).toBe(false)
    expect(r.status).toBe(429)
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

  // Finding 5: a 429 from pay-invoice must release the claim back to a
  // retryable state (payout_seen), NOT park it in terminal failed_provider,
  // and must return the daily-spend reservation (no money moved).
  it('a 429 from pay-invoice is retryable, not terminal failed_provider (finding 5)', async () => {
    const env = makeEnv()
    await seed(env)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    const summary = await handleStripeWebhookEvent(env, evt({ eventId: 'ev429' }), now)
    expect(summary.deferred).toBe('provider_rate_limited')
    // Payout event → retryable so the webhook layer will not mark it processed.
    expect(summary.retryable).toBe(true)
    // Daily reservation released (money did not move) and claim is NOT terminal.
    expect(await readDailySpentAtomic(env, now)).toBe(0n)
    expect(await readFunderReservedAtomic(env)).toBe(0n)
    const rec = await loadRec(env, 'cpis_wh')
    expect(rec.status).toBe('payout_seen') // retryable, not failed_provider
  })

  // Finding 10: a payin-completed event that finds insufficient balance must
  // release the claim to payin_seen — NOT payout_seen — so the audit trail
  // never falsely asserts the destination tx already landed.
  it('payin insufficient-balance releases the claim to payin_seen, not payout_seen (finding 10)', async () => {
    const env = makeEnv()
    await seed(env)
    // Balance RPC returns 0 → reservation insufficient for the $10 invoice.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        throw new Error('pay-invoice should never be called on insufficient balance')
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }), { status: 200 })
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    const summary = await handleStripeWebhookEvent(
      env,
      evt({ eventId: 'evpayin', eventType: 'payment_payin_completed' }),
      now,
    )
    expect(summary.deferred).toBe('insufficient_balance')
    // NOT retryable (payin will be followed by a payout event).
    expect(summary.retryable).toBeUndefined()
    const rec = await loadRec(env, 'cpis_wh')
    expect(rec.status).toBe('payin_seen')
  })

  // Finding 3: an unexpected throw AFTER the funder reservation is acquired but
  // BEFORE the pay-invoice request is sent must release the funder reservation,
  // the daily reservation, and the provider_paying claim — otherwise the order
  // and the shared pool are stuck forever with no call ever made.
  it('pre-call throw releases funder + daily reservation and steps the claim down (finding 3)', async () => {
    let payInvoiceCalled = false
    // Throw INSIDE the pre-call guard (after the claim + funder reservation +
    // daily reserve, before any request is sent) by making exactly the SECOND
    // read of the fulfillment record — the pre-call load — fail with a DO 503.
    // The claim read (#1) and every later read (the cleanup releaseClaim and
    // this test's own assertions) must keep working.
    const goodNs = makeDoNamespace()
    const goodEnv = makeEnv({ ns: goodNs })
    await seedStripeRecord(goodEnv, {
      invoiceKey: 'cpis_precall',
      merchantAccount: 'acct_pc',
      invoiceAmountAtomic: '10000000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:pc',
      stripeUrl: 'https://crypto.stripe.com/pay/PC',
      rozoPaymentId: 'rp-pc',
    })
    // Reads of the record key done during seeding are already over; from here
    // read #1 is the claim CAS, read #2 is the pre-call load.
    let recReads = 0
    const wrappedStub = {
      async fetch(req: Request): Promise<Response> {
        const clone = req.clone()
        const body: any = await clone.json().catch(() => ({}))
        const isRecordRead =
          new URL(req.url).pathname === '/read' &&
          body.key === stripeKvKey('cpis_precall')
        if (isRecordRead) {
          recReads++
          if (recReads === 2) return new Response('boom', { status: 503 })
        }
        return goodNs.get(null).fetch(req)
      },
    }
    goodEnv.ATOMIC_STORE = {
      idFromName: (_n: string) => ({ name: _n }),
      get: () => wrappedStub,
    } as any
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
      if (u.includes('pay-invoice') || u.includes('agentapi')) {
        payInvoiceCalled = true
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (1_000_000_000n).toString(16).padStart(64, '0') }), { status: 200 })
    })
    const now = new Date(Date.UTC(2026, 6, 12))
    await expect(
      handleStripeWebhookEvent(goodEnv, {
        eventId: 'evpc', eventType: 'payment_payout_completed',
        orderId: 'stripe_crypto_cpis_precall', rozoPaymentId: 'rp-pc', invoiceAmountStr: '10.00',
      }, now),
    ).rejects.toThrow()
    // No pay-invoice call was made.
    expect(payInvoiceCalled).toBe(false)
    // Funder + daily reservations released (shared pool not stuck).
    expect(await readFunderReservedAtomic(goodEnv)).toBe(0n)
    expect(await readDailySpentAtomic(goodEnv, now)).toBe(0n)
    // Claim stepped down from provider_paying to the retryable payout_seen.
    const rec = await loadRec(goodEnv, 'cpis_precall')
    expect(rec.status).toBe('payout_seen')
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
