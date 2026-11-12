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
  BITREFILL_SWEEP_MAX_RECORDS,
  authorizationDeadlineMs,
  classifyBitrefillPayResult,
  readAuthorizationQuorum,
  sweepBitrefillFulfillments,
} from '../src/routes/bitrefill-settle'
import { bitrefillInvoiceAllowed, parseBitrefillInvoiceAllowlist } from '../src/routes/bitrefill-invoice'
import { acquireCoinbaseExecGate, readCoinbaseExecGate } from '../src/routes/coinbase-exec-gate'
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
const OTHER_INVOICE = 'ec9482de-1111-4222-8333-34a72b96b322'
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
    BITREFILL_FUNDER_ALLOWED_INVOICES: '*',
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
  CHAIN.blockSec = 2
  CHAIN.brokenTimestamps = false
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

  it('allowlist (F1): a listed invoice creates; non-listed, unset, empty or malformed = 403 before the claim, no direct fallback', async () => {
    let r = await post(body(), makeEnv({ BITREFILL_FUNDER_ALLOWED_INVOICES: ` ${INVOICE} , ${OTHER_INVOICE}` }).env)
    expect(r.status).toBe(200)
    expect(posts).toBe(1)
    expect(created.appId).toBe('merchant_openrouter')
    const lists = [undefined, '', '   ', OTHER_INVOICE, `*,${INVOICE}`, INVOICE.toUpperCase(), `${INVOICE},`, 'not-a-uuid']
    for (const list of lists) {
      const { env } = makeEnv({ BITREFILL_FUNDER_ALLOWED_INVOICES: list })
      seenKeys = []
      r = await post(body(), env)
      expect(r.status, String(list)).toBe(403)
      expect(r.json.error, String(list)).toBe('BITREFILL_INVOICE_NOT_ALLOWED')
      // No lookup and no create happened.
      expect(seenKeys, String(list)).toHaveLength(0)
      // No account claim was taken: once the switch is off, the direct model
      // can still create this invoice (a taken claim would answer 409).
      ;(env as any).BITREFILL_FUNDER_SEND_ENABLED = undefined
      const d = await post(body({ invoiceId: INVOICE, expiresAt: inMinutes(15) }, { source: { chainId: '1500', tokenSymbol: 'USDC' } }), env)
      expect(d.status, String(list)).toBe(200)
      expect(created.appId).toBe('wallet_bitrefillpay')
    }
    expect(posts).toBe(1 + lists.length)
  })

  it('allowlist (F1) also gates the resume answer: no 409 with the deposit for a non-listed invoice', async () => {
    existing = { merchant_openrouter: await frozenOrder({ status: 'payment_unpaid', source: { chainId: '8453', receiverAddress: '0x' + '77'.repeat(20) } }) }
    let r = await post(body(), makeEnv({ BITREFILL_FUNDER_ALLOWED_INVOICES: '' }).env)
    expect(r.status).toBe(403)
    expect(r.json.source).toBeUndefined()
    expect(r.json.rozoPaymentId).toBeUndefined()
    r = await post(body(), makeEnv({ BITREFILL_FUNDER_ALLOWED_INVOICES: INVOICE }).env)
    expect(r.status).toBe(409)
    expect(r.json.source).toBeDefined()
    expect(posts).toBe(0)
  })

  it('direct model (R11) uses the same 17-entry refusal set: the funder lookalike is refused, codes unchanged', async () => {
    const env = makeEnv({ BITREFILL_FUNDER_SEND_ENABLED: undefined }).env
    for (const [address, code] of [
      ['0x235248a78985cb2166c2d5b43d527ea09fc31739', 'BLOCKED_ADDRESS'],
      ['0x4374b2072ff9bc5c0e263CaE7866a41a4C601d29', 'BLOCKED_ADDRESS'],
      ['0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897', 'BLOCKED_ADDRESS'],
      ['nope', 'INVALID_ADDRESS'],
    ] as const) {
      const r = await post(body({ invoiceId: 'inv-abc123', address, expiresAt: inMinutes(15) }, { source: { chainId: '1500', tokenSymbol: 'USDC' } }), env)
      expect(r.status, address).toBe(400)
      expect(r.json.error, address).toBe(code)
    }
    expect(posts).toBe(0)
    // A valid address still creates.
    const ok = await post(body({ invoiceId: 'inv-abc123', expiresAt: inMinutes(15) }, { source: { chainId: '1500', tokenSymbol: 'USDC' } }), env)
    expect(ok.status).toBe(200)
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

// Synthesized chain answers for the authorization-bound transfer proof.
// tx hash = the nonce topic (one transaction per nonce), amount 204 USDC to RECEIVER.
type ProofMode = 'prove' | 'noTransfer' | 'none' | 'fail'
const AU_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
const TR_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const pad32 = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const authLog = (nonce: string, tx: string) => ({ address: USDC_ADDR, topics: [AU_TOPIC, pad32(FUNDER_WALLET), nonce.toLowerCase()], data: '0x', transactionHash: tx, removed: false })
const transferLog = (amount = 204_000_000n, to = RECEIVER) => ({ address: USDC_ADDR, topics: [TR_TOPIC, pad32(FUNDER_WALLET), pad32(to)], data: '0x' + amount.toString(16).padStart(64, '0'), removed: false })
// Synthetic chain clock: latest block 0x1000000 at "now", CHAIN.blockSec per block.
const CHAIN = { latest: 0x1000000, blockSec: 2, brokenTimestamps: false }
function proofAnswer(mode: ProofMode, method: string, params: any[]): Response | null {
  if (!['eth_getLogs', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber'].includes(method)) return null
  if (method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + CHAIN.latest.toString(16) })
  if (method === 'eth_getBlockByNumber') {
    const n = Number(BigInt(String(params?.[0])))
    const nowSec = Math.floor(Date.now() / 1000)
    const ts = CHAIN.brokenTimestamps ? nowSec : nowSec - (CHAIN.latest - n) * CHAIN.blockSec
    return Response.json({ jsonrpc: '2.0', id: 1, result: { number: '0x' + n.toString(16), timestamp: '0x' + ts.toString(16) } })
  }
  if (mode === 'fail') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit' } })
  if (method === 'eth_getLogs') {
    const nonce = String(params?.[0]?.topics?.[2] ?? '')
    return Response.json({ jsonrpc: '2.0', id: 1, result: mode === 'none' ? [] : [authLog(nonce, nonce)] })
  }
  const tx = String(params?.[0] ?? '')
  if (mode === 'none') return Response.json({ jsonrpc: '2.0', id: 1, result: null })
  const logs = mode === 'prove' ? [authLog(tx, tx), transferLog()] : [authLog(tx, tx), transferLog(204_000_000n, '0x' + '99'.repeat(20))]
  return Response.json({ jsonrpc: '2.0', id: 1, result: { status: '0x1', transactionHash: tx, logs } })
}

interface Up {
  order: any
  pay: Array<{ status: number; body: unknown } | 'throw'>
  authUsed: boolean | 'fail'
  balance: bigint
  proof?: ProofMode
}

function stub(cfg: Partial<Up> = {}) {
  const up: Up = { order: null, pay: [{ status: 200, body: { provider: 'bitrefill', ok: true, status: 'paid', signed: true, transaction: TX, validBefore: 1 } }], authUsed: false, balance: 1_000_000_000n, ...cfg }
  const calls = { pay: 0, payBodies: [] as any[], delivered: 0, alerts: [] as string[], auth: 0, orderGet: 0, log: [] as string[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        calls.alerts.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.includes('agentapi.rozo.ai/pay-invoice')) {
        calls.log.push('pay')
        const r = up.pay[Math.min(calls.pay, up.pay.length - 1)]
        calls.pay++
        calls.payBodies.push(JSON.parse(String(init?.body)))
        if (r === 'throw') throw new Error('timeout')
        return new Response(JSON.stringify(r.body), { status: r.status })
      }
      if (url.includes('intentapiv4.rozo.ai') && url.endsWith('/delivered')) {
        calls.delivered++
        calls.log.push('delivered')
        return new Response('{}', { status: 200 })
      }
      if (url.includes('intentapiv4.rozo.ai')) {
        calls.orderGet++
        calls.log.push('order')
        return up.order ? Response.json(up.order) : new Response('nf', { status: 404 })
      }
      const rpc = JSON.parse(String(init?.body ?? '{}'))
      const pr = proofAnswer(up.proof ?? 'prove', rpc?.method, rpc?.params)
      if (pr) {
        calls.log.push('proof')
        return pr
      }
      const data: string = rpc?.params?.[0]?.data ?? ''
      if (data.startsWith(AUTHORIZATION_STATE_SELECTOR)) {
        calls.auth++
        calls.log.push('auth')
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
    // Holder = event id + a per-attempt random suffix (R9).
    expect((await readCoinbaseExecGate(env, PL))?.holder).toMatch(/^evt-br-\d+#[0-9a-f-]{36}$/)
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
    // validBefore + grace is past, but the deadline is the later of
    // validBefore and the invoice expiry - 60 s (expiry is +30 min here).
    await sweepBitrefillFulfillments(env, Date.now() + 10 * 60_000)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
    await sweepBitrefillFulfillments(env, Date.now() + 40 * 60_000)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
    expect(s.calls.alerts.some((a) => a.includes('Do not refund until the nonce is read unused after the invoice expiry time by two sources'))).toBe(true)
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

  it('deadline: invoice expiry - 60 s without validBefore; never earlier than a recorded validBefore; old formula only without expiry', () => {
    const payingAt = '2026-11-11T10:00:00.000Z'
    const expiresAt = '2026-11-11T10:40:00.000Z'
    const b = (o: Record<string, unknown>) => ({ invoiceId: INVOICE, nonce: '0x', address: RECEIVER, amountAtomic: '1', expiresAt, ...o })
    // No validBefore: frozen expiry - 60 s (not payingAt + 360 s).
    expect(authorizationDeadlineMs({ payingAt, bitrefill: b({ validBefore: null }) } as unknown as FulfillmentRecord)).toBe(Date.parse(expiresAt) - 60_000)
    // validBefore earlier than expiry - 60 s: the expiry bound still wins (covers an unseen signature).
    const vbEarly = Math.floor(Date.parse('2026-11-11T10:05:00.000Z') / 1000)
    expect(authorizationDeadlineMs({ payingAt, bitrefill: b({ validBefore: vbEarly }) } as unknown as FulfillmentRecord)).toBe(Date.parse(expiresAt) - 60_000)
    // A recorded validBefore later than the expiry bound is never undercut.
    const vbLate = Math.floor(Date.parse('2026-11-11T10:45:00.000Z') / 1000)
    expect(authorizationDeadlineMs({ payingAt, bitrefill: b({ validBefore: vbLate }) } as unknown as FulfillmentRecord)).toBe(vbLate * 1000)
    // No expiry recorded: validBefore, else the old payingAt + 300 s + timeout.
    expect(authorizationDeadlineMs({ payingAt, bitrefill: b({ expiresAt: undefined, validBefore: vbEarly }) } as unknown as FulfillmentRecord)).toBe(vbEarly * 1000)
    expect(authorizationDeadlineMs({ payingAt } as FulfillmentRecord)).toBe(Date.parse(payingAt) + 360_000)
  })
})

// ── Fix batch 2026-11-12 ────────────────────────────────────────────────────

describe('invoice allowlist grammar (F1)', () => {
  it('exactly "*" or a list of lowercase UUIDs; anything else allows nothing', () => {
    expect(parseBitrefillInvoiceAllowlist('*')).toEqual({ all: true })
    expect(parseBitrefillInvoiceAllowlist('  *  ')).toEqual({ all: true })
    const l = parseBitrefillInvoiceAllowlist(` ${INVOICE} ,${OTHER_INVOICE} `)
    expect(l && !l.all ? [...l.ids] : null).toEqual([INVOICE, OTHER_INVOICE])
    for (const bad of [undefined, null, 42, '', '   ', `*,${INVOICE}`, '**', INVOICE.toUpperCase(), `${INVOICE},`, `,${INVOICE}`, 'abc', `${INVOICE} ${OTHER_INVOICE}`]) {
      expect(parseBitrefillInvoiceAllowlist(bad), String(bad)).toBeNull()
    }
    const env = (v: unknown) => ({ BITREFILL_FUNDER_ALLOWED_INVOICES: v }) as unknown as Env
    expect(bitrefillInvoiceAllowed(env(INVOICE), INVOICE.toUpperCase())).toBe(true)
    expect(bitrefillInvoiceAllowed(env(INVOICE), OTHER_INVOICE)).toBe(false)
    expect(bitrefillInvoiceAllowed(env('*'), OTHER_INVOICE)).toBe(true)
    expect(bitrefillInvoiceAllowed(env(undefined), INVOICE)).toBe(false)
    expect(bitrefillInvoiceAllowed(env(`*,${INVOICE}`), INVOICE)).toBe(false)
  })
})

describe('settle: allowlist, signer codes, gate and ledger order', () => {
  it('invoice not allowlisted: deferred, no reservation, no gate, no pay-invoice, alert once; not re-driven until listed', async () => {
    const { env, kv } = makeEnv({ BITREFILL_FUNDER_ALLOWED_INVOICES: OTHER_INVOICE })
    const { calls } = stub({ order: await frozenOrder() })
    const out = await run(await signedEvent(), env)
    await run(await signedEvent(), env)
    expect(out.deferred).toBe('invoice_not_allowlisted')
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
    expect(calls.alerts.filter((a) => a.includes('BITREFILL_FUNDER_ALLOWED_INVOICES'))).toHaveLength(1)
    // The sweep does not re-drive a non-listed invoice.
    await sweepBitrefillFulfillments(env)
    expect(calls.pay).toBe(0)
    expect(rec(kv).bitrefillRedrives ?? 0).toBe(0)
    // Listing it later: the sweep re-drives the payout (younger than 2 h) and pays.
    ;(env as any).BITREFILL_FUNDER_ALLOWED_INVOICES = INVOICE
    await sweepBitrefillFulfillments(env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('paid')
  })

  it('maps the new signer codes', () => {
    const tagged = (status: number, code: string) => ({ status, body: { provider: 'bitrefill', ok: false, code, signed: false } })
    expect(classifyBitrefillPayResult(tagged(403, 'bitrefill_invoice_not_allowlisted'))).toBe('refused')
    expect(classifyBitrefillPayResult({ status: 403, body: { error: 'bitrefill_invoice_not_allowlisted', signed: false } })).toBe('refused')
    expect(classifyBitrefillPayResult({ status: 403, body: { error: 'bitrefill_invoice_not_allowlisted' } })).toBe('unknown')
    expect(classifyBitrefillPayResult(tagged(422, 'PAYOUT_NOT_PROVEN_ON_CHAIN'))).toBe('refused')
    expect(classifyBitrefillPayResult(tagged(409, 'PAY_IN_FLIGHT'))).toBe('unknown')
    expect(classifyBitrefillPayResult(tagged(409, 'NONCE_USED_WITHOUT_PAY_LOG'))).toBe('nonce_used_unlogged')
    expect(classifyBitrefillPayResult(tagged(409, 'PAY_LOG_CONFLICT'))).toBe('refused')
  })

  it('409 PAY_IN_FLIGHT -> pay_invoice_unknown, gate and ledger kept', async () => {
    const { env, kv } = makeEnv()
    stub({ order: await frozenOrder(), pay: [{ status: 409, body: { provider: 'bitrefill', ok: false, code: 'PAY_IN_FLIGHT', signed: false } }] })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
    expect(await readCoinbaseExecGate(env, PL)).not.toBeNull()
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
  })

  it('409 NONCE_USED_WITHOUT_PAY_LOG -> manual_review with an alert, gate kept; re-checked, paid only with a two-host bound proof', async () => {
    const { env, kv } = makeEnv()
    const { up, calls } = stub({ order: await frozenOrder(), authUsed: true, proof: 'none', pay: [{ status: 409, body: { provider: 'bitrefill', ok: false, code: 'NONCE_USED_WITHOUT_PAY_LOG', signed: false } }] })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
    expect(await readCoinbaseExecGate(env, PL)).not.toBeNull()
    expect(calls.alerts.some((a) => a.includes('without a pay log row'))).toBe(true)
    // No proof: re-read, no change.
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    // Disproven (AuthorizationUsed transaction without the Transfer): stays, re-check stops.
    up.proof = 'noTransfer'
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(false)
  })

  it('409 NONCE_USED_WITHOUT_PAY_LOG later proven by two hosts -> paid + delivered', async () => {
    const { env, kv } = makeEnv()
    const { up, calls } = stub({ order: await frozenOrder(), authUsed: true, proof: 'none', pay: [{ status: 409, body: { provider: 'bitrefill', ok: false, code: 'NONCE_USED_WITHOUT_PAY_LOG', signed: false } }] })
    await run(await signedEvent(), env)
    up.proof = 'prove'
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(calls.delivered).toBe(1)
  })

  it('422 PAYOUT_NOT_PROVEN_ON_CHAIN and the signer allowlist refusal -> failed_pay_invoice, ledger released; text has no admin-route clearing', async () => {
    for (const body of [
      { provider: 'bitrefill', ok: false, code: 'PAYOUT_NOT_PROVEN_ON_CHAIN', signed: false },
      { provider: 'bitrefill', ok: false, code: 'bitrefill_invoice_not_allowlisted', signed: false },
    ]) {
      const { env, kv } = makeEnv()
      const { calls } = stub({ order: await frozenOrder(), pay: [{ status: body.code === 'PAYOUT_NOT_PROVEN_ON_CHAIN' ? 422 : 403, body }] })
      await run(await signedEvent(), env)
      expect(rec(kv).status, body.code).toBe('failed_pay_invoice')
      expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
      const alert = calls.alerts.find((a) => a.includes('NOT paid'))!
      expect(alert).toMatch(/Nothing in the router re-pays a Bitrefill invoice/)
      expect(alert).not.toMatch(/admin route|clears? the exec gate/)
    }
  })

  it('R10 order: gate -> reservation -> paying persisted -> call', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    const gateMod = await import('../src/routes/coinbase-exec-gate')
    const ledgerMod = await import('../src/routes/stripe-fulfillment')
    const origGate = gateMod.acquireCoinbaseExecGate
    const origReserve = ledgerMod.reserveBitrefillDaily
    vi.spyOn(gateMod, 'acquireCoinbaseExecGate').mockImplementation(async (...a: Parameters<typeof origGate>) => {
      calls.log.push('gate')
      return origGate(...a)
    })
    vi.spyOn(ledgerMod, 'reserveBitrefillDaily').mockImplementation(async (...a: Parameters<typeof origReserve>) => {
      calls.log.push('reserve')
      return origReserve(...a)
    })
    const put = kv.put
    kv.put = async (k: string, v: string) => {
      if (k === KEY && JSON.parse(v).status === 'paying') calls.log.push('paying')
      return put(k, v)
    }
    await run(await signedEvent(), env)
    expect(calls.log.filter((x) => ['gate', 'reserve', 'paying', 'pay'].includes(x))).toEqual(['gate', 'reserve', 'paying', 'pay'])
    expect(rec(kv).status).toBe('paid')
  })

  it('R10 pre-send exits release the gate and leave no reservation (ledger DO error, checkout pause after the gate)', async () => {
    let { env, kv } = makeEnv()
    let s = stub({ order: await frozenOrder() })
    const ledgerMod = await import('../src/routes/stripe-fulfillment')
    const spy = vi.spyOn(ledgerMod, 'reserveBitrefillDaily').mockRejectedValueOnce(new Error('DO down'))
    await run(await signedEvent(), env)
    expect(s.calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    spy.mockRestore()
    ;({ env, kv } = makeEnv())
    s = stub({ order: await frozenOrder() })
    const ctrl = await import('../src/routes/checkout-control')
    // Paused only once the gate is held: the second pause check.
    vi.spyOn(ctrl, 'checkoutDeliveryPaused').mockImplementation(async (e: Env) => (await readCoinbaseExecGate(e, PL)) !== null)
    await run(await signedEvent(), env)
    expect(s.calls.pay).toBe(0)
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
  })

  it('R9: a pre-send release never drops a gate held by another attempt with the same event id', async () => {
    const { env } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    const req = await signedEvent()
    const eventId = JSON.parse(await req.clone().text()).event_id
    // Another attempt holds the gate under the bare event id (old-style holder).
    expect((await acquireCoinbaseExecGate(env, PL, eventId)).ok).toBe(true)
    const gateMod = await import('../src/routes/coinbase-exec-gate')
    vi.spyOn(gateMod, 'acquireCoinbaseExecGate').mockRejectedValueOnce(new Error('DO down'))
    await run(req, env)
    expect(calls.pay).toBe(0)
    expect((await readCoinbaseExecGate(env, PL))?.holder).toBe(eventId)
  })

  it('R9: sweep re-drive event ids are unique per attempt', async () => {
    const { env, kv } = makeEnv()
    stub({ order: null })
    await run(await signedEvent(), env)
    await sweepBitrefillFulfillments(env)
    await sweepBitrefillFulfillments(env)
    const ids = rec(kv).webhookEventIds.filter((i) => i.startsWith('bitrefill-sweep:'))
    expect(ids).toHaveLength(2)
    for (const [n, id] of ids.entries()) expect(id).toMatch(new RegExp(`^bitrefill-sweep:${PL}:${n + 1}:[0-9a-f-]{36}$`))
  })
})

describe('chain quorum and late execution (F2)', () => {
  function rpcStub(
    answers: Record<string, boolean | 'fail' | 'rpcerror'>,
    opts: { proof?: Record<string, ProofMode> } = {},
  ) {
    const calls = { alerts: [] as string[], delivered: 0, hosts: [] as string[], methods: [] as string[] }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        calls.alerts.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.endsWith('/delivered')) {
        calls.delivered++
        return new Response('{}', { status: 200 })
      }
      const host = new URL(url).host
      const method = JSON.parse(String(init?.body ?? '{}')).method
      calls.methods.push(`${method}@${host}`)
      const pr = proofAnswer(opts.proof?.[host] ?? 'fail', method, JSON.parse(String(init?.body ?? '{}')).params)
      if (pr) return pr
      calls.hosts.push(host)
      const a = answers[host] ?? 'fail'
      if (a === 'fail') return new Response('down', { status: 503 })
      if (a === 'rpcerror') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' }, result: '0x' + '1'.padStart(64, '0') })
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + (a ? '1' : '0').padStart(64, '0') })
    }))
    return calls
  }

  it('symmetric quorum: two hosts agreeing and none disagreeing; RPC errors are no evidence', async () => {
    const { env } = makeEnv()
    const q = async (e = env) => (await readAuthorizationQuorum(e, FUNDER_WALLET, bitrefillNonce(INVOICE))).used
    rpcStub({ 'rpc.test': true })
    expect(await q()).toBeNull() // one used, rest down
    rpcStub({ 'rpc.test': true, 'base.drpc.org': true })
    expect(await q()).toBe(true)
    rpcStub({ 'rpc.test': true, 'base.drpc.org': true, 'mainnet.base.org': false })
    expect(await q()).toBeNull() // mixed
    rpcStub({ 'rpc.test': false, 'mainnet.base.org': false, 'base.drpc.org': true })
    expect(await q()).toBeNull() // mixed
    rpcStub({ 'rpc.test': false })
    expect(await q()).toBeNull()
    rpcStub({ 'rpc.test': false, 'mainnet.base.org': false })
    expect(await q()).toBe(false)
    // A JSON-RPC error body is not an answer, even if it carries a result.
    rpcStub({ 'rpc.test': 'rpcerror', 'base.drpc.org': 'rpcerror', 'mainnet.base.org': true })
    expect(await q()).toBeNull()
    // BASE_RPC_URL on the same host as a fallback counts once.
    const dup = makeEnv({ BASE_RPC_URL: 'https://mainnet.base.org/key' }).env
    const c = rpcStub({ 'mainnet.base.org': false })
    expect(await q(dup)).toBeNull()
    expect(c.hosts.filter((h) => h === 'mainnet.base.org')).toHaveLength(1)
  })

  function seedRec(kv: ReturnType<typeof makeKv>, r: Partial<FulfillmentRecord>) {
    kv._store.set(KEY, JSON.stringify({
      status: 'pay_invoice_unknown', pl_id: PL, rozoPaymentId: ROZO_ID, invoiceAmountAtomic: '204000000',
      funderBalanceAtomic: null, paidAt: null, payingAt: new Date(Date.now() - 3_600_000).toISOString(),
      coinbaseResult: null, failureReason: null, webhookEventIds: [], events: [],
      bitrefill: { invoiceId: INVOICE, nonce: bitrefillNonce(INVOICE), address: RECEIVER, amountAtomic: '204000000', expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(), validBefore: null },
      ...r,
    }))
  }

  it('past the deadline, a single unused read keeps the record unknown', async () => {
    const { env, kv } = makeEnv()
    seedRec(kv, {})
    rpcStub({ 'rpc.test': false })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('manual_review from an unknown outcome keeps being re-read; nonce later used -> paid, loud alert, delivered', async () => {
    const { env, kv } = makeEnv()
    seedRec(kv, {})
    let c = rpcStub({ 'rpc.test': false, 'mainnet.base.org': false })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
    // Still unused: no change.
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    // The authorization executed late.
    // One host reading used is not enough.
    c = rpcStub({ 'base.llamarpc.com': true })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    // Two used plus one unused: still no change.
    c = rpcStub({ 'base.llamarpc.com': true, 'base.drpc.org': true, 'rpc.test': false })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    // Two used, no proof: still no change (never paid on the quorum alone).
    c = rpcStub({ 'base.llamarpc.com': true, 'base.drpc.org': true })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    c = rpcStub({ 'base.llamarpc.com': true, 'base.drpc.org': true }, { proof: { 'base.llamarpc.com': 'prove', 'base.drpc.org': 'prove' } })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(rec(kv).events.some((e) => e.kind === 'sweep_bitrefill_late_execution')).toBe(true)
    expect(c.alerts.filter((a) => a.includes('was manual_review, chain now shows paid'))).toHaveLength(1)
    expect(c.alerts[0]).toMatch(/recover it/)
    expect(c.delivered).toBe(1)
    await sweepBitrefillFulfillments(env)
    expect(c.alerts.filter((a) => a.includes('was manual_review'))).toHaveLength(1)
  })

  it('manual_review that did not come from an unknown outcome is not re-read', async () => {
    const { env, kv } = makeEnv()
    seedRec(kv, { status: 'manual_review' })
    const c = rpcStub({ 'rpc.test': true })
    await sweepBitrefillFulfillments(env)
    expect(c.hosts).toHaveLength(0)
    expect(rec(kv).status).toBe('manual_review')
  })
})

describe('round 3: authorization-bound transfer proof (rule A)', () => {
  function seedU(kv: ReturnType<typeof makeKv>, r: Partial<FulfillmentRecord> = {}, b: Record<string, unknown> = {}) {
    kv._store.set(KEY, JSON.stringify({
      status: 'pay_invoice_unknown', pl_id: PL, rozoPaymentId: ROZO_ID, invoiceAmountAtomic: '204000000',
      funderBalanceAtomic: null, paidAt: null, payingAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      coinbaseResult: null, failureReason: null, webhookEventIds: [], events: [],
      bitrefill: { invoiceId: INVOICE, nonce: bitrefillNonce(INVOICE), address: RECEIVER, amountAtomic: '204000000', expiresAt: inMinutes(30), validBefore: null, ...b },
      ...r,
    }))
  }
  // used: per-host nonce answer; proof: per-host proof mode (default fail).
  function chain(used: Record<string, boolean | 'fail'>, proof: Record<string, ProofMode> = {}, receiptOverride?: (host: string, tx: string) => any) {
    const calls = { alerts: [] as string[], delivered: 0, methods: [] as string[] }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        calls.alerts.push(JSON.parse(String(init?.body)).text.content)
        return Response.json({ errcode: 0 })
      }
      if (url.endsWith('/delivered')) {
        calls.delivered++
        return new Response('{}', { status: 200 })
      }
      const host = new URL(url).host
      const body = JSON.parse(String(init?.body ?? '{}'))
      calls.methods.push(`${body.method}@${host}`)
      if (receiptOverride && body.method === 'eth_getTransactionReceipt') {
        const r = receiptOverride(host, body.params[0])
        if (r !== undefined) return r === 'fail' ? new Response('down', { status: 502 }) : Response.json({ jsonrpc: '2.0', id: 1, result: r })
      }
      const pr = proofAnswer(proof[host] ?? 'fail', body.method, body.params)
      if (pr) return pr
      const a = used[host] ?? 'fail'
      if (a === 'fail') return new Response('down', { status: 503 })
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' + (a ? '1' : '0').padStart(64, '0') })
    }))
    return calls
  }
  const USED2 = { 'rpc.test': true, 'base.drpc.org': true } as const
  const PROOF2 = { 'rpc.test': 'prove', 'base.drpc.org': 'prove' } as const
  const PAST = () => Date.now() + 40 * 60_000 // past expiry - 60 s + grace

  it('AuthorizationUsed topic constant equals keccak256 of the event signature', async () => {
    const { keccak256, stringToHex } = await import('viem')
    const mod = await import('../src/routes/bitrefill-settle')
    expect(mod.AUTHORIZATION_USED_TOPIC).toBe(keccak256(stringToHex('AuthorizationUsed(address,bytes32)')))
    expect(mod.ERC20_TRANSFER_TOPIC).toBe(keccak256(stringToHex('Transfer(address,address,uint256)')))
  })

  it('nonce quorum + proof from two hosts -> paid, transaction stored, delivered', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    const c = chain(USED2, PROOF2)
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(rec(kv).bitrefill?.transaction).toBe(bitrefillNonce(INVOICE).toLowerCase())
    const ev = rec(kv).events.find((e) => e.kind === 'sweep_bitrefill_authorization_used') as any
    expect(ev.detail.proof).toBe('proven')
    expect(c.delivered).toBe(1)
  })

  it('nonce quorum without any proof is never paid: no change before the deadline', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    chain(USED2)
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('proof from a single host is not enough', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    chain(USED2, { 'rpc.test': 'prove', 'base.drpc.org': 'none' })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('one host true -> no change; two true + one false -> no change, even with proof', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    chain({ 'rpc.test': true }, PROOF2)
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
    chain({ ...USED2, 'mainnet.base.org': false }, PROOF2)
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('empty logs are never disproven: past the deadline -> manual_review "could not be proven", keep re-checking, alert once; later proof -> paid', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    let c = chain(USED2, { 'rpc.test': 'none', 'base.drpc.org': 'none', 'mainnet.base.org': 'none' })
    await sweepBitrefillFulfillments(env, PAST())
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
    expect(rec(kv).events.some((e) => e.kind === 'sweep_bitrefill_nonce_used_no_transfer')).toBe(false)
    expect(c.alerts.filter((a) => a.includes('could not be proven automatically'))).toHaveLength(1)
    expect(c.alerts[0]).toMatch(/Do NOT refund, do NOT re-pay/)
    await sweepBitrefillFulfillments(env, PAST())
    expect(c.alerts.filter((a) => a.includes('could not be proven automatically'))).toHaveLength(1)
    c = chain(USED2, PROOF2)
    await sweepBitrefillFulfillments(env, PAST())
    expect(rec(kv).status).toBe('paid')
    expect(c.alerts.some((a) => a.includes('chain now shows paid'))).toBe(true)
  })

  it('disproven by two hosts (the AuthorizationUsed transaction has no matching Transfer) -> manual_review, loud alert, no more re-checks', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    const c = chain(USED2, { 'rpc.test': 'noTransfer', 'base.drpc.org': 'noTransfer' })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(false)
    expect(c.alerts.some((a) => a.includes('nonce consumed by something that did not pay this invoice'))).toBe(true)
    expect(c.delivered).toBe(0)
  })

  it('a same-address same-amount Transfer in a different transaction is not proof', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    // The AuthorizationUsed transaction carries no Transfer; the exact Transfer
    // lives in another transaction (never consulted).
    chain(USED2, PROOF2, (_h, tx) => ({ status: '0x1', transactionHash: tx, logs: [authLog(tx, tx)] }))
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).events.some((e) => e.kind === 'sweep_bitrefill_nonce_used_no_transfer')).toBe(true)
  })

  it('hosts disagree (one proven, one disproven) -> unavailable, no change', async () => {
    const { env, kv } = makeEnv()
    seedU(kv)
    chain(USED2, { 'rpc.test': 'prove', 'base.drpc.org': 'noTransfer' })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('recorded transaction: its receipt proven on two hosts -> paid; those hosts run no log query', async () => {
    const { env, kv } = makeEnv()
    const tx = bitrefillNonce(INVOICE).toLowerCase()
    seedU(kv, {}, { transaction: tx })
    const c = chain(USED2, PROOF2)
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(c.methods).toContain('eth_getTransactionReceipt@rpc.test')
    expect(c.methods.filter((m) => m === 'eth_getLogs@rpc.test' || m === 'eth_getLogs@base.drpc.org')).toHaveLength(0)
  })

  it('receipts unreadable and logs refused -> unavailable, no change before the deadline', async () => {
    const { env, kv } = makeEnv()
    seedU(kv, {}, { transaction: TX })
    chain(USED2, {})
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
  })

  it('log window over the cap -> no log query, never paid; past the deadline -> manual_review unproven', async () => {
    const { env, kv } = makeEnv()
    seedU(kv, { payingAt: new Date(Date.now() - 10 * 3_600_000).toISOString() })
    const c = chain(USED2, PROOF2)
    await sweepBitrefillFulfillments(env, PAST())
    expect(c.methods.some((m) => m.startsWith('eth_getLogs'))).toBe(false)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
  })

  it('old record (payment older than 9,000 blocks, no tx hash) is still provable: window anchored to the payment', async () => {
    const { env, kv } = makeEnv()
    const paying = Date.now() - 12 * 3_600_000
    seedU(kv, { status: 'manual_review', bitrefillUnknownOrigin: true, alertedManualReview: true, payingAt: new Date(paying).toISOString() }, { expiresAt: new Date(paying + 40 * 60_000).toISOString() })
    const calls: any[] = []
    const c = chain(USED2, PROOF2)
    const f = globalThis.fetch as any
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
      const b = JSON.parse(String(init?.body ?? '{}'))
      if (b.method === 'eth_getLogs') calls.push(b.params[0])
      return f(input, init)
    }))
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(c.alerts.some((a) => a.includes('chain now shows paid'))).toBe(true)
    // Every log query is bounded by the payment, far below latest and the cap.
    expect(calls.length).toBeGreaterThan(0)
    for (const q of calls) {
      const from = Number(BigInt(q.fromBlock))
      const to = Number(BigInt(q.toBlock))
      expect(to - from).toBeLessThan(9_000)
      expect(to).toBeLessThan(CHAIN.latest - 10_000)
    }
  })

  it('block timestamps verify the window: a faster chain than 2 s/block makes fromBlock too late, it steps back once and still proves', async () => {
    CHAIN.blockSec = 1
    const blockCalls: number[] = []
    const { env, kv } = makeEnv()
    const paying = Date.now() - 3 * 3_600_000
    seedU(kv, { payingAt: new Date(paying).toISOString() }, { expiresAt: new Date(paying + 40 * 60_000).toISOString() })
    chain(USED2, PROOF2)
    const f = globalThis.fetch as any
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
      const b = JSON.parse(String(init?.body ?? '{}'))
      if (b.method === 'eth_getBlockByNumber' && String(input).includes('rpc.test')) blockCalls.push(Number(BigInt(b.params[0])))
      return f(input, init)
    }))
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    // latest, first fromBlock estimate, stepped-back fromBlock, toBlock.
    expect(blockCalls.length).toBe(4)
    expect(blockCalls[2]).toBeLessThan(blockCalls[1])
  })

  it('unverifiable coverage (block timestamps unusable) -> unavailable, never disproven, never paid', async () => {
    CHAIN.brokenTimestamps = true
    const { env, kv } = makeEnv()
    const paying = Date.now() - 3 * 3_600_000
    seedU(kv, { payingAt: new Date(paying).toISOString() }, { expiresAt: new Date(paying + 40 * 60_000).toISOString() })
    const c = chain(USED2, { 'rpc.test': 'noTransfer', 'base.drpc.org': 'noTransfer' })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review') // past the deadline, proof unavailable
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
    expect(c.alerts.some((a) => a.includes('could not be proven automatically'))).toBe(true)
    expect(rec(kv).events.some((e) => e.kind === 'sweep_bitrefill_nonce_used_no_transfer')).toBe(false)
  })

  it('manual_review re-check without proof -> no change, no alert', async () => {
    const { env, kv } = makeEnv()
    seedU(kv, { status: 'manual_review', bitrefillUnknownOrigin: true, alertedManualReview: true })
    const c = chain(USED2, { 'rpc.test': 'none', 'base.drpc.org': 'fail' })
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    expect(c.alerts).toHaveLength(0)
  })

  it('the signer 200 paid answer stays sufficient (no chain read at settle)', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('paid')
    expect(calls.auth).toBe(0)
  })
})

