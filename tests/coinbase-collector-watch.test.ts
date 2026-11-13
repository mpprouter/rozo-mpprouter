// Unknown Coinbase token collector watch: alert only, never changes the
// payment result (founder 2026-11-13: alert, do not block, at any amount).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { callAgentApiPayInvoice } from '../src/routes/webhook'
import {
  KNOWN_COINBASE_TOKEN_COLLECTORS,
  parseSignedCollector,
  shortInvoiceId,
  watchSignedCollector,
} from '../src/routes/coinbase-collector-watch'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import type { Env } from '../src/index'

const V10 = '0x0E3dF9510de65469C4518D7843919c0b8C7A7757'
const V11 = '0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88'
const UNKNOWN = '0x9999999999999999999999999999999999999999'
const UNKNOWN2 = '0x7777777777777777777777777777777777777777'

type Answer = { status: number; body: unknown } | 'throw'
type AlertMode = 'ok' | 'down' | 'hang' | 'throw'

let payInvoice: Answer
let alerts: string[]
let alertMode: AlertMode
const originalFetch = globalThis.fetch

function installFetch() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://agentapi.rozo.ai/pay-invoice') {
      if (payInvoice === 'throw') throw new Error('ECONNRESET')
      return new Response(JSON.stringify(payInvoice.body), {
        status: payInvoice.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('https://oapi.dingtalk.com/')) {
      alerts.push(String(init?.body ?? ''))
      if (alertMode === 'hang') return new Promise<Response>(() => {})
      if (alertMode === 'throw') throw new Error('dingtalk down')
      return alertMode === 'down' ? new Response('down', { status: 503 }) : Response.json({ errcode: 0 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    ATOMIC_STORE: makeAtomicStoreMock(),
    PAYINVOICE_ADMIN_SECRET: 'admin',
    DINGTALK_ACCESS_TOKEN: 'ding',
    ...extra,
  } as unknown as Env
}

function signerBody(to: string, value = '10500000', extra: Record<string, unknown> = {}) {
  return {
    success: true,
    mode: 'admin',
    coinbase: { captured: true, protocolVersion: 'v1' },
    signed_collector: { chain_id: 8453, to, value_atomic: value },
    ...extra,
  }
}

beforeEach(() => {
  alerts = []
  alertMode = 'ok'
  payInvoice = { status: 200, body: signerBody(V11) }
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('parseSignedCollector', () => {
  it('accepts the signer shape and lowercases the address', () => {
    expect(parseSignedCollector(signerBody(V11))).toEqual({
      chainId: 8453,
      to: V11.toLowerCase(),
      valueAtomic: 10_500_000n,
    })
  })
  it('rejects absent or malformed fields', () => {
    expect(parseSignedCollector({ success: true })).toBeNull()
    expect(parseSignedCollector(null)).toBeNull()
    expect(parseSignedCollector({ signed_collector: { chain_id: '8453', to: V11, value_atomic: '1' } })).toBeNull()
    expect(parseSignedCollector({ signed_collector: { chain_id: 8453, to: '0x12', value_atomic: '1' } })).toBeNull()
    expect(parseSignedCollector({ signed_collector: { chain_id: 8453, to: V11, value_atomic: '-1' } })).toBeNull()
    expect(parseSignedCollector({ signed_collector: [1] })).toBeNull()
  })
  it('known set holds both Coinbase collectors on Base', () => {
    expect(KNOWN_COINBASE_TOKEN_COLLECTORS.has(`8453:${V10.toLowerCase()}`)).toBe(true)
    expect(KNOWN_COINBASE_TOKEN_COLLECTORS.has(`8453:${V11.toLowerCase()}`)).toBe(true)
    expect(KNOWN_COINBASE_TOKEN_COLLECTORS.size).toBe(2)
  })
  it('short invoice ids keep only a prefix', () => {
    expect(shortInvoiceId('pl_01ABCDEFGHIJKLMNOP')).toBe('pl_01ABCDEF…')
    expect(shortInvoiceId('paymentSession_a5306b93-e4b7-4c28')).toBe('paymentSession_a5306b93…')
  })
})

describe('callAgentApiPayInvoice + collector watch', () => {
  it('known collector (v1.0 and v1.1): no alert, result unchanged', async () => {
    const env = makeEnv()
    for (const to of [V10, V11]) {
      payInvoice = { status: 200, body: signerBody(to) }
      const r = await callAgentApiPayInvoice(env, 'pl_abc123', undefined, { line: 'checkout' })
      expect(r).toEqual({ ok: true, status: 200, body: signerBody(to) })
    }
    expect(alerts).toHaveLength(0)
  })

  it('unknown collector on a v1 link: alerts with amount, masked contract; payment result unchanged', async () => {
    payInvoice = { status: 200, body: signerBody(UNKNOWN, '12345678') }
    const r = await callAgentApiPayInvoice(makeEnv(), 'pl_abc123XYZ987', undefined, { line: 'checkout' })
    expect(r).toEqual({ ok: true, status: 200, body: signerBody(UNKNOWN, '12345678') })
    expect(alerts).toHaveLength(1)
    const text = alerts[0]
    expect(text).toContain('UNKNOWN collector contract')
    expect(text).toContain('not blocked')
    expect(text).not.toContain('paid as normal')
    expect(text).toContain('Amount: 12.34 USDC')
    expect(text).not.toContain('LARGE')
    expect(text).toContain('crypto checkout order')
    expect(text).toContain('pl_abc123XY…')
    expect(text).not.toContain('pl_abc123XYZ987')
    expect(text).toContain('Base (8453)')
    expect(text).toContain('0x9999')
    expect(text).not.toContain(UNKNOWN)
  })

  it('unknown collector on a v3 session (UPI cash): alerts with order prefix', async () => {
    payInvoice = { status: 200, body: signerBody(UNKNOWN, '11130000') }
    const r = await callAgentApiPayInvoice(makeEnv(), 'paymentSession_a5306b93-e4b7', undefined, {
      line: 'upi_v1',
      ref: '11111111-2222-4333-8444-555555555555',
    })
    expect(r.ok).toBe(true)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('UPI cash order (MuggleLink), order 11111111')
    expect(alerts[0]).toContain('paymentSession_a5306b93…')
    expect(alerts[0]).toContain('Amount: 11.13 USDC')
  })

  it('dedupes per contract; the first payment alerts, a large one alerts separately', async () => {
    const env = makeEnv()
    payInvoice = { status: 200, body: signerBody(UNKNOWN, '5000000') }
    await callAgentApiPayInvoice(env, 'pl_a', undefined, { line: 'checkout' })
    await callAgentApiPayInvoice(env, 'pl_b', undefined, { line: 'coupon' })
    expect(alerts).toHaveLength(1)
    payInvoice = { status: 200, body: signerBody(UNKNOWN, '150000000') }
    await callAgentApiPayInvoice(env, 'pl_c', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(2)
    expect(alerts[1]).toContain('Amount: 150.00 USDC (LARGE')
    await callAgentApiPayInvoice(env, 'pl_d', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(2)
    // A different unknown contract is its own key.
    payInvoice = { status: 200, body: signerBody(UNKNOWN2, '5000000') }
    await callAgentApiPayInvoice(env, 'pl_e', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(3)
  })

  it('failed delivery holds only the 10-minute claim; confirmed delivery holds the full window', async () => {
    const t0 = Date.parse('2026-11-13T00:00:00Z')
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    payInvoice = { status: 200, body: signerBody(UNKNOWN, '5000000') }
    const down = makeEnv()
    alertMode = 'down'
    await callAgentApiPayInvoice(down, 'pl_a', undefined, { line: 'checkout' })
    now.mockReturnValue(t0 + 5 * 60_000)
    await callAgentApiPayInvoice(down, 'pl_b', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(1)
    now.mockReturnValue(t0 + 11 * 60_000)
    await callAgentApiPayInvoice(down, 'pl_c', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(2)

    alerts = []
    alertMode = 'ok'
    const up = makeEnv()
    now.mockReturnValue(t0)
    await callAgentApiPayInvoice(up, 'pl_a', undefined, { line: 'checkout' })
    now.mockReturnValue(t0 + 11 * 60_000)
    await callAgentApiPayInvoice(up, 'pl_b', undefined, { line: 'checkout' })
    now.mockReturnValue(t0 + 5 * 3600_000)
    await callAgentApiPayInvoice(up, 'pl_c', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(1)
    now.mockReturnValue(t0 + 6 * 3600_000 + 60_000)
    await callAgentApiPayInvoice(up, 'pl_d', undefined, { line: 'checkout' })
    expect(alerts).toHaveLength(2)
  })

  it('registers the alert with waitUntil when given, only for unknown collectors', async () => {
    const registered: Promise<unknown>[] = []
    const waitUntil = (p: Promise<unknown>) => void registered.push(p)
    payInvoice = { status: 200, body: signerBody(V11) }
    await callAgentApiPayInvoice(makeEnv(), 'pl_a', undefined, { line: 'checkout', waitUntil })
    expect(registered).toHaveLength(0)
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    await callAgentApiPayInvoice(makeEnv(), 'pl_b', undefined, { line: 'checkout', waitUntil })
    expect(registered).toHaveLength(1)
    await registered[0]
    expect(alerts).toHaveLength(1)
  })

  it('a throwing waitUntil does not affect the result', async () => {
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    const r = await callAgentApiPayInvoice(makeEnv(), 'pl_b', undefined, {
      line: 'checkout',
      waitUntil: () => {
        throw new Error('no ctx')
      },
    })
    expect(r.ok).toBe(true)
    expect(alerts).toHaveLength(1)
  })

  it('signer 500 after signing still alerts; result unchanged', async () => {
    const body = { error: 'coinbase pay failed (admin mode): boom', signed_collector: { chain_id: 8453, to: UNKNOWN, value_atomic: '1000000' } }
    payInvoice = { status: 500, body }
    const r = await callAgentApiPayInvoice(makeEnv(), 'pl_x', undefined, { line: 'upi_v1', ref: 'abcdef12-0000' })
    expect(r).toEqual({ ok: false, status: 500, body })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('signer HTTP 500')
  })

  for (const mode of ['down', 'throw'] as const) {
    it(`alert delivery ${mode}: payment result unchanged, no throw`, async () => {
      alertMode = mode
      payInvoice = { status: 200, body: signerBody(UNKNOWN) }
      const r = await callAgentApiPayInvoice(makeEnv(), 'pl_x', undefined, { line: 'checkout' })
      expect(r).toEqual({ ok: true, status: 200, body: signerBody(UNKNOWN) })
    })
  }

  it('alert delivery hangs: caller continues within the budget', async () => {
    alertMode = 'hang'
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    const t0 = Date.now()
    const r = await callAgentApiPayInvoice(makeEnv(), 'pl_x', undefined, { line: 'checkout' })
    const ms = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(ms).toBeLessThan(3_000)
  }, 10_000)

  it('watch itself bounded: a hanging dedupe store does not hold the caller', async () => {
    const env = makeEnv({ ATOMIC_STORE: { idFromName: () => ({}), get: () => ({ fetch: () => new Promise(() => {}) }) } as any })
    const t0 = Date.now()
    await watchSignedCollector(env, { invoiceId: 'pl_x', line: 'checkout', signerStatus: 200, body: signerBody(UNKNOWN) }, 50)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('a broken dedupe store never throws', async () => {
    const env = makeEnv({ ATOMIC_STORE: undefined as any })
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    const r = await callAgentApiPayInvoice(env, 'pl_x', undefined, { line: 'checkout' })
    expect(r.ok).toBe(true)
    expect(alerts).toHaveLength(0)
  })

  it('no alert channel configured: no alert, result unchanged, log masked', async () => {
    const env = makeEnv({ DINGTALK_ACCESS_TOKEN: undefined } as any)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    const r = await callAgentApiPayInvoice(env, 'pl_x', undefined, { line: 'checkout' })
    expect(r.ok).toBe(true)
    expect(alerts).toHaveLength(0)
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('0x9999…9999')
    expect(logged).not.toContain(UNKNOWN)
  })

  it('reward calls (expected_binding) are never watched', async () => {
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    await callAgentApiPayInvoice(
      makeEnv(),
      'pl_x',
      { version: 'upi-reward-binding-v1', invoice_key: 'pl_x', amount_atomic: '1', fingerprint: 'a'.repeat(64) },
      { line: 'upi_v1' },
    )
    expect(alerts).toHaveLength(0)
  })

  it('older signer without signed_collector, or no watch requested: nothing happens', async () => {
    payInvoice = { status: 200, body: { success: true, mode: 'admin', coinbase: { captured: true } } }
    await callAgentApiPayInvoice(makeEnv(), 'pl_x', undefined, { line: 'checkout' })
    payInvoice = { status: 200, body: signerBody(UNKNOWN) }
    await callAgentApiPayInvoice(makeEnv(), 'pl_x')
    expect(alerts).toHaveLength(0)
  })

  it('legacy request body is byte-for-byte unchanged', async () => {
    let sent = ''
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      sent = String(init?.body)
      return Response.json(signerBody(V11))
    }) as typeof fetch
    await callAgentApiPayInvoice(makeEnv(), 'pl_abc', undefined, { line: 'checkout' })
    expect(sent).toBe('{"payment_id":"pl_abc"}')
  })
})
