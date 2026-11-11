/**
 * Bitrefill funder model (founder 2026-11-11): create under merchant_openrouter
 * priced invoice + 1%, settle by asking pay-invoice (provider "bitrefill") once
 * the order is paid out to the funder, resolve unknown outcomes from
 * USDC.authorizationState only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice, SETTLEMENT_RECEIVER } from '../src/routes/create-invoice'
import { FUNDER_WALLET, handleRozoWebhook, type FulfillmentRecord } from '../src/routes/webhook'
import { FUNDER_WALLET as STRIPE_FUNDER } from '../src/routes/stripe-fulfillment'
import {
  BITREFILL_FUNDER,
  bitrefillNonce,
  bitrefillReceiverRefusal,
  computeBitrefillBinding,
  readBitrefillFacts,
} from '../src/routes/bitrefill-binding'
import {
  AUTHORIZATION_STATE_SELECTOR,
  authorizationDeadlineMs,
  classifyBitrefillPayResult,
  sweepBitrefillFulfillments,
} from '../src/routes/bitrefill-settle'
import { readCoinbaseExecGate } from '../src/routes/coinbase-exec-gate'
import { readDailySpentAtomic } from '../src/routes/stripe-fulfillment'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const ADMIN = 'test-admin-secret'
const WEBHOOK_SECRET = 'test-webhook-secret'
const INVOICE = 'ec9482de-1111-4222-8333-34a72b96b321'
const PL = `bitrefill_${INVOICE}`
const KEY = `invoice-fulfillment:${PL}`
const RECEIVER = '0x1111111111111111111111111111111111111111'
const ROZO_ID = '22222222-3333-4444-5555-666666666666'
const TX = '0x' + 'ab'.repeat(32)
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

function makeKv() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKv()
  const env = {
    MPP_STORE: kv,
    ATOMIC_STORE: makeAtomicStoreMock(),
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: ADMIN,
    BASE_RPC_URL: 'https://rpc.test/primary',
    DINGTALK_ACCESS_TOKEN: 'dt-test-token',
    ROZO_INTENTS_API_KEY: 'openrouter-key',
    ROZO_BITREFILL_API_KEY: 'legacy-bitrefill-key',
    ROZO_DELIVERED_REPORT_ENABLED: 'true',
    BITREFILL_ENABLED: 'true',
    BITREFILL_FUNDER_SEND_ENABLED: 'true',
    NATIVE_SOURCES: 'ETH@8453',
    ...overrides,
  }
  return { env: env as unknown as Env, kv }
}

async function frozenOrder(over: Record<string, unknown> = {}, factOver: Record<string, unknown> = {}, secret = ADMIN) {
  const facts = {
    invoiceId: INVOICE,
    address: RECEIVER,
    amountAtomic: 204_000_000n,
    expiresAt: inMinutes(40),
    feeBps: 100,
    serviceFeeAtomic: 2_040_000n,
    callerPaysAtomic: 206_040_000n,
    ...factOver,
  } as any
  const binding = await computeBitrefillBinding(secret, facts)
  return {
    id: ROZO_ID,
    appId: 'merchant_openrouter',
    orderId: PL,
    status: 'payment_payout_completed',
    destination: { chainId: '8453', receiverAddress: FUNDER_WALLET, tokenSymbol: 'USDC', amount: '206.04', txHash: TX },
    metadata: {
      provider: 'bitrefill',
      bitrefill: {
        v: 1,
        invoiceId: facts.invoiceId,
        address: facts.address,
        amountAtomic: facts.amountAtomic.toString(),
        expiresAt: facts.expiresAt,
        feeBps: facts.feeBps,
        serviceFeeAtomic: facts.serviceFeeAtomic.toString(),
        callerPaysAtomic: facts.callerPaysAtomic.toString(),
        binding,
      },
    },
    ...over,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('funder constants', () => {
  it('the binding module funder equals the webhook and create-invoice funder', () => {
    expect(BITREFILL_FUNDER).toBe(FUNDER_WALLET)
    expect(BITREFILL_FUNDER).toBe(SETTLEMENT_RECEIVER)
    expect(BITREFILL_FUNDER).toBe(STRIPE_FUNDER)
  })
  it('refuses the funder lookalike, the funder, zero and the USDC contract', () => {
    expect(bitrefillReceiverRefusal('0x235248a78985cb2166c2d5b43d527ea09fc31739')).toMatch(/blocked/)
    expect(bitrefillReceiverRefusal(FUNDER_WALLET.toLowerCase())).toMatch(/funder/)
    expect(bitrefillReceiverRefusal('0x0000000000000000000000000000000000000000')).toMatch(/blocked/)
    expect(bitrefillReceiverRefusal('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toMatch(/USDC/)
    expect(bitrefillReceiverRefusal('0x12')).toMatch(/not a/)
    expect(bitrefillReceiverRefusal(RECEIVER)).toBeNull()
  })
  it('authorizationState selector and per-invoice nonce', () => {
    expect(AUTHORIZATION_STATE_SELECTOR).toBe('0xe94a0102')
    expect(bitrefillNonce(INVOICE)).toBe(bitrefillNonce(INVOICE))
    expect(bitrefillNonce(INVOICE)).not.toBe(bitrefillNonce('ec9482de-1111-4222-8333-34a72b96b322'))
  })
})

// ── Create ──────────────────────────────────────────────────────────────────

describe('create (funder model)', () => {
  let created: any
  let posts: number
  let existing: Record<string, any>
  let lookupFails: boolean
  let seenKeys: Array<{ url: string; key: string | null }>

  beforeEach(() => {
    created = null
    posts = 0
    existing = {}
    lookupFails = false
    seenKeys = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seenKeys.push({ url: u, key: new Headers(init?.headers).get('X-API-Key') })
      if (u.includes('/payments/order/')) {
        if (lookupFails) return new Response('boom', { status: 500 })
        const [appId, orderId] = u.split('/payments/order/')[1].split('/')
        // Keyed by appId, or by "appId/orderId" to match one exact order id.
        const hit = existing[`${appId}/${decodeURIComponent(orderId)}`] ?? existing[appId]
        return hit
          ? new Response(JSON.stringify(hit), { status: 200 })
          : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
      }
      if (u.includes('/payment-api') && init?.method === 'POST') {
        posts++
        created = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({ id: ROZO_ID, expiresAt: inMinutes(60), source: { chainId: '8453', amount: '206.5' } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch)
  })

  function body(br: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
    return {
      provider: 'bitrefill',
      bitrefill: { invoiceId: INVOICE.toUpperCase(), address: RECEIVER, amount: '204', expiresAt: inMinutes(40), ...br },
      source: { chainId: '8453', tokenSymbol: 'USDC' },
      ...over,
    }
  }
  async function post(b: unknown, env = makeEnv().env) {
    const res = await handleCreateInvoice(
      new Request('https://mpp.test/v1/services/rozo-agent-api/create-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      }),
      env,
    )
    return { status: res.status, json: (await res.json()) as any }
  }

  it('creates one exactOut merchant_openrouter order to the funder priced invoice + 1%', async () => {
    const { status, json } = await post(body())
    expect(status).toBe(200)
    expect(posts).toBe(1)
    expect(created.appId).toBe('merchant_openrouter')
    expect(created.orderId).toBe(PL)
    expect(created.type).toBe('exactOut')
    expect(created.destination.receiverAddress).toBe(FUNDER_WALLET)
    expect(created.destination.amount).toBe('206.04')
    expect(created.display.merchantName).toBe('Bitrefill')
    expect(created.display.title).toBe('Pay Bitrefill $206.04 via Rozo')
    expect(created.metadata.provider).toBe('bitrefill')
    expect(created.metadata.bitrefill.address).toBe(RECEIVER)
    // The create request used the OpenRouter key, never the legacy one.
    const postKey = seenKeys.find((s) => !s.url.includes('/payments/order/'))?.key
    expect(postKey).toBe('openrouter-key')
    // The frozen facts verify under the admin secret.
    const facts = readBitrefillFacts({ metadata: created.metadata })!
    expect(await computeBitrefillBinding(ADMIN, facts)).toBe(facts.binding)
    expect(facts.amountAtomic).toBe(204_000_000n)
    expect(facts.callerPaysAtomic).toBe(206_040_000n)
    expect(json).toMatchObject({
      ok: true,
      provider: 'bitrefill',
      invoiceId: INVOICE,
      original: '204',
      serviceFee: '2.04',
      feeBps: 100,
      callerPays: '206.04',
      callerPaysAtomicUsdc: '206040000',
      destination: { address: RECEIVER, amount: '204' },
    })
  })

  it('fee rounds up to the cent (204.37 -> 2.05)', async () => {
    const { json } = await post(body({ amount: '204.37' }))
    expect(json.serviceFee).toBe('2.05')
    expect(json.callerPays).toBe('206.42')
  })

  it('accepts Lightning and an open native coin, refuses ZEC', async () => {
    let r = await post(body({}, { source: { chainId: 'lightning', tokenSymbol: 'BTC' } }))
    expect(r.status).toBe(200)
    expect(created.source).toEqual({ chainId: 'lightning', tokenSymbol: 'BTC' })
    r = await post(body({}, { source: { chainId: '8453', tokenSymbol: 'ETH' } }))
    expect(r.status).toBe(200)
    expect(created.source).toEqual({ chainId: '8453', tokenSymbol: 'ETH' })
    r = await post(body({}, { source: { chainId: '9133', tokenSymbol: 'ZEC' } }), makeEnv({ NATIVE_SOURCES: 'ZEC@9133' }).env)
    expect(r.status).toBe(400)
  })

  it('rejects non-UUID ids, blocked or funder receivers, over-cap amounts, bad expiry', async () => {
    for (const [br, code] of [
      [{ invoiceId: 'inv-abc123' }, 'INVALID_INPUT'],
      [{ address: '0x235248a78985cb2166c2d5b43d527ea09fc31739' }, 'BLOCKED_ADDRESS'],
      [{ address: FUNDER_WALLET }, 'BLOCKED_ADDRESS'],
      [{ address: '0x0000000000000000000000000000000000000000' }, 'BLOCKED_ADDRESS'],
      [{ address: 'nope' }, 'INVALID_ADDRESS'],
      [{ amount: '1050.000001' }, 'AMOUNT_OUT_OF_RANGE'],
      [{ expiresAt: inMinutes(4) }, 'INVOICE_EXPIRING'],
      [{ expiresAt: inMinutes(62) }, 'INVALID_INPUT'],
    ] as const) {
      const { status, json } = await post(body(br as any))
      expect(status, JSON.stringify(br)).toBe(400)
      expect(json.error, JSON.stringify(br)).toBe(code)
    }
    expect(posts).toBe(0)
  })

  it('one order per invoice: an order under either account is reported, never duplicated', async () => {
    existing = { merchant_openrouter: await frozenOrder({ status: 'payment_unpaid' }) }
    let r = await post(body())
    expect(r.status).toBe(409)
    expect(r.json.callerPays).toBe('206.04')
    existing = { wallet_bitrefillpay: { id: 'legacy-1', status: 'payment_unpaid' } }
    r = await post(body())
    expect(r.status).toBe(409)
    expect(r.json.rozoPaymentId).toBe('legacy-1')
    lookupFails = true
    r = await post(body())
    expect(r.status).toBe(502)
    expect(posts).toBe(0)
  })

  it('both modes check both accounts; legacy read is keyless without the legacy key', async () => {
    // Direct model must not open a second order when a funder order exists.
    existing = { merchant_openrouter: await frozenOrder({ status: 'payment_unpaid' }) }
    let r = await post(
      body({ invoiceId: INVOICE, expiresAt: inMinutes(15) }, { source: { chainId: '1500', tokenSymbol: 'USDC' } }),
      makeEnv({ BITREFILL_FUNDER_SEND_ENABLED: undefined }).env,
    )
    expect(r.status).toBe(409)
    // Funder model without the legacy key still reads the legacy account.
    existing = { wallet_bitrefillpay: { id: 'legacy-2', status: 'payment_unpaid' } }
    seenKeys = []
    r = await post(body(), makeEnv({ ROZO_BITREFILL_API_KEY: undefined }).env)
    expect(r.status).toBe(409)
    const legacyReads = seenKeys.filter((k) => k.url.includes('/payments/order/wallet_bitrefillpay/'))
    expect(legacyReads.length).toBeGreaterThan(0)
    expect(legacyReads.every((k) => k.key === null)).toBe(true)
    expect(posts).toBe(0)
  })

  it('finds an uppercase legacy order from a lowercase funder request (exact order id match)', async () => {
    existing = { [`wallet_bitrefillpay/bitrefill_${INVOICE.toUpperCase()}`]: { id: 'legacy-upper', status: 'payment_unpaid' } }
    const r = await post(body({ invoiceId: INVOICE }))
    expect(r.status).toBe(409)
    expect(r.json.rozoPaymentId).toBe('legacy-upper')
    expect(posts).toBe(0)
  })

  it('the account claim blocks a second model for the same invoice even before any order exists', async () => {
    const { env } = makeEnv({ BITREFILL_FUNDER_SEND_ENABLED: undefined })
    // A direct-model request claims the invoice (its create is in flight).
    let r = await post(body({ invoiceId: INVOICE, expiresAt: inMinutes(15) }, { source: { chainId: '1500', tokenSymbol: 'USDC' } }), env)
    expect(r.status).toBe(200)
    expect(posts).toBe(1)
    // The switch flips; the lookups see nothing yet (order not visible), the claim still refuses.
    ;(env as any).BITREFILL_FUNDER_SEND_ENABLED = 'true'
    existing = {}
    r = await post(body(), env)
    expect(r.status).toBe(409)
    expect(posts).toBe(1)
  })

  it('switch off keeps the legacy direct model untouched', async () => {
    const { status } = await post(
      body({ invoiceId: 'inv-abc123', expiresAt: inMinutes(15) }, { source: { chainId: '1500', tokenSymbol: 'USDC' } }),
      makeEnv({ BITREFILL_FUNDER_SEND_ENABLED: undefined }).env,
    )
    expect(status).toBe(200)
    expect(created.appId).toBe('wallet_bitrefillpay')
    expect(created.destination.receiverAddress).toBe(RECEIVER)
  })
})

// ── Settle ──────────────────────────────────────────────────────────────────

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

let seq = 0
async function signedEvent(type = 'payment_payout_completed', data: Record<string, unknown> = {}) {
  const evt = {
    event_id: `evt-br-${++seq}`,
    type,
    timestamp: new Date().toISOString(),
    data: { id: ROZO_ID, appId: 'merchant_openrouter', orderId: PL, status: type, ...data },
  }
  const body = JSON.stringify(evt)
  const ts = Date.now().toString()
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook', {
    method: 'POST',
    headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${await hmacHex(WEBHOOK_SECRET, `${ts}.${body}`)}`, 'content-type': 'application/json' },
    body,
  })
}

interface Up {
  order: any
  pay: Array<{ status: number; body: unknown } | 'throw'>
  authUsed: boolean | 'fail'
  balance: bigint
}

function stub(cfg: Partial<Up> = {}) {
  const up: Up = { order: null, pay: [{ status: 200, body: { provider: 'bitrefill', ok: true, status: 'paid', signed: true, transaction: TX, validBefore: 1 } }], authUsed: false, balance: 1_000_000_000n, ...cfg }
  const calls = { pay: 0, payBodies: [] as any[], delivered: 0, alerts: [] as string[], auth: 0, orderGet: 0 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        calls.alerts.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.includes('agentapi.rozo.ai/pay-invoice')) {
        const r = up.pay[Math.min(calls.pay, up.pay.length - 1)]
        calls.pay++
        calls.payBodies.push(JSON.parse(String(init?.body)))
        if (r === 'throw') throw new Error('timeout')
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      if (url.includes('intentapiv4.rozo.ai') && url.endsWith('/delivered')) {
        calls.delivered++
        return new Response('{}', { status: 200 })
      }
      if (url.includes('intentapiv4.rozo.ai')) {
        calls.orderGet++
        return up.order ? Response.json(up.order) : new Response('nf', { status: 404 })
      }
      const rpc = JSON.parse(String(init?.body ?? '{}'))
      const data: string = rpc?.params?.[0]?.data ?? ''
      if (data.startsWith(AUTHORIZATION_STATE_SELECTOR)) {
        calls.auth++
        if (up.authUsed === 'fail') return new Response('down', { status: 503 })
        return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + (up.authUsed ? '1' : '0').padStart(64, '0') })
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + up.balance.toString(16) })
    }),
  )
  return { up, calls }
}

async function run(req: Request, env: Env): Promise<any> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const p = handleRozoWebhook(req, env)
    let done = false
    p.then(() => (done = true), () => (done = true))
    for (let i = 0; i < 200 && !done; i++) {
      await new Promise((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    return (await p).json()
  } finally {
    vi.useRealTimers()
  }
}

function rec(kv: ReturnType<typeof makeKv>): FulfillmentRecord {
  return JSON.parse(kv._store.get(KEY) as string)
}

describe('settle (funder model)', () => {
  it('payout completed -> one pay-invoice call with ids and the frozen expectation -> paid + delivered', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    await run(await signedEvent(), env)
    expect(calls.pay).toBe(1)
    expect(calls.payBodies[0]).toEqual({
      provider: 'bitrefill',
      bitrefill_invoice_id: INVOICE,
      rozo_payment_id: ROZO_ID,
      expected: { address: RECEIVER, amount_atomic: '204000000' },
    })
    const r = rec(kv)
    expect(r.status).toBe('paid')
    expect(r.bitrefill?.nonce).toBe(bitrefillNonce(INVOICE))
    expect(calls.delivered).toBe(1)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toMatch(/^evt-br-/)
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
    // A replayed payout event never sends again.
    await run(await signedEvent(), env)
    expect(calls.pay).toBe(1)
  })

  it('payin completed alone never pays', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    await run(await signedEvent('payment_payin_completed'), env)
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
  })

  it('funder send switch off: records, alerts once, never pays', async () => {
    const { env, kv } = makeEnv({ BITREFILL_FUNDER_SEND_ENABLED: 'false' })
    const { calls } = stub({ order: await frozenOrder() })
    await run(await signedEvent(), env)
    await run(await signedEvent(), env)
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
    expect(calls.alerts.filter((a) => a.includes('switched off'))).toHaveLength(1)
  })

  it('legacy wallet_bitrefillpay orders are ignored (settled directly by Rozo)', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder({ appId: 'wallet_bitrefillpay' }) })
    const out = await run(await signedEvent('payment_payout_completed', { appId: 'wallet_bitrefillpay' }), env)
    expect(out.ignored).toMatch(/directly/)
    // Same when the event has no appId: the order is read first.
    const out2 = await run(await signedEvent('payment_payout_completed', { appId: undefined }), env)
    expect(out2.ignored).toMatch(/directly/)
    expect(calls.pay).toBe(0)
    expect(kv._store.has(KEY)).toBe(false)
  })

  it('order mismatches are refused before any send', async () => {
    const cases: Array<[string, any]> = [
      ['forged binding', await frozenOrder({}, {}, 'other-secret')],
      ['destination not funder', await frozenOrder({ destination: { chainId: '8453', receiverAddress: RECEIVER, tokenSymbol: 'USDC', amount: '206.04', txHash: TX } })],
      ['payout below invoice + fee', await frozenOrder({ destination: { chainId: '8453', receiverAddress: FUNDER_WALLET, tokenSymbol: 'USDC', amount: '206.03', txHash: TX } })],
      ['blocked receiver', await frozenOrder({}, { address: '0x235248a78985cb2166c2d5b43d527ea09fc31739' })],
      ['wrong fee', await frozenOrder({}, { feeBps: 50, serviceFeeAtomic: 1_020_000n, callerPaysAtomic: 205_020_000n })],
      ['no Bitrefill marker', { ...(await frozenOrder()), metadata: {} }],
    ]
    for (const [name, order] of cases) {
      const { env, kv } = makeEnv()
      const { calls } = stub({ order })
      await run(await signedEvent(), env)
      expect(calls.pay, name).toBe(0)
      expect(rec(kv).status, name).toBe('order_binding_failed')
    }
  })

  it('late payin (under 2 minutes left) goes to manual_review, never pays', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder({}, { expiresAt: inMinutes(1) }) })
    await run(await signedEvent(), env)
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('manual_review')
    expect(calls.alerts.some((a) => a.includes('after the invoice expired'))).toBe(true)
  })

  it('daily cap and short funder balance block before the gate', async () => {
    let { env, kv } = makeEnv({ BITREFILL_SETTLE_DAILY_CAP_USD: '100' })
    let s = stub({ order: await frozenOrder() })
    await run(await signedEvent(), env)
    expect(s.calls.pay).toBe(0)
    expect(rec(kv).status).toBe('failed_insufficient_balance')
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    ;({ env, kv } = makeEnv())
    s = stub({ order: await frozenOrder(), balance: 1_000_000n })
    await run(await signedEvent(), env)
    expect(s.calls.pay).toBe(0)
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
  })

  it('unknown outcomes (502 unknown, timeout, 500) keep the gate and ledger, never retry', async () => {
    for (const pay of [
      { status: 502, body: { provider: 'bitrefill', ok: false, status: 'unknown', signed: true, nonce: bitrefillNonce(INVOICE), validBefore: 123 } },
      'throw' as const,
      { status: 500, body: { error: 'boom' } },
    ]) {
      const { env, kv } = makeEnv()
      const { calls } = stub({ order: await frozenOrder(), pay: [pay] })
      await run(await signedEvent(), env)
      expect(calls.pay).toBe(1)
      const r = rec(kv)
      expect(r.status).toBe('pay_invoice_unknown')
      expect(await readCoinbaseExecGate(env, PL)).not.toBeNull()
      expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
      if (typeof pay === 'object' && pay.status === 502) expect(r.bitrefill?.validBefore).toBe(123)
    }
  })

  it('definite refusal releases the ledger; 503 signed:false is retried once; expired goes manual', async () => {
    let { env, kv } = makeEnv()
    let s = stub({ order: await frozenOrder(), pay: [{ status: 422, body: { provider: 'bitrefill', ok: false, code: 'PRE_SIGN_BINDING_MISMATCH', signed: false } }] })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('failed_pay_invoice')
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
    ;({ env, kv } = makeEnv())
    s = stub({
      order: await frozenOrder(),
      pay: [
        { status: 503, body: { provider: 'bitrefill', ok: false, code: 'RPC_UNAVAILABLE', signed: false } },
        { status: 200, body: { provider: 'bitrefill', ok: true, status: 'paid', signed: true, transaction: TX } },
      ],
    })
    await run(await signedEvent(), env)
    expect(s.calls.pay).toBe(2)
    expect(rec(kv).status).toBe('paid')
    ;({ env, kv } = makeEnv())
    s = stub({ order: await frozenOrder(), pay: [{ status: 409, body: { provider: 'bitrefill', ok: false, code: 'INVOICE_EXPIRED', signed: false } }] })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('manual_review')
  })

  it('a replay of the same event after the daily cap is raised pays', async () => {
    const { env, kv } = makeEnv({ BITREFILL_SETTLE_DAILY_CAP_USD: '100' })
    const { calls } = stub({ order: await frozenOrder() })
    const req = await signedEvent()
    const replay = req.clone()
    await run(req, env)
    expect(calls.pay).toBe(0)
    ;(env as any).BITREFILL_SETTLE_DAILY_CAP_USD = '5000'
    await run(replay, env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('a deferred payout (order not readable yet) is re-driven by the sweep, bounded', async () => {
    const { env, kv } = makeEnv()
    const s = stub({ order: null })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('payin_seen')
    s.up.order = await frozenOrder()
    await sweepBitrefillFulfillments(env)
    expect(s.calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
    // A permanently unreadable order stops after the bound and alerts once.
    const b = makeEnv()
    const s2 = stub({ order: null })
    await run(await signedEvent(), b.env)
    for (let i = 0; i < 13; i++) await sweepBitrefillFulfillments(b.env)
    expect(s2.calls.pay).toBe(0)
    expect(s2.calls.alerts.filter((a) => a.includes('could not be verified'))).toHaveLength(1)
  })

  it('exec gate store error: nothing sent, ledger released, record re-drivable, replay allowed', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    const gateMod = await import('../src/routes/coinbase-exec-gate')
    const spy = vi.spyOn(gateMod, 'acquireCoinbaseExecGate').mockRejectedValueOnce(new Error('DO down'))
    const req = await signedEvent()
    const replay = req.clone()
    await run(req, env)
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
    expect(rec(kv).events.some((e) => e.kind === 'payment_payout_completed')).toBe(true)
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
    spy.mockRestore()
    await run(replay, env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('classifies only provider-tagged bodies as definite', () => {
    expect(classifyBitrefillPayResult({ status: 422, body: { ok: false, signed: false } })).toBe('unknown')
    expect(classifyBitrefillPayResult({ status: 503, body: { provider: 'bitrefill', ok: false, signed: true } })).toBe('unknown')
    expect(classifyBitrefillPayResult({ status: 200, body: { provider: 'bitrefill', ok: true, status: 'already_paid' } })).toBe('paid')
    expect(classifyBitrefillPayResult({ status: 0, body: null })).toBe('unknown')
    expect(classifyBitrefillPayResult({ status: 402, body: { error: 'X-PAYMENT header required', signed: false } })).toBe('refused')
    expect(classifyBitrefillPayResult({ status: 500, body: { error: 'server misconfigured', signed: false } })).toBe('refused')
    expect(classifyBitrefillPayResult({ status: 500, body: { error: 'boom' } })).toBe('unknown')
  })
})

// ── Sweep ───────────────────────────────────────────────────────────────────

describe('sweep (unknown resolution)', () => {
  function seed(kv: ReturnType<typeof makeKv>, r: Partial<FulfillmentRecord>) {
    kv._store.set(KEY, JSON.stringify({
      status: 'pay_invoice_unknown', pl_id: PL, rozoPaymentId: ROZO_ID, invoiceAmountAtomic: '204000000',
      funderBalanceAtomic: null, paidAt: null, payingAt: new Date(Date.now() - 60_000).toISOString(),
      coinbaseResult: null, failureReason: null, webhookEventIds: [], events: [],
      bitrefill: { invoiceId: INVOICE, nonce: bitrefillNonce(INVOICE), address: RECEIVER, amountAtomic: '204000000', expiresAt: inMinutes(30), validBefore: null },
      ...r,
    }))
  }

  it('nonce used -> paid + delivered, never calls pay-invoice', async () => {
    const { env, kv } = makeEnv()
    seed(kv, {})
    const { calls } = stub({ authUsed: true })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(calls.delivered).toBe(1)
    expect(calls.pay).toBe(0)
  })

  it('nonce unused inside the window -> no change; after validBefore + grace -> manual_review', async () => {
    const { env, kv } = makeEnv()
    seed(kv, { bitrefill: { invoiceId: INVOICE, nonce: bitrefillNonce(INVOICE), address: RECEIVER, amountAtomic: '204000000', expiresAt: inMinutes(30), validBefore: Math.floor(Date.now() / 1000) + 60 } })
    const s = stub({ authUsed: false })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
    await sweepBitrefillFulfillments(env, Date.now() + 10 * 60_000)
    expect(rec(kv).status).toBe('manual_review')
    expect(s.calls.pay).toBe(0)
  })

  it('RPC unreadable -> no change', async () => {
    const { env, kv } = makeEnv()
    seed(kv, { payingAt: new Date(Date.now() - 3_600_000).toISOString() })
    stub({ authUsed: 'fail' })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('stale paying is resolved the same way; fresh paying is left alone', async () => {
    const { env, kv } = makeEnv()
    seed(kv, { status: 'paying', payingAt: new Date(Date.now() - 60_000).toISOString() })
    const s = stub({ authUsed: true })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paying')
    await sweepBitrefillFulfillments(env, Date.now() + 11 * 60_000)
    expect(rec(kv).status).toBe('paid')
    expect(s.calls.pay).toBe(0)
  })

  it('delivered report give-up alerts once', async () => {
    const { env, kv } = makeEnv()
    seed(kv, { status: 'paid', paidAt: new Date().toISOString() })
    const s = stub({ authUsed: true })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        s.calls.alerts.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      return new Response('{}', { status: 500 })
    }))
    for (let i = 0; i < 8; i++) await sweepBitrefillFulfillments(env)
    expect(rec(kv).deliveredReportAttempts).toBe(5)
    expect(s.calls.alerts.filter((a) => a.includes('delivery report'))).toHaveLength(1)
  })

  it('deadline without validBefore is payingAt + 300 s + the call timeout', () => {
    const payingAt = '2026-11-11T10:00:00.000Z'
    const d = authorizationDeadlineMs({ payingAt } as FulfillmentRecord)
    expect(d).toBe(Date.parse(payingAt) + 360_000)
  })
})