describe('round 3: signer answers (rule C)', () => {
  const tagged = (status: number, code: string) => ({ status, body: { provider: 'bitrefill', ok: false, code, signed: false } })

  it('maps NONCE_USED_TRANSFER_NOT_PROVEN and TRANSFER_PROOF_UNAVAILABLE', () => {
    expect(classifyBitrefillPayResult(tagged(409, 'NONCE_USED_TRANSFER_NOT_PROVEN'))).toBe('nonce_used_unlogged')
    expect(classifyBitrefillPayResult(tagged(503, 'TRANSFER_PROOF_UNAVAILABLE'))).toBe('unknown')
    expect(classifyBitrefillPayResult(tagged(503, 'RPC_UNAVAILABLE'))).toBe('presign_transient')
  })

  it('409 NONCE_USED_TRANSFER_NOT_PROVEN -> manual_review, gate and reservation kept, alert', async () => {
    const { env, kv } = makeEnv()
    const { up, calls } = stub({ order: await frozenOrder(), authUsed: true, proof: 'none', pay: [tagged(409, 'NONCE_USED_TRANSFER_NOT_PROVEN')] })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('manual_review')
    expect(rec(kv).bitrefillUnknownOrigin).toBe(true)
    // The sweep keeps trying; a two-host bound proof flips it to paid + delivered.
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('manual_review')
    up.proof = 'prove'
    await sweepBitrefillFulfillments(env)
    expect(rec(kv).status).toBe('paid')
    expect(calls.delivered).toBe(1)
    expect(await readCoinbaseExecGate(env, PL)).not.toBeNull()
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
    expect(calls.alerts.some((a) => a.includes('nonce consumed, transfer not proven') && a.includes('do not refund until checked'))).toBe(true)
  })

  it('503 TRANSFER_PROOF_UNAVAILABLE -> pay_invoice_unknown, no immediate retry, gate and reservation kept', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder(), pay: [tagged(503, 'TRANSFER_PROOF_UNAVAILABLE')] })
    await run(await signedEvent(), env)
    expect(calls.pay).toBe(1)
    expect(rec(kv).status).toBe('pay_invoice_unknown')
    expect(await readCoinbaseExecGate(env, PL)).not.toBeNull()
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
  })

  it('200 already_paid stores its transaction hash', async () => {
    const { env, kv } = makeEnv()
    stub({ order: await frozenOrder(), pay: [{ status: 200, body: { provider: 'bitrefill', ok: true, status: 'already_paid', signed: false, nonce: bitrefillNonce(INVOICE), transaction: TX } }] })
    await run(await signedEvent(), env)
    expect(rec(kv).status).toBe('paid')
    expect(rec(kv).bitrefill?.transaction).toBe(TX)
  })
})

