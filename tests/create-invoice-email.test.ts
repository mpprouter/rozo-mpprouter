/**
 * create-invoice accepts an optional payer contact `email`.
 *
 * Absent/empty keeps the old upstream body byte-for-byte (no `email` key);
 * a valid address is trimmed + lowercased and forwarded as the payment-api
 * top-level `email` (stored as intents_payments.user_email); anything else is
 * a 400 INVALID_EMAIL before any upstream call. Also covers Bitrefill.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import type { Env } from '../src/index'
import { normalizeContactEmail } from '../src/routes/contact-email'

function makeKvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  }
}

function makeEnv(): Env {
  return {
    PAYINVOICE_ADMIN_SECRET: 'test-admin-secret',
    ROZO_INTENTS_API_KEY: 'test-key',
    MPP_STORE: makeKvStub(),
  } as unknown as Env
}

/** Captures the body POSTed to the Rozo intents API so we can assert on it. */
let createdIntent: any = null
/** Rows returned by the idempotency lookup, keyed by orderId (404 when absent). */
let existingByOrderId: Record<string, any> = {}
/** When set, the create POST answers with this (e.g. a 409 orderIdConflict). */
let createResponseOverride: (() => Response) | null = null
/** Status returned by GET /payments/:id (the post-create supersede re-check). */
let refetchStatus = 'payment_unpaid'

/** Back-compat setter used by the older tests: seeds the BASE orderId. */
function setExistingIntent(row: any) {
  existingByOrderId['paymentSession_intent_test'] = row
}

function installFetchMock() {
  createdIntent = null
  existingByOrderId = {}
  createResponseOverride = null
  refetchStatus = 'payment_unpaid'
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
    const u =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.includes('/quote-invoice')) {
      return new Response(
        JSON.stringify({
          invoice: { amount: '10.5' },
          merchant: 'OpenRouter, Inc',
          linkId: 'paymentSession_intent_test',
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payments/order/')) {
      const lookedUp = decodeURIComponent(u.split('/').pop() ?? '')
      const row = existingByOrderId[lookedUp]
      if (row === 'LOOKUP_500') return new Response('upstream down', { status: 500 })
      return row
        ? new Response(JSON.stringify(row), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api') && init?.method === 'POST') {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      if (createResponseOverride) return createResponseOverride()
      return new Response(
        JSON.stringify({
          id: 'rozo-pay-1',
          paymentLink: 'https://pay.rozo.ai/x',
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      )
    }
    if (u.includes('/payment-api')) {
      // GET /payments/:id — the post-create supersede race re-check.
      return new Response(JSON.stringify({ status: refetchStatus }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch)
}

async function createInvoice(body: Record<string, unknown>) {
  const res = await handleCreateInvoice(
    new Request('https://mpp.test/create-invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    makeEnv(),
  )
  return { status: res.status, json: (await res.json()) as any }
}

const PAYMENT_ID = 'paymentSession_intent_test'
const STELLAR_SOURCE = { chainId: '1500', tokenSymbol: 'USDC' }
const LIGHTNING_SOURCE = { chainId: 'lightning', tokenSymbol: 'BTC' }

beforeEach(() => {
  installFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeContactEmail', () => {
  it('treats absent, null and blank as no email', () => {
    expect(normalizeContactEmail(undefined)).toEqual({ ok: true, email: null })
    expect(normalizeContactEmail(null)).toEqual({ ok: true, email: null })
    expect(normalizeContactEmail('   ')).toEqual({ ok: true, email: null })
  })

  it('trims and lowercases a valid address', () => {
    expect(normalizeContactEmail('  Alice.Pay@Example.COM ')).toEqual({
      ok: true,
      email: 'alice.pay@example.com',
    })
  })

  it('rejects malformed, non-string and over-long values', () => {
    for (const bad of ['not-an-email', 'a@b', 'a b@example.com', '@example.com', 'a@@example.com', 'a@example.com\nBcc: x@y.z', 42, {}]) {
      expect(normalizeContactEmail(bad).ok).toBe(false)
    }
    const long = `${'a'.repeat(250)}@example.com`
    expect(normalizeContactEmail(long).ok).toBe(false)
  })
})

describe('create-invoice optional email', () => {
  it('omits email upstream when the caller sends none (backward compatible)', async () => {
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: STELLAR_SOURCE })
    expect(status).toBe(200)
    expect('email' in createdIntent).toBe(false)
    expect(createdIntent.metadata.user_email).toBeUndefined()
  })

  it('omits email upstream when the caller sends an empty string', async () => {
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: STELLAR_SOURCE, email: '' })
    expect(status).toBe(200)
    expect('email' in createdIntent).toBe(false)
  })

  it('forwards a normalized email as the top-level payment-api field (exactIn)', async () => {
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      email: ' Payer@Example.com ',
    })
    expect(status).toBe(200)
    expect(createdIntent.email).toBe('payer@example.com')
    // Not copied into metadata (GET /payments/{id} returns metadata publicly)
    // and never echoed back in our response.
    expect(JSON.stringify(createdIntent.metadata)).not.toContain('payer@example.com')
    expect(JSON.stringify(json)).not.toContain('payer@example.com')
  })

  it('forwards the email on the Lightning (exactOut) body too', async () => {
    const { status } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: LIGHTNING_SOURCE,
      email: 'btc@example.com',
    })
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.email).toBe('btc@example.com')
  })

  it('rejects an invalid email with 400 INVALID_EMAIL before calling upstream', async () => {
    const fetchSpy = globalThis.fetch as unknown as { mock: { calls: unknown[] } }
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      email: 'nope',
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_EMAIL')
    expect(createdIntent).toBeNull()
    expect(fetchSpy.mock.calls.length).toBe(0)
  })

  it('rejects a non-string email with 400 INVALID_EMAIL', async () => {
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      email: ['a@example.com'],
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_EMAIL')
  })

  it('does not attach an email to a reused existing order', async () => {
    existingByOrderId[PAYMENT_ID] = {
      id: 'rozo-pay-existing',
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      paymentLink: 'https://pay.rozo.ai/existing',
      source: { chainId: '1500', tokenSymbol: 'USDC', amount: '10.5' },
    }
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      email: 'late@example.com',
    })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(createdIntent).toBeNull()
  })
})
