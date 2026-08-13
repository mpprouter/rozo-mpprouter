/**
 * Non-custodial channel playground — voucher-authenticated metered call.
 *
 * The isolated pg dispatch, the atomic voucher store, and the upstream charge
 * seam are mocked so these tests isolate the metered-call contract:
 *
 *   - a valid voucher is verified for EXACTLY the real-cost quote and, on a paid
 *     success, the voucher signature is persisted (atomically) and the charge
 *     stands; an insufficient voucher yields the mppx 402, unbilled;
 *   - single source of truth: a 2xx with no signed credential rolls back; an
 *     upstream failure with paymentEvidence 'yes' keeps the charge, 'no' rolls
 *     it back;
 *   - FAIL CLOSED (P0-B): if the voucher signature cannot be persisted, the
 *     charge is rolled back and the call errors.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const CHANNEL = 'C' + 'A'.repeat(55)
const FUNDER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const SIG_HEX = 'aa'.repeat(64)

// In-memory atomic store standing in for the DO-backed Store.cloudflare(...).
const atomic = vi.hoisted(() => {
  const backing = new Map<string, any>()
  const state = { failVoucherUpdate: false }
  const store = {
    get: async (k: string) => (backing.has(k) ? backing.get(k) : null),
    update: async (k: string, cb: (cur: any) => any) => {
      if (state.failVoucherUpdate && k.includes('voucher')) throw new Error('atomic update failed')
      const cur = backing.has(k) ? backing.get(k) : null
      const r = cb(cur)
      if (r.op === 'set') backing.set(k, r.value)
      else if (r.op === 'delete') backing.delete(k)
      return r.result
    },
    delete: async (k: string) => {
      backing.delete(k)
    },
  }
  return { backing, state, store }
})

const h = vi.hoisted(() => ({
  state: {
    sufficient: true,
    capturedAmount: '',
    acceptedAmount: '0.0220000',
    signature: 'aa'.repeat(64),
  } as {
    sufficient: boolean
    capturedAmount: string
    acceptedAmount: string
    signature: string
  },
  acquire: vi.fn(async () => true),
  release: vi.fn(async () => {}),
  rollback: vi.fn(async () => true),
  callUpstream: vi.fn(),
}))

vi.mock('mppx', () => ({
  Credential: { deserialize: () => { throw new Error('recovery not expected in these tests') } },
}))

vi.mock('mppx/server', () => ({
  Store: { cloudflare: () => atomic.store },
  Mppx: { create: () => ({}) },
}))

vi.mock('../src/mpp/kv-atomic-store', () => ({ doAtomicParams: () => ({}) }))

vi.mock('../src/mpp/stellar-channel-dispatch', () => ({
  acquireChannelDeliveryLock: h.acquire,
  releaseChannelDeliveryLock: h.release,
  rollbackFailedChannelVoucher: h.rollback,
  StellarChannelNotRegisteredError: class StellarChannelNotRegisteredError extends Error {},
}))

vi.mock('../src/playground/channel-pg-dispatch', () => {
  function makeMppx() {
    let cb: ((p: unknown) => void) | undefined
    return {
      onPaymentSuccess: (fn: (p: unknown) => void) => {
        cb = fn
      },
      'stellar/channel': (params: { amount: string }) => {
        h.state.capturedAmount = params.amount
        return (_input: Request) => {
          if (!h.state.sufficient) {
            return { status: 402, challenge: new Response('voucher required', { status: 402 }) }
          }
          cb?.({
            challenge: { id: 'chal-1' },
            credential: {
              payload: {
                action: 'voucher',
                amount: h.state.acceptedAmount,
                signature: h.state.signature,
              },
              source: `did:pkh:stellar:pubnet:${FUNDER}`,
            },
            receipt: { reference: 'rcpt-1' },
            request: { amount: h.state.acceptedAmount },
          })
          return { status: 200, withReceipt: (r: Response) => r }
        }
      },
    }
  }
  return {
    resolvePgChannelMppx: async () => ({
      mppx: makeMppx(),
      channelContract: CHANNEL,
      agentAccount: FUNDER,
      channelCurrency: USDC_SAC,
    }),
  }
})

vi.mock('../src/playground/upstream', () => ({
  callUpstreamJson: h.callUpstream,
  resolvePlaygroundRoute: () => ({ id: 'groq', tier: 'cheap' }),
  UpstreamError: class UpstreamError extends Error {
    code: string
    status: number
    paymentEvidence: string
    constructor(code: string, status: number, message: string, ev = 'no') {
      super(message)
      this.code = code
      this.status = status
      this.paymentEvidence = ev
    }
  },
}))

import { handleChannelChat } from '../src/routes/playground-channel'
import { UpstreamError } from '../src/playground/upstream'

function env() {
  return {
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: FUNDER,
    ATOMIC_STORE: {},
    PLAYGROUND_CHANNEL_ENABLED: 'true',
  } as any
}

function chatReq() {
  return new Request('https://api.test/v1/playground/channel/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Payment fake-voucher-credential',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
}

beforeEach(() => {
  atomic.backing.clear()
  atomic.state.failVoucherUpdate = false
  h.state.sufficient = true
  h.state.capturedAmount = ''
  h.state.acceptedAmount = '0.0220000'
  h.state.signature = SIG_HEX
  h.acquire.mockClear()
  h.release.mockClear()
  h.rollback.mockClear()
  h.callUpstream.mockReset()
})

describe('handleChannelChat — real-cost voucher metering', () => {
  it('404s when the channel playground is disabled', async () => {
    const res = await handleChannelChat(chatReq(), { ...env(), PLAYGROUND_CHANNEL_ENABLED: 'false' })
    expect(res.status).toBe(404)
  })

  it('quotes the MAX upstream cost (budget ceiling) + markup and persists the voucher atomically', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'hi there' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.message).toBe('hi there')
    expect(h.state.capturedAmount).toBe('0.0220000')
    expect(json.charged_usd).toBe('0.022')
    expect(json.upstream_cost_usd).toBe('0.0005')
    expect(h.rollback).not.toHaveBeenCalled()
    // Latest voucher persisted in the ATOMIC store (not plain KV).
    const stored = atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)
    expect(stored.signature).toBe(SIG_HEX)
    expect(stored.cumulativeRaw).toBe('220000')
  })

  it('rejects an insufficient voucher delta with the mppx 402 (unbilled)', async () => {
    h.state.sufficient = false
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(402)
    expect(h.callUpstream).not.toHaveBeenCalled()
    expect(h.rollback).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalled()
  })

  it('single source of truth: a 2xx with paid=false rolls the voucher back', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'served without payment' } }] },
      paid: false,
    })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    const json = (await res.json()) as any
    expect(json.error).toBe('upstream_unpaid')
    expect(h.rollback).toHaveBeenCalledWith(expect.anything(), CHANNEL, '0.0220000', '0', 'chal-1')
  })

  it('keeps the charge when a credential was signed but upstream then failed (evidence=yes)', async () => {
    h.callUpstream.mockRejectedValue(new UpstreamError('upstream_over_budget', 502, 'boom', 'yes'))
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    const json = (await res.json()) as any
    expect(json.support_note).toBeTruthy()
    expect(h.rollback).not.toHaveBeenCalled()
    // Charge stands → voucher persisted for collection.
    expect(atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)?.signature).toBe(SIG_HEX)
  })

  it('rolls back when upstream failed with no signed credential (evidence=no)', async () => {
    h.callUpstream.mockRejectedValue(new UpstreamError('upstream_unreachable', 502, 'down', 'no'))
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    expect(h.rollback).toHaveBeenCalledOnce()
  })

  it('FAILS CLOSED (P0-B): a voucher-persist failure rolls back the charge', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'ok' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    atomic.state.failVoucherUpdate = true // atomic persist will throw
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    const json = (await res.json()) as any
    expect(json.error).toBe('settlement_persist_failed')
    expect(json.charged_usd).toBe('0.00')
    // Charge reversed.
    expect(h.rollback).toHaveBeenCalledOnce()
    expect(atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)).toBeUndefined()
  })

  it('rejects a call once the channel has been marked closed (settlement fence)', async () => {
    atomic.backing.set(`pg:channel:closed:${CHANNEL}`, { closedAt: 'now' })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe('channel_closed')
    expect(h.callUpstream).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalled()
  })
})