describe('round 3: bitrefill ledger fails closed (rule B)', () => {
  it('absent = 0, plain integer = total, anything else present throws', async () => {
    const ledger = await import('../src/routes/stripe-fulfillment')
    expect(ledger.parseBitrefillLedger(null).total).toBe(0n)
    expect(ledger.parseBitrefillLedger('123').total).toBe(123n)
    expect(ledger.parseBitrefillLedger('{"t":"5","h":{"bitrefill_a":"5"}}').holds).toEqual({ bitrefill_a: '5' })
    expect(ledger.parseBitrefillLedger('{"t":"9","h":{"a":"4","b":"5"}}').total).toBe(9n)
    for (const bad of ['', 'garbage', '{', '[]', 'null', '{"t":5,"h":{}}', '{"t":"-1","h":{}}', '{"t":"5"}', '{"t":"5","h":[]}', '{"t":"5","h":{"x":5}}', '1.5', '{"t":"8","h":{"a":"4","b":"5"}}', '{"t":"0","h":{"a":"1"}}']) {
      expect(() => ledger.parseBitrefillLedger(bad), bad).toThrow()
    }
  })

  it('a corrupted ledger value defers the payout: nothing reserved or sent, gate released', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    const atomic = await import('../src/routes/stripe-atomic')
    await atomic.casUpdate(env, (await import('../src/routes/stripe-fulfillment')).dailySpentKey(new Date(), 'bitrefill'), () => ({ op: 'set', value: '{"t":"oops"}', result: true }))
    const out = await run(await signedEvent(), env)
    expect(out.deferred).toBe('daily_cap_unavailable')
    expect(calls.pay).toBe(0)
    expect(rec(kv).status).toBe('payin_seen')
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    await expect(readDailySpentAtomic(env, new Date(), 'bitrefill')).rejects.toThrow()
  })
})

