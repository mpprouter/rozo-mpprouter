/**
 * Non-custodial channel playground — voucher-authenticated metered call.
 *
 * The verify engine (resolveStellarChannelMppx + the atomic store) and the
 * upstream charge seam are mocked so these tests isolate the metered-call
 * contract of src/routes/playground-channel.ts:
 *
 *   - a valid voucher is verified for EXACTLY the real-cost price (cost +
 *     markup) and, on a paid success, the voucher is NOT rolled back (the
 *     cumulative stays advanced) and the response reports the real cost;
 *   - an insufficient voucher delta yields the mppx 402 challenge, unbilled;
 *   - the `paid === true` single source of truth is preserved: a 2xx with no
 *     signed credential rolls the voucher back; an upstream failure whose
 *     paymentEvidence is 'yes' keeps the charge, 'no' rolls it back.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const CHANNEL = 'C' + 'A'.repeat(55)
const FUNDER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

const SIG_HEX = 'aa'.repeat(64) // 128 hex chars = 64-byte ed25519 sig

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
  Store: { cloudflare: () => ({ get: async () => ({ amount: '0' }) }) },
  Mppx: { create: () => ({}) },
}))

vi.mock('../src/mpp/kv-atomic-store', () => ({ doAtomicParams: () => ({}) }))

vi.mock('../src/mpp/stellar-channel-dispatch', () => {
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
    resolveStellarChannelMppx: async () => ({
      mppx: makeMppx(),
      channelContract: CHANNEL,
      agentAccount: FUNDER,
      channelCurrency: USDC_SAC,
    }),
    acquireChannelDeliveryLock: h.acquire,
    releaseChannelDeliveryLock: h.release,
    rollbackFailedChannelVoucher: h.rollback,
    StellarChannelNotRegisteredError: class StellarChannelNotRegisteredError extends Error {},
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

function makeKv() {
  const m = new Map<string, string>()
  return {
    map: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v)
    },
  }
}

let kv: ReturnType<typeof makeKv>

function env() {
  return {
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: FUNDER,
    ATOMIC_STORE: {},
    MPP_STORE: kv,
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
  kv = makeKv()
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

  it('quotes the MAX upstream cost (budget ceiling) + markup and persists the voucher', async () => {
    // llama-3.1-8b-instant: cheap-tier budget ceiling $0.02 + markup
    // max(10%,$0.001)=$0.002 → quote $0.022. Never under-quoted.
    const e = env()
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'hi there' } }] },
      paid: true,
      upstreamCostRaw: '500', // USDC-6 → $0.0005 real
    })
    const res = await handleChannelChat(chatReq(), e)
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.message).toBe('hi there')
    // The voucher delta the router demanded == the quote (max upstream + markup).
    expect(h.state.capturedAmount).toBe('0.0220000')
    expect(json.charged_usd).toBe('0.022')
    expect(json.upstream_cost_usd).toBe('0.0005') // live captured cost, display only
    expect(h.rollback).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalled()
    // Latest voucher signature persisted for the settlement cron.
    const stored = JSON.parse(kv.map.get(`playgroundVoucher:${CHANNEL}`)!)
    expect(stored.signature).toBe(SIG_HEX)
    expect(stored.amountDecimal).toBe('0.0220000')
  })

  it('rejects an insufficient voucher delta with the mppx 402 (unbilled)', async () => {
    h.state.sufficient = false
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(402)
    expect(h.callUpstream).not.toHaveBeenCalled()
    expect(h.rollback).not.toHaveBeenCalled()
    // Lock acquired then released on the 402 path.
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
    expect(json.charged_usd).toBe('0.00')
    expect(h.rollback).toHaveBeenCalledWith(expect.anything(), CHANNEL, '0.0220000', '0', 'chal-1')
  })

  it('keeps the charge when a paid credential was signed but upstream then failed (evidence=yes)', async () => {
    h.callUpstream.mockRejectedValue(
      new UpstreamError('upstream_over_budget', 502, 'boom', 'yes'),
    )
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    const json = (await res.json()) as any
    expect(json.support_note).toBeTruthy()
    // Money moved → cumulative stays advanced.
    expect(h.rollback).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalled()
  })

  it('rolls back when upstream failed with no signed credential (evidence=no)', async () => {
    h.callUpstream.mockRejectedValue(
      new UpstreamError('upstream_unreachable', 502, 'down', 'no'),
    )
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    expect(h.rollback).toHaveBeenCalledOnce()
  })
})
