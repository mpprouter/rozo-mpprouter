/**
 * create-invoice forwards the checkout's self-reported pay method
 * (`pay_method`, enum) and landing marker (`landing_param`, e.g. "via=cashu")
 * as flat metadata keys next to `metadata.client`. Whitelisted; anything else
 * is dropped, never rejected, and never changes the rest of the order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleCreateInvoice,
  resolveLandingParam,
  resolvePayMethod,
} from '../src/routes/create-invoice'
import type { Env } from '../src/index'

describe('resolvePayMethod', () => {
  it('accepts only the enum', () => {
    expect(resolvePayMethod('cashu')).toBe('cashu')
    expect(resolvePayMethod('lightning')).toBe('lightning')
    expect(resolvePayMethod('unknown')).toBe('unknown')
    for (const bad of ['Cashu', 'cashu ', 'ecash', '', 'constructor', '__proto__', 1, null, undefined, {}, ['cashu']]) {
      expect(resolvePayMethod(bad)).toBeNull()
    }
  })
})

describe('resolveLandingParam', () => {
  it('accepts query-shaped values up to 64 chars', () => {
    expect(resolveLandingParam('via=cashu')).toBe('via=cashu')
    expect(resolveLandingParam('a'.repeat(64))).toBe('a'.repeat(64))
  })
  it('drops oversize, empty, non-string and unsafe values', () => {
    for (const bad of [
      'a'.repeat(65),
      'x'.repeat(100_000),
      '',
      ' via=cashu',
      'via="cashu"',
      "via='x';drop",
      '<script>',
      'https://evil.example/x',
      'via=cashu\n',
      'via=ca\u0000shu',
      'via=cashü',
      42,
      null,
      { via: 'cashu' },
    ]) {
      expect(resolveLandingParam(bad)).toBeNull()
    }
  })
})

// ── Integration ──────────────────────────────────────────────────────────────

function makeEnv(): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
  } as unknown as Env
}

const PAYMENT_ID = 'paymentSession_pay_method_test'
let createdIntent: any = null

function installFetchMock() {
  createdIntent = null
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({ invoice: { amount: '10' }, merchant: 'OpenRouter, Inc', linkId: PAYMENT_ID }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) return new Response('not found', { status: 404 })
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({ id: 'rozo-pay-1', paymentLink: 'https://pay.rozo.ai/x', expiresAt: '2999-01-01T00:00:00.000Z' }),
        { status: 200 },
      )
    }
    if (u.includes('/payment-api')) {
      return new Response(JSON.stringify({ status: 'payment_unpaid' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

async function createInvoice(body: Record<string, unknown>) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify(body),
    }),
    makeEnv(),
  )
  return { status: res.status, json: (await res.json()) as any }
}

const LIGHTNING_SOURCE = { chainId: 'lightning', tokenSymbol: 'BTC' }
const EVM_SOURCE = { chainId: '8453', tokenSymbol: 'USDC' }

beforeEach(() => installFetchMock())
afterEach(() => vi.restoreAllMocks())

describe('create-invoice — pay_method / landing_param', () => {
  it('forwards pay_method=cashu and landing_param on the Lightning path', async () => {
    const { status } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: LIGHTNING_SOURCE,
      client: 'rozo-checkout-web',
      pay_method: 'cashu',
      landing_param: 'via=cashu',
    })
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.metadata.pay_method).toBe('cashu')
    expect(createdIntent.metadata.landing_param).toBe('via=cashu')
    // client stays a string label; existing keys untouched.
    expect(createdIntent.metadata.client).toBe('rozo-checkout-web')
    expect(createdIntent.metadata.source).toBe('mpprouter-create-invoice')
    expect(createdIntent.metadata.coinbasePaymentLinkId).toBeTruthy()
    // Not leaked as top-level intent fields.
    expect(createdIntent.pay_method).toBeUndefined()
    expect(createdIntent.landing_param).toBeUndefined()
  })

  it('forwards them on the EVM (exactIn) path too', async () => {
    await createInvoice({ payment_id: PAYMENT_ID, source: EVM_SOURCE, pay_method: 'unknown', landing_param: 'via=x' })
    expect(createdIntent.type).toBe('exactIn')
    expect(createdIntent.metadata.pay_method).toBe('unknown')
    expect(createdIntent.metadata.landing_param).toBe('via=x')
  })

  it('ignores an invalid pay_method without failing the request', async () => {
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: LIGHTNING_SOURCE, pay_method: 'evil<script>' })
    expect(status).toBe(200)
    expect('pay_method' in createdIntent.metadata).toBe(false)
  })

  it('ignores an oversize landing_param without failing the request', async () => {
    const { status } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: LIGHTNING_SOURCE,
      pay_method: 'cashu',
      landing_param: 'via=' + 'c'.repeat(61),
    })
    expect(status).toBe(200)
    expect(createdIntent.metadata.pay_method).toBe('cashu')
    expect('landing_param' in createdIntent.metadata).toBe(false)
  })

  it('changes nothing else about the order or the response', async () => {
    const baseline = await createInvoice({ payment_id: PAYMENT_ID, source: LIGHTNING_SOURCE })
    const baseIntent = createdIntent
    vi.restoreAllMocks()
    installFetchMock()
    const run = await createInvoice({
      payment_id: PAYMENT_ID,
      source: LIGHTNING_SOURCE,
      pay_method: 'cashu',
      landing_param: 'via=cashu',
    })
    expect(run.status).toBe(baseline.status)
    expect(run.json).toEqual(baseline.json)
    const { metadata: m1, ...rest1 } = createdIntent
    const { metadata: m0, ...rest0 } = baseIntent
    expect(rest1).toEqual(rest0)
    const { pay_method: _p, landing_param: _l, ...md1 } = m1
    expect(md1).toEqual(m0)
  })
})
