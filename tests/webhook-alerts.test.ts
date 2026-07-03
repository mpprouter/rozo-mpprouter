/**
 * DingTalk ops alerts for invoice fulfillment failures.
 *
 * Covers (tech doc §5 / §8.1):
 *  - failed_insufficient_balance path fires a DingTalk alert
 *  - failed_pay_invoice path fires a DingTalk alert
 *  - alert payload format: pl_id, amount, failure reason, funder balance,
 *    timestamp — with NO full blockchain addresses (first-6 + last-4 mask)
 *  - missing DINGTALK_ACCESS_TOKEN degrades gracefully (structured log,
 *    no fetch, main flow unaffected)
 *  - alert transport failure never breaks the webhook handler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  handleRozoWebhook,
  maskAddresses,
  buildInvoiceFailureAlert,
  sendInvoiceFailureAlert,
} from '../src/routes/webhook'
import type { Env } from '../src/index'

// ── helpers ──────────────────────────────────────────────────────────────

const FUNDER_FULL = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739'
const FUNDER_MASKED = '0x2352…1739'

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const WEBHOOK_SECRET = 'test-webhook-secret'

async function signedWebhookRequest(evt: unknown): Promise<Request> {
  const body = JSON.stringify(evt)
  const ts = Date.now().toString()
  const sig = await hmacSha256Hex(WEBHOOK_SECRET, `${ts}.${body}`)
  return new Request(
    'https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook',
    {
      method: 'POST',
      headers: {
        'x-rozo-timestamp': ts,
        'x-rozo-signature': `sha256=${sig}`,
        'content-type': 'application/json',
      },
      body,
    },
  )
}

function makeKvMock() {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, _opts?: unknown) => {
      store.set(k, v)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
  }
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const kv = makeKvMock()
  const env = {
    MPP_STORE: kv,
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    BASE_RPC_URL: 'https://rpc.test/primary',
    DINGTALK_ACCESS_TOKEN: 'dt-test-token',
    ...overrides,
  }
  return { env: env as unknown as Env, kv }
}

interface DingTalkCall {
  url: string
  body: { msgtype: string; text: { content: string } }
}

/**
 * Global fetch stub dispatching on URL:
 *  - oapi.dingtalk.com          → records the call, 200
 *  - agentapi.rozo.ai/pay-invoice → configurable status/body
 *  - anything else (Base RPC)    → eth_call balance result
 */
function stubFetch(opts: {
  balanceAtomic: bigint | null
  payInvoiceStatus?: number
  payInvoiceBody?: unknown
  dingtalkThrows?: boolean
}): DingTalkCall[] {
  const dingtalkCalls: DingTalkCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('oapi.dingtalk.com')) {
        if (opts.dingtalkThrows) throw new Error('dingtalk network down')
        dingtalkCalls.push({ url, body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
      }
      if (url.includes('agentapi.rozo.ai/pay-invoice')) {
        return new Response(
          JSON.stringify(opts.payInvoiceBody ?? { error: 'boom' }),
          { status: opts.payInvoiceStatus ?? 200 },
        )
      }
      // Base RPC eth_call
      if (opts.balanceAtomic === null) {
        return new Response('rpc down', { status: 500 })
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: '0x' + opts.balanceAtomic.toString(16),
        }),
        { status: 200 },
      )
    }),
  )
  return dingtalkCalls
}