describe('round 2: attributable daily reservation (P1-a)', () => {
  it('reserve is idempotent per invoice; release removes exactly that hold; cap enforced; other ledgers keep plain totals', async () => {
    const { env } = makeEnv({ BITREFILL_SETTLE_DAILY_CAP_USD: '300' })
    const ledger = await import('../src/routes/stripe-fulfillment')
    const day = new Date()
    expect(await ledger.reserveBitrefillDaily(env, day, 'bitrefill_a', 200_000_000n)).toBe('ok')
    expect(await ledger.reserveBitrefillDaily(env, day, 'bitrefill_a', 200_000_000n)).toBe('replay')
    expect(await readDailySpentAtomic(env, day, 'bitrefill')).toBe(200_000_000n)
    expect(await ledger.reserveBitrefillDaily(env, day, 'bitrefill_b', 200_000_000n)).toBeNull()
    expect(await ledger.reserveBitrefillDaily(env, day, 'bitrefill_b', 100_000_000n)).toBe('ok')
    expect(await ledger.releaseBitrefillDaily(env, day, 'bitrefill_x')).toBe(false)
    expect(await ledger.releaseBitrefillDaily(env, day, 'bitrefill_a')).toBe(true)
    expect(await readDailySpentAtomic(env, day, 'bitrefill')).toBe(100_000_000n)
    expect(await ledger.readBitrefillDailyHold(env, day, 'bitrefill_b')).toBe(100_000_000n)
    await expect(ledger.reserveDailySpend(env, day, 1n, 'bitrefill')).rejects.toThrow()
    expect(await ledger.reserveDailySpend(env, day, 5n, 'coinbase')).toBe(0n)
    expect(await readDailySpentAtomic(env, day, 'coinbase')).toBe(5n)
  })

  it('reserve threw after committing: the hold is released, gate released, a replay pays and counts once', async () => {
    const { env, kv } = makeEnv()
    const { calls } = stub({ order: await frozenOrder() })
    const ledger = await import('../src/routes/stripe-fulfillment')
    const orig = ledger.reserveBitrefillDaily
    vi.spyOn(ledger, 'reserveBitrefillDaily').mockImplementationOnce(async (...a: Parameters<typeof orig>) => {
      await orig(...a)
      throw new Error('DO answer lost')
    })
    const req = await signedEvent()
    const replay = req.clone()
    await run(req, env)
    expect(calls.pay).toBe(0)
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(0n)
    expect(await readCoinbaseExecGate(env, PL)).toBeNull()
    await run(replay, env)
    expect(rec(kv).status).toBe('paid')
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
  })

  it('reserve threw and the release failed too: the hold stays attributable, the next attempt replays it (no double count)', async () => {
    const { env, kv } = makeEnv()
    stub({ order: await frozenOrder() })
    const ledger = await import('../src/routes/stripe-fulfillment')
    const orig = ledger.reserveBitrefillDaily
    vi.spyOn(ledger, 'reserveBitrefillDaily').mockImplementationOnce(async (...a: Parameters<typeof orig>) => {
      await orig(...a)
      throw new Error('DO answer lost')
    })
    vi.spyOn(ledger, 'releaseBitrefillDaily').mockRejectedValueOnce(new Error('DO down'))
    const req = await signedEvent()
    const replay = req.clone()
    await run(req, env)
    expect(rec(kv).events.some((e) => e.kind === 'daily_reservation_uncertain')).toBe(true)
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
    await run(replay, env)
    expect(rec(kv).status).toBe('paid')
    expect(await readDailySpentAtomic(env, new Date(), 'bitrefill')).toBe(204_000_000n)
  })
})

