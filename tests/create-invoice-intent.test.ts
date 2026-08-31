/**
 * create-invoice honors the optional `intent: "stellar_payin_contracts"`.
 *
 * The intent is passed through to the Rozo payment-api on CREATE (which then
 * freezes contract pay-in mode and exposes receiverAddressContract +
 * receiverMemoContract), is rejected for non-Stellar sources and unknown
 * values, and — because upstream freezes the mode at create time — a REUSED
 * classic order is reported via `intentMismatch` instead of silently handing
 * back a G-address order the caller did not ask for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import type { Env } from '../src/index'

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
/** When set, the idempotency lookup returns this instead of 404. */
let existingIntent: any = null

function installFetchMock() {
  createdIntent = null
  existingIntent = null
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
      return existingIntent
        ? new Response(JSON.stringify(existingIntent), { status: 200 })
        : new Response('not found', { status: 404 })
    }
    if (u.includes('/payment-api')) {
      createdIntent = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({
          id: 'rozo-pay-1',
          paymentLink: 'https://pay.rozo.ai/x',
          expiresAt: '2999-01-01T00:00:00.000Z',
        }),
        { status: 200 },
      )
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

const STELLAR_SOURCE = { chainId: '1500', tokenSymbol: 'USDC' }
const PAYMENT_ID = 'paymentSession_intent_test'

beforeEach(() => {
  installFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('create-invoice — stellar_payin_contracts intent', () => {
  it('passes the intent through to the created Rozo payment', async () => {
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      intent: 'stellar_payin_contracts',
    })
    expect(status).toBe(200)
    expect(json.reused).toBe(false)
    expect(json.source.chainId).toBe('1500')
    expect(createdIntent.intent).toBe('stellar_payin_contracts')
    expect(createdIntent.source.chainId).toBe('1500')
  })

  it('omits intent from the upstream body when not requested', async () => {
    const { status } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
    })
    expect(status).toBe(200)
    expect('intent' in createdIntent).toBe(false)
  })

  it('rejects unknown intent values', async () => {
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      intent: 'solana_hub_memo',
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_INTENT')
    expect(createdIntent).toBeNull()
  })

  it('rejects the intent for non-Stellar sources', async () => {
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: { chainId: '8453', tokenSymbol: 'USDC' },
      intent: 'stellar_payin_contracts',
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_INTENT')
    expect(createdIntent).toBeNull()
  })

  it('flags intentMismatch when reusing a classic (non-contract) order', async () => {
    existingIntent = {
      id: 'rozo-pay-existing',
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      paymentLink: 'https://pay.rozo.ai/existing',
      source: {
        chainId: '1500',
        tokenSymbol: 'USDC',
        amount: '10.5',
        receiverAddress: 'GHUBADDRESS',
        receiverMemo: 'memo123',
      },
    }
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      intent: 'stellar_payin_contracts',
    })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.intentMismatch).toBe(true)
    expect(String(json.warnings?.join(' '))).toContain('stellar_payin_contracts')
    // No new order was created behind the reuse.
    expect(createdIntent).toBeNull()
  })

  it('does not flag intentMismatch when the reused order is already contract-mode', async () => {
    existingIntent = {
      id: 'rozo-pay-existing',
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      paymentLink: 'https://pay.rozo.ai/existing',
      source: {
        chainId: '1500',
        tokenSymbol: 'USDC',
        amount: '10.5',
        receiverAddress: 'GHUBADDRESS',
        receiverAddressContract: 'CCONTRACTADDRESS',
        receiverMemoContract: 'memo_123',
      },
    }
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      intent: 'stellar_payin_contracts',
    })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.intentMismatch).toBeUndefined()
  })

  it('flags intentMismatch when reusing a contract-mode order WITHOUT the intent', async () => {
    existingIntent = {
      id: 'rozo-pay-existing',
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      paymentLink: 'https://pay.rozo.ai/existing',
      source: {
        chainId: '1500',
        tokenSymbol: 'USDC',
        amount: '10.5',
        receiverAddress: 'GHUBADDRESS',
        receiverAddressContract: 'CCONTRACTADDRESS',
        receiverMemoContract: 'memo_123',
      },
    }
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
    })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(json.intentMismatch).toBe(true)
    expect(String(json.warnings?.join(' '))).toContain('receiverAddressContract')
  })

  it('returns 400 (not a crash) for an object intent with poisoned coercion hooks', async () => {
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      intent: { toString: null, valueOf: null },
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_INTENT')
  })

  it('rejects the intent on Stripe invoices instead of silently dropping it', async () => {
    const { status, json } = await createInvoice({
      url: 'https://crypto.stripe.com/pay/CDMTestBlob_ABC123xyz',
      source: STELLAR_SOURCE,
      intent: 'stellar_payin_contracts',
    })
    expect(status).toBe(400)
    expect(json.code).toBe('INVALID_INTENT')
  })
})
