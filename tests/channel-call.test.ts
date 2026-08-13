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
  const state = {
    failVoucherUpdate: false,
    failClosedUpdate: false,
    failVoucherGet: false,
    failFenceUpdate: false,
  }
  const store = {
    get: async (k: string) => {
      if (state.failVoucherGet && k.includes('voucher')) throw new Error('atomic get failed')
      return backing.has(k) ? backing.get(k) : null
    },
    update: async (k: string, cb: (cur: any) => any) => {
      if (state.failVoucherUpdate && k.includes('voucher')) throw new Error('atomic update failed')
      if (state.failClosedUpdate && k.includes('closed')) throw new Error('atomic closed update failed')
      if (state.failFenceUpdate && k.includes('fenced')) throw new Error('atomic fence update failed')
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
    acceptedAmount: '220000',
    signature: 'aa'.repeat(64),
    depositRaw: '100000000', // $10 — plenty unless a test lowers it
  } as {
    sufficient: boolean
    capturedAmount: string
    acceptedAmount: string
    signature: string
    depositRaw: string
  },
  acquire: vi.fn(async () => true),
  release: vi.fn(async () => {}),
  revalidate: vi.fn(async () => true),
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
  revalidateChannelDeliveryLock: h.revalidate,
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
      depositRaw: h.state.depositRaw,
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

let kv: { map: Map<string, string>; get: any; put: any }
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
  atomic.backing.clear()
  kv = makeKv()
  atomic.state.failVoucherUpdate = false
  atomic.state.failClosedUpdate = false
  atomic.state.failVoucherGet = false
  atomic.state.failFenceUpdate = false
  h.state.sufficient = true
  h.state.capturedAmount = ''
  h.state.acceptedAmount = '220000'
  h.state.signature = SIG_HEX
  h.state.depositRaw = '100000000'
  h.acquire.mockClear()
  h.release.mockClear()
  h.revalidate.mockReset()
  h.revalidate.mockResolvedValue(true)
  h.rollback.mockReset()
  h.rollback.mockResolvedValue(true)
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
    // R7-P0-1: the stored cumulative equals the signed voucher's BASE-UNIT
    // amount EXACTLY — no 10^7 drift from re-scaling an already-base-unit value.
    expect(stored.cumulativeRaw).toBe(h.state.acceptedAmount)
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
    expect(h.rollback).toHaveBeenCalledWith(expect.anything(), CHANNEL, '220000', '0', 'chal-1')
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

  it('P0-4: a null/garbage body AFTER payment still persists the voucher + releases lock + charges', async () => {
    h.callUpstream.mockResolvedValue({ value: null, paid: true, upstreamCostRaw: '500' })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    const json = (await res.json()) as any
    expect(json.error).toBe('upstream_empty')
    // Money moved → charge stands at the quote.
    expect(json.charged_usd).toBe('0.022')
    // Voucher persisted (collector can redeem) and lock released, despite the
    // unusable body — never thrown out of the paid section.
    expect(atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)?.signature).toBe(SIG_HEX)
    expect(h.release).toHaveBeenCalled()
    expect(h.rollback).not.toHaveBeenCalled()
  })

  it('P0-2: rollback-failure fences the channel and reports charged_usd 0 (no lie)', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'x' } }] },
      paid: false,
    })
    h.rollback.mockResolvedValue(false) // watermark rollback fails
    const res = await handleChannelChat(chatReq(), env())
    const json = (await res.json()) as any
    expect(json.error).toBe('upstream_unpaid')
    expect(json.charged_usd).toBe('0.00') // accurate: collector redeems nothing here
    // Fenced so a later call can't absorb the un-charged increment.
    expect(atomic.backing.get(`pg:channel:closed:${CHANNEL}`)).toBeTruthy()
    // No redeemable voucher was stored for this call.
    expect(atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)).toBeUndefined()
  })

  it('P0-3: releases the lock even when upstream throws a non-UpstreamError', async () => {
    h.callUpstream.mockRejectedValue(new Error('kaboom'))
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    expect((await res.json()).charged_usd).toBe('0.00')
    expect(h.release).toHaveBeenCalled() // finally always releases
  })

  it('rejects a call once the channel has been marked closed (settlement fence)', async () => {
    atomic.backing.set(`pg:channel:closed:${CHANNEL}`, { closedAt: 'now' })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe('channel_closed')
    expect(h.callUpstream).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalled()
  })

  it('P0-1: superseded token BEFORE payment aborts without paying (charged 0)', async () => {
    h.revalidate.mockResolvedValue(false) // taken over before we pay
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(409)
    const json = (await res.json()) as any
    expect(json.error).toBe('lock_superseded')
    expect(json.charged_usd).toBe('0.00')
    expect(h.callUpstream).not.toHaveBeenCalled() // never paid
    expect(atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)).toBeUndefined()
    expect(h.release).toHaveBeenCalled()
  })

  it('P0-1: superseded AFTER payment aborts persist, counts the recon abort (bounded router loss)', async () => {
    // Owns the lock at pay-time, superseded by the persist-time re-check.
    h.revalidate.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'hi' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(409)
    const json = (await res.json()) as any
    expect(json.error).toBe('lock_superseded_after_pay')
    expect(json.charged_usd).toBe('0.00')
    expect(h.callUpstream).toHaveBeenCalledOnce() // we DID pay
    // Did NOT persist a stale voucher; recon counter incremented so the loss is visible.
    expect(atomic.backing.get(`pg:channel:voucher:${CHANNEL}`)).toBeUndefined()
    expect(atomic.backing.get('pg:channel:recon:superseded-aborts').count).toBe(1)
    expect(h.release).toHaveBeenCalled()
  })

  it('P0-2/P0-6: when the atomic closed-marker fails, the durable atomic fence still blocks', async () => {
    // Unpaid + rollback fails → must fence. The fast closed-marker write fails,
    // so only the durable fence (separate atomic key) lands.
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'x' } }] },
      paid: false,
    })
    h.rollback.mockResolvedValue(false)
    atomic.state.failClosedUpdate = true
    const first = await handleChannelChat(chatReq(), env())
    expect((await first.json()).error).toBe('upstream_unpaid')
    // The durable atomic fence landed even though the closed-marker write threw.
    expect(atomic.backing.get(`pg:channel:fenced:${CHANNEL}`)).toBeTruthy()

    // A subsequent call is rejected by the dispatch gate regardless of lock state.
    atomic.state.failClosedUpdate = false
    h.callUpstream.mockClear()
    const second = await handleChannelChat(chatReq(), env())
    expect(second.status).toBe(410)
    expect((await second.json()).error).toBe('channel_closed')
    expect(h.callUpstream).not.toHaveBeenCalled()
  })

  it('R6-P0-1: definite post-pay persist-fail FENCES even when rollback succeeds (capacity not reusable)', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'ok' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    atomic.state.failVoucherUpdate = true // persist throws; backing empty → 'not'
    h.rollback.mockResolvedValue(true) // rollback SUCCEEDS (frees capacity)
    const first = await handleChannelChat(chatReq(), env())
    expect(first.status).toBe(502)
    const j = (await first.json()) as any
    expect(j.error).toBe('settlement_persist_failed')
    expect(j.charged_usd).toBe('0.00')
    // Even though rollback freed the capacity, the channel is FENCED so it can't
    // be re-spent — this is what keeps the router loss bounded by the deposit.
    expect(atomic.backing.get(`pg:channel:fenced:${CHANNEL}`)).toBeTruthy()
    expect(atomic.backing.get('pg:channel:recon:superseded-aborts').count).toBe(1)

    // The next call is rejected — freed capacity is NOT reusable.
    atomic.state.failVoucherUpdate = false
    h.callUpstream.mockClear()
    const second = await handleChannelChat(chatReq(), env())
    expect(second.status).toBe(410)
    expect(h.callUpstream).not.toHaveBeenCalled()
  })

  it('R6-P0-2: an UNKNOWN persist (readback also fails) fences + reports $0, never charged', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'ok' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    atomic.state.failVoucherUpdate = true // persist throws
    atomic.state.failVoucherGet = true // readback ALSO fails → 'unknown'
    const res = await handleChannelChat(chatReq(), env())
    // Unknown is NOT reported as committed — $0, fenced, absorbed.
    expect(res.status).toBe(502)
    expect((await res.json()).charged_usd).toBe('0.00')
    expect(atomic.backing.get(`pg:channel:fenced:${CHANNEL}`)).toBeTruthy()
    expect(atomic.backing.get('pg:channel:recon:superseded-aborts').count).toBe(1)
  })

  it('R7-P0-2: fence is written BEFORE capacity is freed (rollback sees the fence already set)', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'ok' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    atomic.state.failVoucherUpdate = true // persist throws; backing empty → 'not'
    let fenceSetWhenRolledBack = false
    h.rollback.mockImplementation(async () => {
      fenceSetWhenRolledBack = atomic.backing.has(`pg:channel:fenced:${CHANNEL}`)
      return true
    })
    await handleChannelChat(chatReq(), env())
    // The durable fence was set before the rollback that frees capacity ran.
    expect(fenceSetWhenRolledBack).toBe(true)
    expect(atomic.backing.get(`pg:channel:fenced:${CHANNEL}`)).toBeTruthy()
  })

  it('R7-P0-2: if the fence write FAILS, rollback is NOT attempted (capacity stays consumed)', async () => {
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'ok' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    atomic.state.failVoucherUpdate = true // persist throws; backing empty → 'not'
    atomic.state.failFenceUpdate = true // the fence write also fails
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(502)
    expect((await res.json()).charged_usd).toBe('0.00')
    // Fence could not be confirmed → do NOT roll back → no window of reusable,
    // unfenced capacity. The advance stays consumed.
    expect(h.rollback).not.toHaveBeenCalled()
    expect(atomic.backing.get(`pg:channel:fenced:${CHANNEL}`)).toBeUndefined()
  })

  it('P0-5: an ambiguous persist error whose readback shows the voucher IS stored charges the quote', async () => {
    // A voucher covering this call's cumulative is already stored (the write may
    // have landed before the error). The persist "throws" but readback confirms
    // coverage → treat as committed, charge the quote, never report $0.
    atomic.backing.set(`pg:channel:voucher:${CHANNEL}`, {
      cumulativeRaw: '220000',
      amountDecimal: '0.0220000',
      signature: SIG_HEX,
      lastSettledRaw: '0',
      updatedAt: 'now',
    })
    atomic.state.failVoucherUpdate = true // the write path throws (ambiguous)
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'hi' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(200)
    expect((await res.json()).charged_usd).toBe('0.022') // redeemable → charged, not $0
    expect(h.rollback).not.toHaveBeenCalled()
  })

  it('P0-1: rejects a call whose new cumulative would exceed the channel deposit', async () => {
    h.state.depositRaw = '100000' // $0.01 deposit; quote is $0.022 → over
    const res = await handleChannelChat(chatReq(), env())
    expect(res.status).toBe(402)
    const json = (await res.json()) as any
    expect(json.error).toBe('insufficient_channel_balance')
    expect(json.remaining_usd).toBe('0.01')
    expect(h.callUpstream).not.toHaveBeenCalled() // never paid
  })

  it('P0-1: the deposit caps total spend — a second call past the deposit is rejected', async () => {
    // Deposit funds exactly one $0.022 call ($0.03). First call succeeds.
    h.state.depositRaw = '300000'
    h.callUpstream.mockResolvedValue({
      value: { choices: [{ message: { content: 'ok' } }] },
      paid: true,
      upstreamCostRaw: '500',
    })
    const first = await handleChannelChat(chatReq(), env())
    expect(first.status).toBe(200)
    // Reflect the first call's advance in the cumulative watermark the gate reads.
    atomic.backing.set(`stellar:channel:cumulative:${CHANNEL}`, { amount: '220000' })
    // Second call: 220000 + 220000 > 300000 → rejected, cap holds.
    h.callUpstream.mockClear()
    const second = await handleChannelChat(chatReq(), env())
    expect(second.status).toBe(402)
    expect((await second.json()).error).toBe('insufficient_channel_balance')
    expect(h.callUpstream).not.toHaveBeenCalled()
  })
})
