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

  // Finding 2: a FINAL payout event that defers for a retryable reason
  // (daily cap reached) must return 503 WITHOUT writing the processed marker,
  // so a replay of the SAME event_id can still settle once the cap resets.
  it('does NOT write the marker when the final payout event defers on daily cap (finding 2)', async () => {
    const kv = new FakeKV()
    const ns = makeAtomicStoreMock()
    // $0 daily cap so any invoice trips daily_cap_reached (retryable on payout).
    const env = { ...envWith(kv, ns), STRIPE_FULFILLMENT_DAILY_CAP_USD: '0.000001' } as Env
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_retry',
      merchantAccount: 'acct_retry',
      invoiceAmountAtomic: '10000000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:retry',
      stripeUrl: 'https://crypto.stripe.com/pay/RETRY',
      rozoPaymentId: '11111111-2222-3333-4444-555555555555',
    })
    // Funder balance RPC returns plenty so the ONLY gate that fires is the cap.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const u = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url)
        if (typeof u === 'string' && (u.includes('pay-invoice') || u.includes('agentapi'))) {
          throw new Error('pay-invoice must not be called when the daily cap is reached')
        }
        // eth_getBalance → 1000 USDC (0x3b9aca00 = 1e9 = 1000 USDC atomic).
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }),
          { status: 200 },
        )
      }),
    )
    const response = await handleRozoWebhook(await signedRequest('evt-cap'), env)
    expect(response.status).toBe(503)
    const body = await response.json() as { retryable?: boolean; deferred?: string }
    expect(body.retryable).toBe(true)
    expect(body.deferred).toBe('daily_cap_reached')
    // The processed marker must be ABSENT so the event can be replayed.
    expect(kv.store.has('webhook-event:evt-cap')).toBe(false)
  })

  // Finding 2, full recovery loop: provider_disabled defers WITHOUT a marker,
  // then a replay of the SAME event_id settles once the provider is enabled.
  it('provider_disabled payout event stays unmarked; the SAME event replays and settles (finding 2)', async () => {
    const kv = new FakeKV()
    const ns = makeAtomicStoreMock()
    const env = envWith(kv, ns)
    await seedStripeRecord(env, {
      invoiceKey: 'cpis_retry',
      merchantAccount: 'acct_retry',
      invoiceAmountAtomic: '10000000',
      invoiceCurrency: 'usd',
      lockFingerprint: 'sha256:retry',
      stripeUrl: 'https://crypto.stripe.com/pay/RETRY',
      rozoPaymentId: '11111111-2222-3333-4444-555555555555',
    })

    // Phase 1: downstream pay-invoice is fail-closed disabled.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input instanceof Request ? input.url : input)
        if (u.includes('pay-invoice') || u.includes('agentapi')) {
          return new Response(
            JSON.stringify({ code: 'stripe_fulfillment_disabled', error: 'disabled' }),
            { status: 403 },
          )
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }),
          { status: 200 },
        )
      }),
    )
    const first = await handleRozoWebhook(await signedRequest('evt-disabled'), env)
    expect(first.status).toBe(503)
    const firstBody = await first.json() as { retryable?: boolean; ok?: boolean }
    expect(firstBody.retryable).toBe(true)
    expect(firstBody.ok).toBe(false)
    expect(kv.store.has('webhook-event:evt-disabled')).toBe(false)
    {
      const { value } = await casRead(env, stripeKvKey('cpis_retry'))
      expect(JSON.parse(value!).status).toBe('provider_disabled')
    }

    // Phase 2: provider enabled — the SAME event_id replays and settles.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input instanceof Request ? input.url : input)
        if (u.includes('pay-invoice') || u.includes('agentapi')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }),
          { status: 200 },
        )
      }),
    )
    const second = await handleRozoWebhook(await signedRequest('evt-disabled'), env)
    expect(second.status).toBe(200)
    expect(kv.store.get('webhook-event:evt-disabled')).toBe('1')
    {
      const { value } = await casRead(env, stripeKvKey('cpis_retry'))
      expect(JSON.parse(value!).status).toBe('provider_submitted')
    }
  })
})
