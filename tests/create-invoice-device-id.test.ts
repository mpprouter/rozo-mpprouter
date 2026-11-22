/**
 * create-invoice forwards an optional browser `deviceId` (device-id-forward.ts).
 *
 * Absent keeps the upstream create body byte-for-byte; a well-formed UUID is
 * trimmed + lowercased and forwarded as the payment-api top-level `deviceId`
 * (payment-api writes payer_order_links linked_via='create'); anything else
 * is dropped and the order is still created. The id is never logged, never
 * copied into metadata and never echoed back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCreateInvoice } from '../src/routes/create-invoice'
import type { Env } from '../src/index'
import { deviceIdField, readDeviceId } from '../src/routes/device-id-forward'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'

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
    ATOMIC_STORE: makeAtomicStoreMock(),
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
        : new Response('{"error":{"code":"paymentNotFound","message":"Payment not found"}}', { status: 404 })
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


const DEVICE_ID = '3f2b8c1e-7a4d-4e9b-9c2a-1d5e6f7a8b9c'

function expectNotLogged(spies: Array<{ mock: { calls: unknown[][] } }>, needle: string) {
  for (const s of spies) {
    for (const call of s.mock.calls) {
      expect(JSON.stringify(call.map((a) => (a instanceof Error ? a.message : a)))).not.toContain(needle)
    }
  }
}

describe('readDeviceId', () => {
  it('accepts a UUID, trimmed and lowercased', () => {
    expect(readDeviceId({ deviceId: DEVICE_ID })).toBe(DEVICE_ID)
    expect(readDeviceId({ deviceId: `  ${DEVICE_ID.toUpperCase()} ` })).toBe(DEVICE_ID)
  })

  it('returns null for absent, non-string, malformed, 64-hex and oversized values', () => {
    for (const parsed of [
      undefined,
      null,
      [],
      'x',
      {},
      { deviceId: null },
      { deviceId: '' },
      { deviceId: 42 },
      { deviceId: [DEVICE_ID] },
      { deviceId: { id: DEVICE_ID } },
      { deviceId: 'not-a-uuid' },
      { deviceId: DEVICE_ID.replace(/-/g, '') },
      { deviceId: `${DEVICE_ID}0` },
      { deviceId: `${DEVICE_ID}\n` + 'x' },
      { deviceId: 'g'.repeat(8) + DEVICE_ID.slice(8) },
      { deviceId: 'ab'.repeat(32) },
      { deviceId: ' '.repeat(40) + DEVICE_ID },
      // Only the camelCase field is read; aliases and a hashed key are ignored.
      { device_id: DEVICE_ID },
      { deviceKey: 'ab'.repeat(32) },
    ]) {
      expect(readDeviceId(parsed)).toBeNull()
    }
  })

  it('deviceIdField spreads to nothing without an id', () => {
    expect(deviceIdField(null)).toEqual({})
    expect(deviceIdField(undefined)).toEqual({})
    expect(deviceIdField(DEVICE_ID)).toEqual({ deviceId: DEVICE_ID })
  })
})

describe('create-invoice optional deviceId', () => {
  it('leaves the upstream body unchanged when no deviceId is sent', async () => {
    const a = await createInvoice({ payment_id: PAYMENT_ID, source: STELLAR_SOURCE })
    expect(a.status).toBe(200)
    expect('deviceId' in createdIntent).toBe(false)
    const without = JSON.stringify({ ...createdIntent, orderId: null })

    installFetchMock()
    const b = await createInvoice({ payment_id: PAYMENT_ID, source: STELLAR_SOURCE, deviceId: 'nope' })
    expect(b.status).toBe(200)
    // A malformed id is dropped: byte-identical body (orderId aside, it is time-free here).
    expect(JSON.stringify({ ...createdIntent, orderId: null })).toBe(without)
  })

  it('forwards a well-formed deviceId on the exactIn body, never in metadata or the response', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ]
    const { status, json } = await createInvoice({
      payment_id: PAYMENT_ID,
      source: STELLAR_SOURCE,
      deviceId: DEVICE_ID.toUpperCase(),
    })
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactIn')
    expect(createdIntent.deviceId).toBe(DEVICE_ID)
    expect(JSON.stringify(createdIntent.metadata)).not.toContain(DEVICE_ID)
    expect(JSON.stringify(json).toLowerCase()).not.toContain(DEVICE_ID)
    expectNotLogged(spies, DEVICE_ID)
    expectNotLogged(spies, DEVICE_ID.toUpperCase())
  })

  it('forwards the deviceId on the Lightning (exactOut) body too', async () => {
    const { status } = await createInvoice({ payment_id: PAYMENT_ID, source: LIGHTNING_SOURCE, deviceId: DEVICE_ID })
    expect(status).toBe(200)
    expect(createdIntent.type).toBe('exactOut')
    expect(createdIntent.deviceId).toBe(DEVICE_ID)
  })

  it('drops a malformed deviceId and still creates the order', async () => {
    for (const bad of ['not-a-uuid', 'ab'.repeat(32), 42, { x: 1 }, null]) {
      installFetchMock()
      const { status, json } = await createInvoice({ payment_id: PAYMENT_ID, source: STELLAR_SOURCE, deviceId: bad })
      expect(status).toBe(200)
      expect(json.rozoPaymentId ?? json.raw?.id).toBe('rozo-pay-1')
      expect('deviceId' in createdIntent).toBe(false)
    }
  })

  it('does not send the deviceId when an existing order is reused (no create)', async () => {
    existingByOrderId[PAYMENT_ID] = {
      id: 'rozo-pay-existing',
      status: 'payment_unpaid',
      expiresAt: '2999-01-01T00:00:00.000Z',
      paymentLink: 'https://pay.rozo.ai/existing',
      source: { chainId: '1500', tokenSymbol: 'USDC', amount: '10.5' },
    }
    const { status, json } = await createInvoice({ payment_id: PAYMENT_ID, source: STELLAR_SOURCE, deviceId: DEVICE_ID })
    expect(status).toBe(200)
    expect(json.reused).toBe(true)
    expect(createdIntent).toBeNull()
    expect(JSON.stringify(json)).not.toContain(DEVICE_ID)
  })
})