let eventSeq = 0
function payoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: `evt-test-${++eventSeq}`,
    type: 'payment_payout_completed',
    timestamp: new Date().toISOString(),
    data: {
      id: '11111111-2222-3333-4444-555555555555',
      orderId: 'pl_testInvoiceAlert1',
      status: 'payment_completed',
      source: { amount: '1.00', chainId: '8453', txHash: null },
      destination: {
        amount: '1.00',
        receiverAddress: FUNDER_FULL,
        chainId: '8453',
        txHash: '0xdeadbeef',
      },
      ...overrides,
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── maskAddresses ────────────────────────────────────────────────────────

describe('maskAddresses', () => {
  it('masks EVM addresses to first-6 + last-4', () => {
    expect(maskAddresses(`funder is ${FUNDER_FULL} ok`)).toBe(
      `funder is ${FUNDER_MASKED} ok`,
    )
  })

  it('masks Stellar G-addresses', () => {
    const g = 'G' + 'A'.repeat(55)
    const masked = maskAddresses(`acct ${g}`)
    expect(masked).not.toContain(g)
    expect(masked).toContain(`${g.slice(0, 6)}…${g.slice(-4)}`)
  })

  it('masks Solana-style base58 addresses', () => {
    const sol = 'He9F3sVzXqhkPqhz4qmDGvbZzKcv9EFVXqStB3RpAkQm'
    const masked = maskAddresses(`dest ${sol}`)
    expect(masked).not.toContain(sol)
    expect(masked).toContain(`${sol.slice(0, 6)}…${sol.slice(-4)}`)
  })

  it('leaves pl_ ids, uuids, and amounts untouched', () => {
    const s = 'pl_bwLvxdBM4Nxr51tS 11111111-2222-3333-4444-555555555555 1.00 USDC'
    expect(maskAddresses(s)).toBe(s)
  })

  it('is idempotent on already-masked text', () => {
    const once = maskAddresses(FUNDER_FULL)
    expect(maskAddresses(once)).toBe(once)
  })
})

// ── buildInvoiceFailureAlert ─────────────────────────────────────────────

describe('buildInvoiceFailureAlert', () => {
  it('insufficient-balance alert carries pl_id, amount, reason, balances, timestamp — no full address', () => {
    const msg = buildInvoiceFailureAlert({
      kind: 'failed_insufficient_balance',
      plId: 'pl_abc123',
      invoiceAtomic: 1_000_000n,
      funderBalanceAtomic: 500_000n,
      availableAtomic: 400_000n,
      failureReason: 'funder balance 500000 (avail 400000) < invoice 1000000',
    })
    expect(msg).toContain('[MPP Router]')
    expect(msg).toContain('insufficient funder balance')
    expect(msg).toContain('pl_abc123')
    expect(msg).toContain('1.00 USDC') // invoice amount
    expect(msg).toContain('balance 0.50 USDC')
    expect(msg).toContain('available 0.40 USDC')
    expect(msg).toContain('Reason: funder balance')
    expect(msg).toMatch(/At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
    expect(msg).toContain(FUNDER_MASKED)
    expect(msg).not.toContain(FUNDER_FULL)
  })

  it('pay-invoice-failure alert carries amount, balance, reason, timestamp and masks addresses in detail', () => {
    const leakyDetail = JSON.stringify({
      error: 'transfer failed',
      from: FUNDER_FULL,
    })
    const msg = buildInvoiceFailureAlert({
      kind: 'failed_pay_invoice',
      plId: 'pl_xyz789',
      invoiceAtomic: 2_500_000n,
      funderBalanceAtomic: 10_000_000n,
      failureReason: 'agentapi pay-invoice 500',
      detail: leakyDetail,
    })
    expect(msg).toContain('pl_xyz789')
    expect(msg).toContain('2.50 USDC')
    expect(msg).toContain('balance 10.00 USDC')
    expect(msg).toContain('Reason: agentapi pay-invoice 500')
    expect(msg).toContain('Detail:')
    expect(msg).toMatch(/At: \d{4}-\d{2}-\d{2}T/)
    expect(msg).not.toContain(FUNDER_FULL)
    expect(msg).toContain(FUNDER_MASKED)
  })

  it('masks the detail BEFORE truncation (no partially exposed address at the cut)', () => {
    // Address placed so naive slice-then-mask would cut it mid-way.
    const padding = 'x'.repeat(290)
    const msg = buildInvoiceFailureAlert({
      kind: 'failed_pay_invoice',
      plId: 'pl_cut',
      invoiceAtomic: 1_000_000n,
      funderBalanceAtomic: null,
      failureReason: 'agentapi pay-invoice 502',
      detail: `${padding}${FUNDER_FULL}`,
    })
    // No run of 10+ hex chars after 0x may survive anywhere.
    expect(msg).not.toMatch(/0x[a-fA-F0-9]{10,}/)
  })

  it('renders unknown balance as ?', () => {
    const msg = buildInvoiceFailureAlert({
      kind: 'failed_pay_invoice',
      plId: 'pl_nobal',
      invoiceAtomic: null,
      funderBalanceAtomic: null,
      failureReason: 'agentapi pay-invoice 0',
    })
    expect(msg).toContain('(? USDC)')
    expect(msg).toContain('balance ? USDC')
  })
})

// ── sendInvoiceFailureAlert degradation ──────────────────────────────────

describe('sendInvoiceFailureAlert', () => {
  const params = {
    kind: 'failed_pay_invoice' as const,
    plId: 'pl_degrade',
    invoiceAtomic: 1_000_000n,
    funderBalanceAtomic: 1_000_000n,
    failureReason: 'agentapi pay-invoice 500',
  }

  it('missing token → structured warn log, no fetch, no throw', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { env } = makeEnv({ DINGTALK_ACCESS_TOKEN: undefined })

    await expect(sendInvoiceFailureAlert(env, params)).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = String(warnSpy.mock.calls[0][0])
    expect(logged).toContain('DINGTALK_ACCESS_TOKEN not set')
    expect(logged).toContain('"kind":"failed_pay_invoice"')
    expect(logged).toContain('"pl_id":"pl_degrade"')
  })

  it('transport failure (fetch throws) never propagates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { env } = makeEnv()

    await expect(sendInvoiceFailureAlert(env, params)).resolves.toBeUndefined()
    // sendDingTalkAlert catches internally and warns — either way, no throw.
    expect(warnSpy).toHaveBeenCalled()
  })
})

