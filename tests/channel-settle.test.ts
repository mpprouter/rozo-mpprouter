/**
 * Option A online settlement — atomic voucher store, fencing, and the
 * collector-key binding (P0-C / P0-D).
 *
 * The atomic store is faked in-memory (same shape as the DO-backed
 * Store.cloudflare). The on-chain seam (getChannelState/close) is injected.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'

const atomic = vi.hoisted(() => {
  const backing = new Map<string, any>()
  const store = {
    get: async (k: string) => (backing.has(k) ? backing.get(k) : null),
    update: async (k: string, cb: (cur: any) => any) => {
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
  return { backing, store }
})

vi.mock('mppx/server', () => ({
  Store: { cloudflare: () => atomic.store },
  Mppx: { create: () => ({}) },
}))
vi.mock('../src/mpp/kv-atomic-store', () => ({ doAtomicParams: () => ({}) }))

import {
  getLatestVoucher,
  putLatestVoucher,
  markVoucherSettled,
  getSupersededAbortCount,
  incrSupersededAbort,
} from '../src/playground/channel-voucher-store'
import { putPgChannel, PG_PROVENANCE_VERSION } from '../src/playground/channel-pg-store'
import {
  acquireChannelDeliveryLock,
  releaseChannelDeliveryLock,
} from '../src/mpp/stellar-channel-dispatch'
import {
  collectorKeyMatches,
  decodeVoucherSignature,
  settleOneChannel,
  settlePlaygroundChannels,
  type SettleDeps,
} from '../src/playground/channel-settle'

const CHANNEL = 'C' + 'A'.repeat(55)
const FUNDER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const WASM_HASH = 'ab'.repeat(32)
const SIG_HEX = 'ab'.repeat(64)

// A real collector keypair so the pubkey-binding check has something to derive.
const collectorKp = Keypair.random()
const COLLECTOR = collectorKp.publicKey()
const COLLECTOR_SECRET = collectorKp.secret()

function makeKv() {
  const m = new Map<string, string>()
  return {
    map: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v)
    },
    list: async ({ prefix = '' }: { prefix?: string; cursor?: string } = {}) => ({
      keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
      cursor: '',
    }),
  }
}

function env(kv: ReturnType<typeof makeKv>, overrides: Record<string, unknown> = {}) {
  return {
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_RPC_URL: 'https://soroban-rpc.example',
    MPP_STORE: kv,
    ATOMIC_STORE: {},
    PLAYGROUND_CHANNEL_ENABLED: 'true',
    PLAYGROUND_CHANNEL_TO: COLLECTOR,
    PLAYGROUND_CHANNEL_WASM_HASH: WASM_HASH,
    PLAYGROUND_CHANNEL_SIGNER_SECRET: COLLECTOR_SECRET,
    ...overrides,
  } as any
}

beforeEach(() => atomic.backing.clear())

describe('decodeVoucherSignature', () => {
  it('decodes 128-char hex to 64 bytes', () => {
    expect(decodeVoucherSignature(SIG_HEX).length).toBe(64)
  })
  it('decodes base64 to 64 bytes', () => {
    expect(decodeVoucherSignature(Buffer.alloc(64, 7).toString('base64')).length).toBe(64)
  })
  it('rejects a wrong-length signature', () => {
    expect(() => decodeVoucherSignature('deadbeef')).toThrow()
  })
})

describe('collectorKeyMatches (P0-D)', () => {
  it('true when the signer secret derives the configured collector', () => {
    expect(collectorKeyMatches(env(makeKv()))).toBe(true)
  })
  it('false when the signer public key != PLAYGROUND_CHANNEL_TO', () => {
    const other = Keypair.random().publicKey()
    expect(collectorKeyMatches(env(makeKv(), { PLAYGROUND_CHANNEL_TO: other }))).toBe(false)
  })
  it('false when the signer secret is unset', () => {
    expect(collectorKeyMatches(env(makeKv(), { PLAYGROUND_CHANNEL_SIGNER_SECRET: undefined }))).toBe(
      false,
    )
  })
})

describe('atomic voucher store', () => {
  it('round-trips and only advances monotonically (atomic CAS)', async () => {
    const e = env(makeKv())
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.0220000',
      cumulativeRaw: '220000',
      signature: SIG_HEX,
    })
    // A lower cumulative must NOT overwrite (stale concurrent write).
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.0100000',
      cumulativeRaw: '100000',
      signature: 'cc'.repeat(64),
    })
    let v = await getLatestVoucher(e, CHANNEL)
    expect(v?.cumulativeRaw).toBe('220000')
    expect(v?.signature).toBe(SIG_HEX)
    // A higher cumulative advances.
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.0500000',
      cumulativeRaw: '500000',
      signature: 'dd'.repeat(64),
    })
    v = await getLatestVoucher(e, CHANNEL)
    expect(v?.cumulativeRaw).toBe('500000')
    await markVoucherSettled(e, CHANNEL, '500000')
    expect((await getLatestVoucher(e, CHANNEL))?.lastSettledRaw).toBe('500000')
  })
})

describe('recon superseded-abort counter (P0-1 residual visibility)', () => {
  it('starts at 0 and increments monotonically', async () => {
    const e = env(makeKv())
    expect(await getSupersededAbortCount(e)).toBe(0)
    await incrSupersededAbort(e)
    await incrSupersededAbort(e)
    expect(await getSupersededAbortCount(e)).toBe(2)
  })
})

describe('settleOneChannel', () => {
  let closeMock: ReturnType<typeof vi.fn>
  let deps: SettleDeps
  let e: ReturnType<typeof env>

  beforeEach(async () => {
    closeMock = vi.fn(async () => 'tx-hash-abc')
    deps = {
      getChannelState: vi.fn(async () => ({ closeEffectiveAtLedger: null, currentLedger: 100 })),
      close: closeMock,
    }
    e = env(makeKv())
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.5000000',
      cumulativeRaw: '5000000',
      signature: SIG_HEX,
    })
  })

  it('settles with the collector key when the channel has entered close_start', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    const tx = await settleOneChannel(e, CHANNEL, deps)
    expect(tx).toBe('tx-hash-abc')
    expect(closeMock).toHaveBeenCalledOnce()
    const arg = closeMock.mock.calls[0][0]
    expect(arg.channel).toBe(CHANNEL)
    expect(arg.amount).toBe(5_000_000n)
    expect(arg.signature).toBeInstanceOf(Uint8Array)
    expect(arg.feePayer.envelopeSigner).toBe(COLLECTOR_SECRET)
    // Settled watermark recorded; channel fenced (closed marker set).
    expect((await getLatestVoucher(e, CHANNEL))!.lastSettledRaw).toBe('5000000')
    expect(atomic.backing.get(`pg:channel:closed:${CHANNEL}`)).toBeTruthy()
  })

  it('closes with a fee-bump signer so the tx is never stuck at the 100-stroop default fee', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    await settleOneChannel(e, CHANNEL, deps)
    const arg = closeMock.mock.calls[0][0]
    expect(arg.feePayer.feeBumpSigner).toBe(COLLECTOR_SECRET)
    expect(arg.maxFeeBumpStroops).toBe(10_000_000)
  })

  it('writes off (marks settled) when the funder already refunded the channel', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    closeMock.mockRejectedValue(new Error('HostError: "balance is not sufficient to spend"'))
    expect(await settleOneChannel(e, CHANNEL, deps)).toBeNull()
    // Marked settled so the cron stops retrying a dead channel forever.
    expect((await getLatestVoucher(e, CHANNEL))!.lastSettledRaw).toBe('5000000')
    // And a terminal write-off record distinguishes forgiven debt from
    // collected funds for reconciliation.
    const wo = await getVoucherWriteoff(e, CHANNEL)
    expect(wo!.cumulativeRaw).toBe('5000000')
    expect(wo!.reason).toContain('refunded')
  })

  it('does NOT write off on other close failures — retries next tick', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    closeMock.mockRejectedValue(new Error('rpc timeout'))
    await expect(settleOneChannel(e, CHANNEL, deps)).rejects.toThrow('rpc timeout')
    expect((await getLatestVoucher(e, CHANNEL))!.lastSettledRaw ?? '0').toBe('0')
  })

  it('P0-1: closes with the LATEST voucher read under the lock, not a stale one', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    // A concurrent call committed a HIGHER cumulative (V2) after V1 was stored.
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.7000000',
      cumulativeRaw: '7000000',
      signature: 'ee'.repeat(64),
    })
    await settleOneChannel(e, CHANNEL, deps)
    // Closes with V2 (7,000,000), never the stale V1.
    expect(closeMock.mock.calls[0][0].amount).toBe(7_000_000n)
  })

  it('settles when unsettled crosses the threshold even without close_start', async () => {
    expect(await settleOneChannel(e, CHANNEL, deps)).toBe('tx-hash-abc')
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('does NOT settle a small unsettled amount with no close_start', async () => {
    const CHANNEL2 = 'C' + 'B'.repeat(55) // distinct key in the shared atomic store
    const e2 = env(makeKv())
    await putLatestVoucher(e2, CHANNEL2, {
      amountDecimal: '0.0100000',
      cumulativeRaw: '100000',
      signature: SIG_HEX,
    })
    expect(await settleOneChannel(e2, CHANNEL2, deps)).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('does NOT re-settle an already fully-settled cumulative', async () => {
    await markVoucherSettled(e, CHANNEL, '5000000')
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    expect(await settleOneChannel(e, CHANNEL, deps)).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('yields to an in-flight call: skips when a LIVE delivery lock is held', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    // A call holds a live (unexpired) lock.
    atomic.backing.set(`refund:channel-lock:${CHANNEL}`, {
      id: 'call-in-flight',
      expiresAt: Date.now() + 60_000,
    })
    expect(await settleOneChannel(e, CHANNEL, deps)).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
    expect(atomic.backing.get(`pg:channel:closed:${CHANNEL}`)).toBeUndefined()
  })

  it('R8: fences the channel the moment close_start is detected (even when fully settled)', async () => {
    // Channel is closing but already fully settled → nothing to collect...
    await markVoucherSettled(e, CHANNEL, '5000000')
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    const tx = await settleOneChannel(e, CHANNEL, deps)
    expect(tx).toBeNull() // nothing to settle
    expect(closeMock).not.toHaveBeenCalled()
    // ...but the cron still durably fenced it so later calls reject without RPC.
    expect(atomic.backing.get(`pg:channel:fenced:${CHANNEL}`)).toBeTruthy()
  })

  it('P0-3: takes over an EXPIRED (leaked) lock and settles', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    // A prior call leaked the lock; its TTL has elapsed.
    atomic.backing.set(`refund:channel-lock:${CHANNEL}`, {
      id: 'leaked',
      expiresAt: Date.now() - 1_000,
    })
    expect(await settleOneChannel(e, CHANNEL, deps)).toBe('tx-hash-abc')
    expect(closeMock).toHaveBeenCalledOnce()
  })
})

describe('delivery lock — TTL + safe takeover (P0-3)', () => {
  it('acquires when free; blocks a live lock; takes over an expired one', async () => {
    atomic.backing.clear()
    const e = env(makeKv())
    expect(await acquireChannelDeliveryLock(e, CHANNEL, 'a')).toBe(true)
    // A live lock blocks a different holder.
    expect(await acquireChannelDeliveryLock(e, CHANNEL, 'b')).toBe(false)
    // Force the stored lock to expire, then a takeover succeeds.
    const cur = atomic.backing.get(`refund:channel-lock:${CHANNEL}`)
    atomic.backing.set(`refund:channel-lock:${CHANNEL}`, { ...cur, expiresAt: Date.now() - 1 })
    expect(await acquireChannelDeliveryLock(e, CHANNEL, 'c')).toBe(true)
    expect(atomic.backing.get(`refund:channel-lock:${CHANNEL}`).id).toBe('c')
  })

  it('release only deletes the lock when the fencing id matches', async () => {
    atomic.backing.clear()
    const e = env(makeKv())
    await acquireChannelDeliveryLock(e, CHANNEL, 'owner')
    await releaseChannelDeliveryLock(e, CHANNEL, 'not-owner')
    expect(atomic.backing.get(`refund:channel-lock:${CHANNEL}`)).toBeTruthy() // still held
    await releaseChannelDeliveryLock(e, CHANNEL, 'owner')
    expect(atomic.backing.get(`refund:channel-lock:${CHANNEL}`)).toBeUndefined()
  })
})

describe('settlePlaygroundChannels — fail-closed collector binding (P0-D)', () => {
  const closeMock = vi.fn(async () => 'tx')
  const deps: SettleDeps = {
    getChannelState: vi.fn(async () => ({ closeEffectiveAtLedger: 1, currentLedger: 2 })),
    close: closeMock,
  }
  beforeEach(() => {
    closeMock.mockClear()
    ;(deps.getChannelState as any).mockClear()
  })

  it('skips entirely when the collector signer secret is unset', async () => {
    await settlePlaygroundChannels(
      env(makeKv(), { PLAYGROUND_CHANNEL_SIGNER_SECRET: undefined }),
      deps,
    )
    expect(closeMock).not.toHaveBeenCalled()
    expect(deps.getChannelState).not.toHaveBeenCalled()
  })

  it('skips (never signs) when the signer pubkey != PLAYGROUND_CHANNEL_TO', async () => {
    const kv = makeKv()
    const e = env(kv, { PLAYGROUND_CHANNEL_TO: Keypair.random().publicKey() })
    // Even with a due channel present, a mismatched collector key must not sign.
    await putPgChannel(e, {
      channelContract: CHANNEL,
      commitmentKey: FUNDER,
      agentAccount: FUNDER,
      currency: USDC_SAC,
      network: 'stellar:pubnet',
      depositRaw: '5000000',
      to: COLLECTOR,
      wasmHash: WASM_HASH,
      provenanceVersion: PG_PROVENANCE_VERSION,
      openedAt: 'now',
    })
    await settlePlaygroundChannels(e, deps)
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('settles a due, provenanced channel end-to-end when the collector key matches', async () => {
    const kv = makeKv()
    const e = env(kv)
    await putPgChannel(e, {
      channelContract: CHANNEL,
      commitmentKey: FUNDER,
      agentAccount: FUNDER,
      currency: USDC_SAC,
      network: 'stellar:pubnet',
      depositRaw: '5000000',
      to: COLLECTOR,
      wasmHash: WASM_HASH,
      provenanceVersion: PG_PROVENANCE_VERSION,
      openedAt: 'now',
    })
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.5000000',
      cumulativeRaw: '5000000',
      signature: SIG_HEX,
    })
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 999,
      currentLedger: 900,
    })
    await settlePlaygroundChannels(e, deps)
    expect(closeMock).toHaveBeenCalledOnce()
    expect(closeMock.mock.calls[0][0].feePayer.envelopeSigner).toBe(COLLECTOR_SECRET)
  })
})
