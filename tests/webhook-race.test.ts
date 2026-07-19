/**
 * Finding 9: a Coinbase webhook invocation that LOSES the funder-reservation
 * race must not write its stale pre-race record snapshot back to KV — an
 * unconditional write landing after the winner's final 'paid' write would roll
 * the terminal state back, and the later replay (the loser returns 503
 * unprocessed) would then re-fire pay-invoice against an already-settled
 * invoice.
 *
 * Deterministic reproduction: the loser loads the (empty) record, then during
 * its balance RPC call the "winner" completes — writes status='paid' to KV and
 * holds the coinbase:<plId> reservation. The loser then sees already_reserved.
 * The 'paid' record must survive untouched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/index'
import { handleRozoWebhook } from '../src/routes/webhook'
import { makeAtomicStoreMock } from './helpers/atomic-store-mock'
import { tryReserveFunder } from '../src/routes/funder-reservation'

const WEBHOOK_SECRET = 'race-test-secret'
const PL_ID = 'pl_racetest1'

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
      id: '99999999-8888-7777-6666-555555555555',
      orderId: PL_ID,
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

// The winner's final KV record: pay-invoice already succeeded.
function paidRecord() {
  return {
    status: 'paid',
    pl_id: PL_ID,
    rozoPaymentId: '99999999-8888-7777-6666-555555555555',
    invoiceAmountAtomic: '10000000',
    funderBalanceAtomic: '1000000000',
    paidAt: new Date().toISOString(),
    coinbaseResult: { ok: true },
    failureReason: null,
    webhookEventIds: ['evt-winner'],
    events: [{ kind: 'pay_invoice_succeeded', at: new Date().toISOString() }],
  }
}

describe('Coinbase webhook reservation-race loser (finding 9)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not clobber the winner\'s terminal record with its stale snapshot', async () => {
    const kv = new FakeKV()
    const env = {
      MPP_STORE: kv,
      ATOMIC_STORE: makeAtomicStoreMock(),
      ROZO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PAYINVOICE_ADMIN_SECRET: 'admin',
      BASE_RPC_URL: 'https://fake-rpc.test',
    } as unknown as Env

    // During the loser's balance RPC call (AFTER it loaded the pre-race
    // record), the winner completes: terminal 'paid' KV write + it still holds
    // the shared-pool reservation for this invoice.
    let winnerSimulated = false
    let payInvoiceCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input instanceof Request ? input.url : input)
        if (u.includes('pay-invoice') || u.includes('agentapi')) {
          payInvoiceCalled = true
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        // Balance JSON-RPC call — first one triggers the winner simulation.
        if (!winnerSimulated) {
          winnerSimulated = true
          kv.store.set(`invoice-fulfillment:${PL_ID}`, JSON.stringify(paidRecord()))
          await tryReserveFunder(env, {
            reservationId: `coinbase:${PL_ID}`,
            amountAtomic: 10_000_000n,
            balanceAtomic: 1_000_000_000n,
          })
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }),
          { status: 200 },
        )
      }),
    )

    const response = await handleRozoWebhook(await signedRequest('evt-loser'), env)

    // Loser defers retryably without a processed marker...
    expect(response.status).toBe(503)
    const body = await response.json() as { deferred?: string; retryable?: boolean }
    expect(body.deferred).toBe('reservation_in_flight')
    expect(body.retryable).toBe(true)
    expect(kv.store.has('webhook-event:evt-loser')).toBe(false)
    // ...never fired a second pay call...
    expect(payInvoiceCalled).toBe(false)
    // ...and the winner's terminal 'paid' record is UNTOUCHED (before the fix
    // the loser's unconditional saveRecord rolled it back to its stale
    // pre-race snapshot).
    const rec = JSON.parse(kv.store.get(`invoice-fulfillment:${PL_ID}`)!)
    expect(rec.status).toBe('paid')
    expect(rec.paidAt).not.toBeNull()
    expect(rec.webhookEventIds).toEqual(['evt-winner'])
  })
})
