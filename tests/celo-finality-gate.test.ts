/**
 * Celo (source chain 42220) settlement gate (src/routes/celo-finality.ts).
 *
 * For a Celo-sourced order the funder must never pay a Coinbase invoice
 * (webhook payin/payout, checkout backlog replay, manual /admin/pay-invoice)
 * before the payin block is finalized with the same hash on two RPCs and the
 * Transfer matches the order's receive address, token and amount; and only
 * while CELO_FULFILLMENT_PAUSED is exactly "off". Other chains: unchanged.
 *
 * Design: ainative docs/design/20261122-celo-stablecoins-payin-implementation.zh.md
 * §2.3, §4 P2, §9.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { handleRozoWebhook, type FulfillmentRecord } from '../src/routes/webhook'
import { listPausedDeliveries, recordPausedDelivery } from '../src/routes/checkout-control'
import { replayPausedDeliveries } from '../src/routes/checkout-control-admin'
import { handleAdminPayInvoice } from '../src/routes/pay-invoice-admin'
import { handleStripeWebhookEvent } from '../src/routes/stripe-fulfillment'
import {
  CELO_TOKENS,
  celoFulfillmentPaused,
  celoPayinTerms,
  isCeloChain,
  parseTokenAtomic,
} from '../src/routes/celo-finality'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { boundCoinbaseLink, boundRozoOrder } from './helpers/coinbase-binding'

const WEBHOOK_SECRET = 'test-webhook-secret'
const ADMIN_SECRET = 'test-admin-secret'
const PL = 'pl_testCeloGate1'
const ROZO_ID = '77777777-3333-4444-5555-666666666666'
const KEY = `invoice-fulfillment:${PL}`

const FORNO = 'https://forno.celo.org'
const CELO2 = 'https://celo-mainnet.g.alchemy.test/v2/test'
const CELO_USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'
const CELO_USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'
const RECEIVER = '0x1111111111111111111111111111111111111111'
const PAYER = '0x2222222222222222222222222222222222222222'
const TX = '0x' + 'ab'.repeat(32)
const BLOCK = 0x100
const HASH = '0x' + 'cd'.repeat(32)
const OTHER_HASH = '0x' + 'ef'.repeat(32)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16)

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signed(evt: unknown): Promise<Request> {
  const body = JSON.stringify(evt)
  const ts = Date.now().toString()
  const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${ts}.${body}`)
  return new Request('https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook', {
    method: 'POST',
    headers: { 'x-rozo-timestamp': ts, 'x-rozo-signature': `sha256=${sig}`, 'content-type': 'application/json' },
    body,
  })
}

function makeKv() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKv()
  const env: Record<string, unknown> = {
    MPP_STORE: kv,
    ATOMIC_STORE: makeAtomicStoreMock(),
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: ADMIN_SECRET,
    BASE_RPC_URL: 'https://rpc.test/primary',
    DINGTALK_ACCESS_TOKEN: 'dt-test-token',
    ROZO_INTENTS_API_KEY: 'test-rozo-key',
    ROZO_DELIVERED_REPORT_ENABLED: 'false',
    CELO_FULFILLMENT_PAUSED: 'off',
    CELO_RPC_URL: CELO2,
    ...overrides,
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  return { env: env as unknown as Env, kv }
}

interface ChainView {
  receipt?: Record<string, unknown> | null
  receiptError?: boolean
  finalized?: number | null // null = no finalized tag / error
  blockHash?: string
}

interface Up {
  order: Record<string, unknown> | null
  rpc1: ChainView
  rpc2: ChainView
  payStatus: number
}

function transferLog(opts: { token?: string; to?: string; amount?: bigint } = {}) {
  return {
    address: opts.token ?? CELO_USDT,
    topics: [TRANSFER, pad(PAYER), pad(opts.to ?? RECEIVER)],
    data: pad(hex(opts.amount ?? 1_000_000n)),
    removed: false,
  }
}

function celoReceipt(over: Record<string, unknown> = {}, log = transferLog()) {
  return {
    transactionHash: TX,
    status: '0x1',
    blockNumber: hex(BLOCK),
    blockHash: HASH,
    logs: [log],
    ...over,
  }
}

function celoOrder(over: Record<string, unknown> = {}, sourceOver: Record<string, unknown> = {}) {
  return boundRozoOrder(ROZO_ID, PL, {
    status: 'payment_payin_completed',
    source: {
      amount: '1.00',
      chainId: '42220',
      tokenSymbol: 'USDT',
      tokenAddress: CELO_USDT,
      receiverAddress: RECEIVER,
      txHash: TX,
      ...sourceOver,
    },
    ...over,
  })
}

const FINAL_OK: ChainView = { receipt: celoReceipt(), finalized: BLOCK + 10, blockHash: HASH }
const NOT_FINAL: ChainView = { receipt: celoReceipt(), finalized: BLOCK - 1, blockHash: HASH }

function stub(cfg: Partial<Up> = {}) {
  const up: Up = { order: celoOrder(), rpc1: FINAL_OK, rpc2: FINAL_OK, payStatus: 200, ...cfg }
  const calls = { pay: 0, celoRpc: 0, orderGet: 0, alerts: [] as string[] }
  const chainAnswer = (view: ChainView, body: any) => {
    calls.celoRpc++
    const method = body.method
    if (method === 'eth_getTransactionReceipt') {
      if (view.receiptError) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } })
      return Response.json({ jsonrpc: '2.0', id: 1, result: view.receipt ?? null })
    }
    if (method === 'eth_getBlockByNumber' && body.params[0] === 'finalized') {
      if (view.finalized === null || view.finalized === undefined) {
        return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'finalized not supported' } })
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: { number: hex(view.finalized), hash: OTHER_HASH } })
    }
    if (method === 'eth_getBlockByNumber') {
      return Response.json({ jsonrpc: '2.0', id: 1, result: { number: body.params[0], hash: view.blockHash ?? HASH } })
    }
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown' } })
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith(FORNO)) return chainAnswer(up.rpc1, JSON.parse(String(init?.body)))
      if (url.startsWith(CELO2)) return chainAnswer(up.rpc2, JSON.parse(String(init?.body)))
      if (url.includes('oapi.dingtalk.com')) {
        calls.alerts.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.includes('agentapi.rozo.ai/pay-invoice')) {
        calls.pay++
        return new Response(
          JSON.stringify({ success: true, coinbase: { protocolVersion: 'v1', captured: true, link: { usageCount: 1, maxUsage: 1 } } }),
          { status: up.payStatus },
        )
      }
      if (url.includes('payments.coinbase.com/next-api/')) return Response.json(boundCoinbaseLink(PL))
      if (url.includes('intentapiv4.rozo.ai')) {
        calls.orderGet++
        return up.order ? Response.json(up.order) : new Response('nf', { status: 404 })
      }
      // Base funder balance: always ample.
      return Response.json({ jsonrpc: '2.0', id: 1, result: hex(100_000_000n) })
    }),
  )
  return { up, calls }
}

let seq = 0
function event(type = 'payment_payin_completed', source: Record<string, unknown> = {}) {
  return {
    event_id: `evt-celo-${++seq}`,
    type,
    timestamp: new Date().toISOString(),
    data: {
      id: ROZO_ID,
      appId: 'merchant_openrouter',
      orderId: PL,
      status: type,
      source: { amount: '1.00', chainId: '42220', txHash: TX, ...source },
      destination: { amount: '1.00', chainId: '8453', txHash: null },
    },
  }
}

function rec(kv: ReturnType<typeof makeKv>): FulfillmentRecord {
  return JSON.parse(kv._store.get(KEY)!)
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Webhook path ────────────────────────────────────────────────────────────

describe('Celo gate: webhook payin_completed', () => {
  it('funder balance ample, payin NOT finalized: zero pay-invoice calls, event kept for a retry', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    const evt = event()
    const res = (await (await handleRozoWebhook(await signed(evt), env)).json()) as any
    expect(calls.pay).toBe(0)
    expect(res.deferred).toBe('celo_finality')
    expect(res.reason).toMatch(/not finalized/)
    const r = rec(kv)
    expect(r.status).toBe('payin_seen')
    expect(r.sourceChainId).toBe('42220')
    expect(r.events.some((e) => e.kind === 'celo_finality_deferred')).toBe(true)
    // Dedup marker forgotten: a resend / the payout webhook is processed again.
    expect(kv._store.has(`webhook-event:${evt.event_id}`)).toBe(false)
    expect(calls.alerts).toHaveLength(0)
  })

  it('finalized on both RPCs with matching hash and Transfer: pays once', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    expect(calls.pay).toBe(1)
    const r = rec(kv)
    expect(r.status).toBe('paid')
    expect(r.events.some((e) => e.kind === 'celo_finality_verified')).toBe(true)
  })

  it('not finalized, then the later payout webhook after finality pays exactly once', async () => {
    const { up, calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    expect(calls.pay).toBe(0)
    up.rpc1 = FINAL_OK
    up.rpc2 = FINAL_OK
    up.order = celoOrder({ status: 'payment_payout_completed' })
    await handleRozoWebhook(await signed(event('payment_payout_completed')), env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('finalized only on one RPC: not paid', async () => {
    const { calls } = stub({ rpc2: NOT_FINAL })
    const { env } = makeEnv()
    await handleRozoWebhook(await signed(event()), env)
    expect(calls.pay).toBe(0)
  })

  const unreadable: Array<[string, Partial<Up>, Record<string, unknown>]> = [
    ['finalized tag unsupported on rpc 1', { rpc1: { ...FINAL_OK, finalized: null } }, {}],
    ['finalized tag unsupported on rpc 2', { rpc2: { ...FINAL_OK, finalized: null } }, {}],
    ['receipt read error', { rpc2: { ...FINAL_OK, receiptError: true } }, {}],
    ['receipt not found', { rpc1: { ...FINAL_OK, receipt: null } }, {}],
    ['payin tx reverted', { rpc1: { ...FINAL_OK, receipt: celoReceipt({ status: '0x0' }) } }, {}],
    ['second RPC not configured', {}, { CELO_RPC_URL: undefined }],
    ['second RPC is forno again', {}, { CELO_RPC_URL: 'https://forno.celo.org/other' }],
    ['Rozo order has no payin tx hash', { order: celoOrder({}, { txHash: null }) }, {}],
  ]
  for (const [name, up, envOver] of unreadable) {
    it(`fails closed without alert: ${name}`, async () => {
      const { calls } = stub(up)
      const { env, kv } = makeEnv(envOver)
      const evt = event('payment_payin_completed', name.includes('no payin tx') ? { txHash: null } : {})
      const res = (await (await handleRozoWebhook(await signed(evt), env)).json()) as any
      expect(calls.pay).toBe(0)
      expect(res.deferred).toBe('celo_finality')
      expect(rec(kv).status).toBe('payin_seen')
      expect(calls.alerts).toHaveLength(0)
    })
  }

  const mismatches: Array<[string, Partial<Up>, Record<string, unknown>]> = [
    ['canonical block hash differs on rpc 2', { rpc2: { ...FINAL_OK, blockHash: OTHER_HASH } }, {}],
    ['canonical block hash differs on rpc 1', { rpc1: { ...FINAL_OK, blockHash: OTHER_HASH } }, {}],
    ['receipt block hash differs between RPCs', { rpc2: { ...FINAL_OK, receipt: celoReceipt({ blockHash: OTHER_HASH }) } }, {}],
    [
      'Transfer to another address',
      { rpc1: { ...FINAL_OK, receipt: celoReceipt({}, transferLog({ to: PAYER })) }, rpc2: { ...FINAL_OK, receipt: celoReceipt({}, transferLog({ to: PAYER })) } },
      {},
    ],
    [
      'Transfer of another token',
      { rpc1: { ...FINAL_OK, receipt: celoReceipt({}, transferLog({ token: CELO_USDC })) }, rpc2: { ...FINAL_OK, receipt: celoReceipt({}, transferLog({ token: CELO_USDC })) } },
      {},
    ],
    [
      'Transfer amount short by 1 atomic unit',
      { rpc1: { ...FINAL_OK, receipt: celoReceipt({}, transferLog({ amount: 999_999n })) }, rpc2: { ...FINAL_OK, receipt: celoReceipt({}, transferLog({ amount: 999_999n })) } },
      {},
    ],
    ['event tx hash differs from the order', {}, { txHash: '0x' + '12'.repeat(32) }],
    ['order token is not Celo USDT/USDC', { order: celoOrder({}, { tokenAddress: '0x3333333333333333333333333333333333333333' }) }, {}],
  ]
  for (const [name, up, evSource] of mismatches) {
    it(`refuses and alerts: ${name}`, async () => {
      const { calls } = stub(up)
      const { env, kv } = makeEnv()
      const res = (await (await handleRozoWebhook(await signed(event('payment_payin_completed', evSource)), env)).json()) as any
      expect(calls.pay).toBe(0)
      expect(res.deferred).toBe('celo_finality')
      expect(rec(kv).status).toBe('payin_seen')
      expect(calls.alerts.some((a) => a.includes('Celo payin NOT paid'))).toBe(true)
    })
  }

  for (const value of [undefined, 'on', 'OFF', 'off ', '', 'false']) {
    it(`pause switch ${JSON.stringify(value)}: not paid, no Celo reads`, async () => {
      const { calls } = stub()
      const { env, kv } = makeEnv({ CELO_FULFILLMENT_PAUSED: value })
      const res = (await (await handleRozoWebhook(await signed(event()), env)).json()) as any
      expect(calls.pay).toBe(0)
      expect(calls.celoRpc).toBe(0)
      expect(res.reason).toBe('celo_fulfillment_paused')
      expect(rec(kv).status).toBe('payin_seen')
    })
  }

  it('payout_completed is gated the same way', async () => {
    const { calls } = stub({ order: celoOrder({ status: 'payment_payout_completed' }), rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    const res = (await (await handleRozoWebhook(await signed(event('payment_payout_completed')), env)).json()) as any
    expect(calls.pay).toBe(0)
    expect(res.deferred).toBe('celo_finality')
    expect(rec(kv).status).toBe('payin_seen')
  })

  it('event claims Base but the Rozo order is Celo: the order wins, gated', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env } = makeEnv()
    await handleRozoWebhook(await signed(event('payment_payin_completed', { chainId: '8453' })), env)
    expect(calls.pay).toBe(0)
  })

  it('event claims Celo but the Rozo order is Base: refused with an alert', async () => {
    const { calls } = stub({ order: boundRozoOrder(ROZO_ID, PL, { status: 'payment_payin_completed' }) })
    const { env } = makeEnv()
    const res = (await (await handleRozoWebhook(await signed(event()), env)).json()) as any
    expect(calls.pay).toBe(0)
    expect(res.reason).toMatch(/not Celo/)
    expect(calls.alerts.length).toBeGreaterThan(0)
  })
})

// ── Other chains unchanged ──────────────────────────────────────────────────

describe('Celo gate: other source chains', () => {
  it('a record marked Celo by an earlier sibling event does not block a Base settling order', async () => {
    const { calls } = stub({ order: boundRozoOrder(ROZO_ID, PL) })
    const { env, kv } = makeEnv({ CELO_FULFILLMENT_PAUSED: 'on' })
    seedRecord(kv, { sourceChainId: '42220', rozoPaymentId: null })
    const evt = event('payment_payout_completed', { chainId: '8453', txHash: null })
    await handleRozoWebhook(await signed(evt), env)
    expect(calls.pay).toBe(1)
    expect(calls.celoRpc).toBe(0)
    expect(rec(kv).status).toBe('paid')
    expect(rec(kv).sourceChainId).toBe('8453')
  })

  it('a Base order pays as before, with no Celo reads, even with the Celo switch missing', async () => {
    const { calls } = stub({ order: boundRozoOrder(ROZO_ID, PL) })
    const { env, kv } = makeEnv({ CELO_FULFILLMENT_PAUSED: undefined, CELO_RPC_URL: undefined })
    const res = (await (
      await handleRozoWebhook(
        await signed({ ...event('payment_payout_completed'), data: { ...event('payment_payout_completed').data, source: { amount: '1.00', chainId: '8453', txHash: null } } }),
        env,
      )
    ).json()) as any
    expect(res.deferred).toBeUndefined()
    expect(calls.pay).toBe(1)
    expect(calls.celoRpc).toBe(0)
    expect(rec(kv).status).toBe('paid')
  })
})

// ── Replay path ─────────────────────────────────────────────────────────────

describe('Celo gate: checkout backlog replay', () => {
  it('not finalized: replay sends nothing and keeps the entry; finalized: replay pays once', async () => {
    const { up, calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env } = makeEnv()
    await recordPausedDelivery(env, { provider: 'coinbase', ref: PL, rozoPaymentId: ROZO_ID, eventType: 'payment_payin_completed' })
    let out = await replayPausedDeliveries(env, 'req-celo-1')
    expect(out[0].outcome).toBe('not_ready')
    expect(calls.pay).toBe(0)
    expect(await listPausedDeliveries(env)).toHaveLength(1)

    up.rpc1 = FINAL_OK
    up.rpc2 = FINAL_OK
    out = await replayPausedDeliveries(env, 'req-celo-2')
    expect(out[0].outcome).toBe('settled_path_ran')
    expect(calls.pay).toBe(1)
    expect(await listPausedDeliveries(env)).toHaveLength(0)
  })

  it('pause switch on: replay sends nothing', async () => {
    const { calls } = stub()
    const { env } = makeEnv({ CELO_FULFILLMENT_PAUSED: 'on' })
    await recordPausedDelivery(env, { provider: 'coinbase', ref: PL, rozoPaymentId: ROZO_ID, eventType: 'payment_payin_completed' })
    const out = await replayPausedDeliveries(env, 'req-celo-3')
    expect(out[0].outcome).toBe('not_ready')
    expect(calls.pay).toBe(0)
  })
})

// ── Manual recovery path ────────────────────────────────────────────────────

function adminPay(body: unknown = { payment_id: PL }): Request {
  return new Request('https://apiserver.mpprouter.dev/admin/pay-invoice', {
    method: 'POST',
    headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function seedRecord(kv: ReturnType<typeof makeKv>, over: Partial<FulfillmentRecord> = {}) {
  const r: FulfillmentRecord = {
    status: 'payin_seen',
    pl_id: PL,
    rozoPaymentId: ROZO_ID,
    invoiceAmountAtomic: null,
    funderBalanceAtomic: null,
    paidAt: null,
    coinbaseResult: null,
    failureReason: null,
    webhookEventIds: [],
    events: [],
    ...over,
  }
  kv._store.set(KEY, JSON.stringify(r))
}

describe('Celo gate: manual /admin/pay-invoice', () => {
  it('Celo record, payin not finalized: 409, nothing sent', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    seedRecord(kv, { sourceChainId: '42220' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).code).toBe('CELO_NOT_VERIFIED')
    expect(calls.pay).toBe(0)
  })

  it('Celo record, pause switch on: 409, nothing sent', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv({ CELO_FULFILLMENT_PAUSED: 'on' })
    seedRecord(kv, { sourceChainId: '42220' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('old record with no source chain: reads the order, Celo not finalized: 409', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    seedRecord(kv)
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('old record with no source chain and the order unreadable: 409, nothing sent', async () => {
    const { calls } = stub({ order: null })
    const { env, kv } = makeEnv()
    seedRecord(kv)
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('Celo record, finalized: the manual pay goes out once', async () => {
    const { calls } = stub()
    const { env, kv } = makeEnv()
    seedRecord(kv, { sourceChainId: '42220' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(200)
    expect(calls.pay).toBe(1)
  })

  it('no record yet: scans the link orders; a paid Celo order not finalized blocks the pay', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env } = makeEnv()
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('no record yet and the link orders unreadable: 409, nothing sent', async () => {
    const { calls } = stub({ order: null })
    const { env } = makeEnv()
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('an unpaid / started Celo order is not exempt: pause on blocks the manual pay', async () => {
    for (const status of ['payment_unpaid', 'payment_started', undefined]) {
      const { calls } = stub({ order: celoOrder({ status }, { txHash: null }) })
      const { env } = makeEnv({ CELO_FULFILLMENT_PAUSED: 'on' })
      const res = await handleAdminPayInvoice(adminPay(), env)
      expect(res.status).toBe(409)
      expect(calls.pay).toBe(0)
      vi.unstubAllGlobals()
    }
  })

  it('an expired Celo order with no payin does not block the manual pay', async () => {
    const { calls } = stub({ order: celoOrder({ status: 'payment_expired' }, { txHash: null }) })
    const { env } = makeEnv({ CELO_FULFILLMENT_PAUSED: 'on' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(200)
    expect(calls.pay).toBe(1)
  })

  it('record names a Base order, but a Celo sibling slot exists: the sibling is gated', async () => {
    const baseOrder = boundRozoOrder(ROZO_ID, PL, { status: 'payment_expired' })
    const celoSibling = celoOrder({ id: 'celo-sibling' })
    const { calls } = stub({ order: baseOrder, rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    // By-id reads answer the Base order; slot scans answer the Celo sibling.
    const inner = (globalThis.fetch as any).getMockImplementation()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('intentapiv4.rozo.ai') && url.includes('/payments/order/')) return Response.json(celoSibling)
        return inner(input, init)
      }),
    )
    const { env, kv } = makeEnv()
    seedRecord(kv, { sourceChainId: '8453' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('a stale Base chain on the record does not bypass a Celo order', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    seedRecord(kv, { sourceChainId: '8453' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(409)
    expect(calls.pay).toBe(0)
  })

  it('a stale Celo chain on the record does not block a Base order', async () => {
    const { calls } = stub({ order: boundRozoOrder(ROZO_ID, PL) })
    const { env, kv } = makeEnv({ CELO_FULFILLMENT_PAUSED: 'on' })
    seedRecord(kv, { sourceChainId: '42220' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(200)
    expect(calls.pay).toBe(1)
  })

  it('Base record: unchanged, no Celo reads', async () => {
    const { calls } = stub({ order: boundRozoOrder(ROZO_ID, PL) })
    const { env, kv } = makeEnv({ CELO_FULFILLMENT_PAUSED: undefined })
    seedRecord(kv, { sourceChainId: '8453' })
    const res = await handleAdminPayInvoice(adminPay(), env)
    expect(res.status).toBe(200)
    expect(calls.pay).toBe(1)
    expect(calls.celoRpc).toBe(0)
  })
})

// ── Stripe settle entry ─────────────────────────────────────────────────────

describe('Celo gate: Stripe settle entry', () => {
  it('Celo-sourced Stripe event is deferred before anything is claimed or sent', async () => {
    const { calls } = stub({ rpc1: NOT_FINAL, rpc2: NOT_FINAL })
    const { env, kv } = makeEnv()
    const summary = await handleStripeWebhookEvent(
      env,
      {
        eventId: 'evt-stripe-celo',
        eventType: 'payment_payin_completed',
        orderId: 'stripe_crypto_cpis_celoTest',
        rozoPaymentId: ROZO_ID,
        invoiceAmountStr: '1.00',
        sourceChainId: '42220',
        sourceTxHash: TX,
      },
      new Date(),
    )
    expect(summary.deferred).toBe('celo_finality')
    expect(calls.pay).toBe(0)
    expect([...kv._store.keys()].some((k) => k.startsWith('invoice-fulfillment:'))).toBe(false)
  })
})

// ── Units ───────────────────────────────────────────────────────────────────

describe('Celo gate helpers', () => {
  it('pause switch is fail-closed', () => {
    expect(celoFulfillmentPaused({ CELO_FULFILLMENT_PAUSED: 'off' })).toBe(false)
    for (const v of [undefined, 'on', 'OFF', ' off', 'no', '0']) {
      expect(celoFulfillmentPaused({ CELO_FULFILLMENT_PAUSED: v })).toBe(true)
    }
  })

  it('recognises Celo chain spellings only', () => {
    for (const v of ['42220', 42220, 'eip155:42220', 'celo', 'CELO']) expect(isCeloChain(v)).toBe(true)
    for (const v of ['8453', '1', null, undefined, '', '422200']) expect(isCeloChain(v)).toBe(false)
  })

  it('parses token amounts exactly', () => {
    expect(parseTokenAtomic('1.00', 6)).toBe(1_000_000n)
    expect(parseTokenAtomic('0.000001', 6)).toBe(1n)
    expect(parseTokenAtomic('1.0000000', 6)).toBe(1_000_000n)
    expect(parseTokenAtomic('1.0000001', 6)).toBeNull()
    expect(parseTokenAtomic('-1', 6)).toBeNull()
    expect(parseTokenAtomic('abc', 6)).toBeNull()
  })

  it('maps token symbol when the address is absent', () => {
    const t = celoPayinTerms({ source: { txHash: TX, tokenSymbol: 'USDC', receiverAddress: RECEIVER, amount: '2' } }, null)
    expect(t.ok && t.token).toBe(CELO_TOKENS.USDC)
  })
})