// ── end-to-end through handleRozoWebhook ─────────────────────────────────

describe('handleRozoWebhook failure alerts (state machine integration)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('payout_completed + insufficient balance → failed_insufficient_balance + DingTalk alert', async () => {
    // balance 0.50 USDC < invoice 1.00 USDC
    const dingtalkCalls = stubFetch({ balanceAtomic: 500_000n })
    const { env, kv } = makeEnv()

    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.deferred).toBe('insufficient_balance')

    // KV state
    const rec = JSON.parse(kv._store.get('invoice-fulfillment:pl_testInvoiceAlert1')!)
    expect(rec.status).toBe('failed_insufficient_balance')

    // Alert fired exactly once, correct transport + payload
    expect(dingtalkCalls).toHaveLength(1)
    expect(dingtalkCalls[0].url).toContain('access_token=dt-test-token')
    expect(dingtalkCalls[0].body.msgtype).toBe('text')
    const content = dingtalkCalls[0].body.text.content
    expect(content).toContain('pl_testInvoiceAlert1')
    expect(content).toContain('1.00 USDC') // invoice amount
    expect(content).toContain('balance 0.50 USDC') // funder balance
    expect(content).toContain('Reason:') // failure reason
    expect(content).toMatch(/At: \d{4}-\d{2}-\d{2}T/) // timestamp
    expect(content).not.toContain(FUNDER_FULL) // masked
    expect(content).toContain(FUNDER_MASKED)
  })

  it('payout_completed + agentapi pay-invoice 500 → failed_pay_invoice + DingTalk alert', async () => {
    // balance 10 USDC covers the 1.00 invoice; agentapi then fails.
    const dingtalkCalls = stubFetch({
      balanceAtomic: 10_000_000n,
      payInvoiceStatus: 500,
      payInvoiceBody: { error: 'escrow reverted', funder: FUNDER_FULL },
    })
    const { env, kv } = makeEnv()

    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.status).toBe('failed_pay_invoice')

    const rec = JSON.parse(kv._store.get('invoice-fulfillment:pl_testInvoiceAlert1')!)
    expect(rec.status).toBe('failed_pay_invoice')

    expect(dingtalkCalls).toHaveLength(1)
    const content = dingtalkCalls[0].body.text.content
    expect(content).toContain('pl_testInvoiceAlert1')
    expect(content).toContain('1.00 USDC')
    expect(content).toContain('balance 10.00 USDC')
    expect(content).toContain('Reason: agentapi pay-invoice 500')
    expect(content).toContain('escrow reverted') // detail passthrough
    expect(content).toMatch(/At: \d{4}-\d{2}-\d{2}T/)
    // Full address in agentapi error body must be masked.
    expect(content).not.toContain(FUNDER_FULL)
  })

  it('paid path (agentapi 200) fires NO alert', async () => {
    const dingtalkCalls = stubFetch({
      balanceAtomic: 10_000_000n,
      payInvoiceStatus: 200,
      payInvoiceBody: { ok: true },
    })
    const { env, kv } = makeEnv()

    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(res.status).toBe(200)
    const rec = JSON.parse(kv._store.get('invoice-fulfillment:pl_testInvoiceAlert1')!)
    expect(rec.status).toBe('paid')
    expect(dingtalkCalls).toHaveLength(0)
  })

  it('missing DINGTALK_ACCESS_TOKEN → main flow unaffected, structured log instead of alert', async () => {
    const dingtalkCalls = stubFetch({ balanceAtomic: 500_000n })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { env, kv } = makeEnv({ DINGTALK_ACCESS_TOKEN: undefined })

    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(res.status).toBe(200)

    const rec = JSON.parse(kv._store.get('invoice-fulfillment:pl_testInvoiceAlert1')!)
    expect(rec.status).toBe('failed_insufficient_balance')

    expect(dingtalkCalls).toHaveLength(0)
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).toContain('DINGTALK_ACCESS_TOKEN not set')
    expect(warned).toContain('failed_insufficient_balance')
  })

  it('DingTalk transport failure does not break the webhook response', async () => {
    const dingtalkCalls = stubFetch({ balanceAtomic: 500_000n, dingtalkThrows: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { env, kv } = makeEnv()

    const res = await handleRozoWebhook(await signedWebhookRequest(payoutEvent()), env)
    expect(res.status).toBe(200)
    const rec = JSON.parse(kv._store.get('invoice-fulfillment:pl_testInvoiceAlert1')!)
    expect(rec.status).toBe('failed_insufficient_balance')
    expect(dingtalkCalls).toHaveLength(0)
  })
})