describe('sweep budget and ordering (R7)', () => {
  const invN = (i: number) => `ec9482de-1111-4222-8333-${(0xa00 + i).toString(16).padStart(12, '0')}`
  function seedN(kv: ReturnType<typeof makeKv>, inv: string, r: Partial<FulfillmentRecord>) {
    const pl = `bitrefill_${inv}`
    kv._store.set(`invoice-fulfillment:${pl}`, JSON.stringify({
      status: 'payin_seen', pl_id: pl, rozoPaymentId: ROZO_ID, invoiceAmountAtomic: '204000000',
      funderBalanceAtomic: null, paidAt: null, payingAt: null, coinbaseResult: null, failureReason: null,
      webhookEventIds: [], events: [{ kind: 'payment_payout_completed', at: new Date().toISOString() }],
      bitrefill: { invoiceId: inv, nonce: bitrefillNonce(inv), address: RECEIVER, amountAtomic: '204000000', expiresAt: inMinutes(30), validBefore: null },
      ...r,
    }))
  }
  const load = (kv: ReturnType<typeof makeKv>, inv: string): FulfillmentRecord => JSON.parse(kv._store.get(`invoice-fulfillment:bitrefill_${inv}`) as string)

  it('each action is capped at BITREFILL_SWEEP_MAX_RECORDS and re-drives run first', async () => {
    const { env, kv } = makeEnv()
    const n = BITREFILL_SWEEP_MAX_RECORDS + 5
    for (let i = 0; i < n; i++) {
      seedN(kv, invN(i), {}) // re-drive (order unreadable)
      seedN(kv, invN(100 + i), { status: 'pay_invoice_unknown', payingAt: new Date(Date.now() - 60_000).toISOString() })
      seedN(kv, invN(200 + i), { status: 'paid', paidAt: new Date().toISOString() })
    }
    const { calls } = stub({ order: null, authUsed: true })
    await sweepBitrefillFulfillments(env)
    const range = (a: number) => Array.from({ length: n }, (_, i) => load(kv, invN(a + i)))
    expect(range(0).filter((r) => (r.bitrefillRedrives ?? 0) === 1)).toHaveLength(BITREFILL_SWEEP_MAX_RECORDS)
    expect(range(100).filter((r) => r.status === 'paid')).toHaveLength(BITREFILL_SWEEP_MAX_RECORDS)
    expect(range(200).filter((r) => r.deliveredReported)).toHaveLength(BITREFILL_SWEEP_MAX_RECORDS)
    expect(calls.pay).toBe(0)
    // All re-drive work (order reads) happened before the first chain read.
    expect(calls.log.lastIndexOf('order')).toBeLessThan(calls.log.indexOf('auth'))
  })

  it('stops starting re-drives once the run used its 60 s wall budget', async () => {
    const { env, kv } = makeEnv()
    for (let i = 0; i < 3; i++) seedN(kv, invN(i), {})
    stub({ order: null })
    const clock = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(61_000)
    await sweepBitrefillFulfillments(env, Date.now(), clock)
    const done = [0, 1, 2].filter((i) => (load(kv, invN(i)).bitrefillRedrives ?? 0) === 1)
    expect(done).toHaveLength(1)
  })
})
