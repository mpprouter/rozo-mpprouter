import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { handleRozoWebhook } from '../src/routes/webhook'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import {
  seedStripeRecord,
  stripeKvKey,
} from '../src/routes/stripe-fulfillment'
import { casRead } from '../src/routes/stripe-atomic'

const WEBHOOK_SECRET = 'stripe-retry-test-secret'

class FakeKV {
  readonly store = new Map<string, string>()

  async get(key: string) {
    return this.store.get(key) ?? null
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

async function signedRequest(eventId: string): Promise<Request> {
  const rawBody = JSON.stringify({
    event_id: eventId,
    type: 'payment_payout_completed',
    data: {
      id: '11111111-2222-3333-4444-555555555555',
      orderId: 'stripe_crypto_cpis_retry',
      destination: { amount: '10.00' },
    },
  })
  const timestamp = Date.now().toString()
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  )
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return new Request('https://router.test/v1/services/rozo-agent-api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rozo-timestamp': timestamp,
      'x-rozo-signature': `sha256=${signatureHex}`,
    },
    body: rawBody,
  })
}

function envWith(kv: FakeKV, atomicStore: DurableObjectNamespace): Env {
  return {
    MPP_STORE: kv,
    ATOMIC_STORE: atomicStore,
    ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PAYINVOICE_ADMIN_SECRET: 'admin',
    INVOICE_CAPABILITY_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(5)).toString('base64'),
  } as unknown as Env
}

describe('Stripe webhook processed marker timing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not mark the event processed when AtomicStoreDO fails transiently', async () => {
    const kv = new FakeKV()
    const failingNamespace = {
      idFromName: () => ({ name: 'stripe-fulfillment' }),
      get: () => ({
        fetch: async () => new Response('temporarily unavailable', { status: 503 }),
      }),
    } as unknown as DurableObjectNamespace

    await expect(
      handleRozoWebhook(
        await signedRequest('evt-do-down'),
        envWith(kv, failingNamespace),
      ),
    ).rejects.toThrow(/stripe-atomic \/read failed \(503\)/)

    expect(kv.store.has('webhook-event:evt-do-down')).toBe(false)
  })

  it('releases the claim and leaves the marker absent when funder reservation DO fails', async () => {
    const kv = new FakeKV()
    const workingNamespace = makeAtomicStoreMock()
    const env = envWith(kv, workingNamespace)
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_retry',
      merchantAccount: 'acct_retry',
      invoiceAmountAtomic: '10000000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:retry',
      stripeUrl: 'https://crypto.stripe.com/pay/RETRY',
      rozoPaymentId: '11111111-2222-3333-4444-555555555555',
    })

    const underlyingStub = workingNamespace.get(
      workingNamespace.idFromName('stripe-fulfillment'),
    )
    env.ATOMIC_STORE = {
      idFromName: (name: string) => workingNamespace.idFromName(name),
      get: () => ({
        fetch: async (request: Request) => {
          const body = await request.clone().json() as { key?: string }
          if (body.key === 'funder-reservations:v1') {
            return new Response('temporarily unavailable', { status: 503 })
          }
          return underlyingStub.fetch(request)
        },
      }),
    } as unknown as DurableObjectNamespace
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }),
        { status: 200 },
      )),
    )

    await expect(
      handleRozoWebhook(await signedRequest('evt-reserve-down'), env),
    ).rejects.toThrow(/stripe-atomic \/read failed \(503\)/)

    expect(kv.store.has('webhook-event:evt-reserve-down')).toBe(false)
    const { value } = await casRead(env, stripeKvKey('cpis_retry'))
    expect(JSON.parse(value!).status).toBe('payout_seen')
  })

  it('writes the marker only after Stripe orchestration returns', async () => {
    const kv = new FakeKV()
    const response = await handleRozoWebhook(
      await signedRequest('evt-complete'),
      envWith(kv, makeAtomicStoreMock()),
    )

    expect(response.status).toBe(200)
    expect(kv.store.get('webhook-event:evt-complete')).toBe('1')
  })
})
