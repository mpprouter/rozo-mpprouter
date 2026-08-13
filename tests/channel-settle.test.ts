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
} from '../src/playground/channel-voucher-store'
import { putPgChannel, PG_PROVENANCE_VERSION } from '../src/playground/channel-pg-store'
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
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    const tx = await settleOneChannel(e, CHANNEL, voucher, deps)
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

  it('settles when unsettled crosses the threshold even without close_start', async () => {
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    expect(await settleOneChannel(e, CHANNEL, voucher, deps)).toBe('tx-hash-abc')
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
    const voucher = (await getLatestVoucher(e2, CHANNEL2))!
    expect(await settleOneChannel(e2, CHANNEL2, voucher, deps)).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('does NOT re-settle an already fully-settled cumulative', async () => {
    await markVoucherSettled(e, CHANNEL, '5000000')
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    expect(await settleOneChannel(e, CHANNEL, voucher, deps)).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('yields to an in-flight call: skips when the delivery lock is held', async () => {
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    // A call holds the same per-channel delivery lock.
    atomic.backing.set(`refund:channel-lock:${CHANNEL}`, { id: 'call-in-flight' })
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    expect(await settleOneChannel(e, CHANNEL, voucher, deps)).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
    // Did not fence the channel — the call proceeds normally.
    expect(atomic.backing.get(`pg:channel:closed:${CHANNEL}`)).toBeUndefined()
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
