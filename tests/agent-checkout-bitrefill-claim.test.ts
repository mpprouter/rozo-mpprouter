import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import { bitrefillClaimInvoiceKey } from '../src/routes/bitrefill-invoice'
import { claimInvoiceKey, readInvoiceClaim } from '../src/routes/invoice-claim'
import { createQuoteReceipt, quoteIdentity } from '../src/routes/quote-receipt'
import type { Env } from '../src/index'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

const ADDR = '0x1111111111111111111111111111111111111111'

function makeEnv(extra: Record<string, string> = {}): Env {
  const store = new Map<string, string>()
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    BITREFILL_ENABLED: 'true',
    ROZO_BITREFILL_API_KEY: 'bitrefill-key',
    ATOMIC_STORE: makeAtomicStoreMock(),
    MPP_STORE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    },
    ...extra,
  } as unknown as Env
}

let createdIntent: any = null
let posts = 0
let existingOrder: any = null
let seenKeys: string[] = []
let rozoExpiresAt = '2999-01-01T12:00:00.000Z'
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

beforeEach(() => {
  createdIntent = null
  posts = 0
  existingOrder = null
  seenKeys = []
  rozoExpiresAt = '2999-01-01T12:00:00.000Z'
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    seenKeys.push(new Headers(init?.headers).get('X-API-Key') ?? '')
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/payments/order/')) {
      return existingOrder
        ? new Response(JSON.stringify(existingOrder), { status: 200 })
        : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      posts++
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({
        id: 'rozo-pay-bitrefill',
        paymentLink: 'https://pay.rozo.ai/b',
        expiresAt: rozoExpiresAt,
        source: { amount: '12.37', chainId: '1500' },
      }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
})

afterEach(() => vi.restoreAllMocks())

function body(over: Record<string, unknown> = {}, br: Record<string, unknown> = {}) {
  return {
    provider: 'bitrefill',
    bitrefill: { invoiceId: 'inv-abc123', address: ADDR, amount: '12.345678', expiresAt: inMinutes(15), ...br },
    source: { chainId: '1500', tokenSymbol: 'USDC' },
    ...over,
  }
}

async function post(b: unknown, env = makeEnv()) {
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

describe('Bitrefill joins the cross-entry invoice claim (Agent Checkout G8)', () => {
  it('a create takes the claim for its own order and may re-enter', async () => {
    const env = makeEnv()
    const first = await post(body(), env)
    expect(first.status).toBe(200)
    expect(await readInvoiceClaim(env, bitrefillClaimInvoiceKey('inv-abc123'))).toMatchObject({ channel: 'crypto', ref: 'bitrefill_inv-abc123' })
    existingOrder = { id: 'rozo-pay-bitrefill' }
    const again = await post(body(), env)
    expect(again.status).toBe(409)
    expect(again.json.error).toBe('DUPLICATE_INVOICE')
  })

  it('an invoice already claimed by another entry is refused before any order is created', async () => {
    const env = makeEnv()
    await claimInvoiceKey(env, bitrefillClaimInvoiceKey('INV-ABC123'), 'crypto', 'exec:other')
    const res = await post(body(), env)
    expect(res.status).toBe(409)
    expect(res.json.error).toBe('INVOICE_CLAIMED')
    expect(posts).toBe(0)
  })

  it('claim keys are case-insensitive', () => {
    expect(bitrefillClaimInvoiceKey(' EC9482DE-AAAA ')).toBe('bitrefill:ec9482de-aaaa')
  })
})

describe('quote identity (Agent Checkout G5)', () => {
  it('is stable for one receipt and carries the receipt expiry', async () => {
    const r = await createQuoteReceipt('pl_x', '1.00', 'M', 'secret', 1_000)
    const a = await quoteIdentity(r)
    expect(a).toEqual(await quoteIdentity(r))
    expect(a!.quoteId).toMatch(/^q_[0-9a-f]{32}$/)
    expect(a!.quoteExpiresAt).toBe(new Date(1_600 * 1000).toISOString())
    const other = await quoteIdentity(await createQuoteReceipt('pl_x', '1.00', 'M', 'secret', 1_001))
    expect(other!.quoteId).not.toBe(a!.quoteId)
    expect(await quoteIdentity('garbage')).toBeNull()
  })
})
