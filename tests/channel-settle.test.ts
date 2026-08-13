/**
 * Option A online settlement — voucher store + collector-signed close.
 *
 * The router must COLLECT what users spend to the collector before they can
 * unilaterally refund. These tests cover the latest-voucher store and the
 * settlement decision/close, with the on-chain seam mocked (no live RPC, no
 * real signer). The collector key is only ever passed as the close envelope
 * signer.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  getLatestVoucher,
  putLatestVoucher,
  markVoucherSettled,
} from '../src/playground/channel-voucher-store'
import {
  decodeVoucherSignature,
  settleOneChannel,
  settlePlaygroundChannels,
  type SettleDeps,
} from '../src/playground/channel-settle'

const CHANNEL = 'C' + 'A'.repeat(55)
const SIGNER_SECRET = 'SXXX-collector-secret-not-a-real-key'
const SIG_HEX = 'ab'.repeat(64) // 128 hex chars

function makeKv() {
  const m = new Map<string, string>()
  return {
    map: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v)
    },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
}

function env(kv: ReturnType<typeof makeKv>, overrides: Record<string, unknown> = {}) {
  return {
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_RPC_URL: 'https://soroban-rpc.example',
    MPP_STORE: kv,
    PLAYGROUND_CHANNEL_ENABLED: 'true',
    PLAYGROUND_CHANNEL_SIGNER_SECRET: SIGNER_SECRET,
    ...overrides,
  } as any
}

describe('decodeVoucherSignature', () => {
  it('decodes 128-char hex to 64 bytes', () => {
    expect(decodeVoucherSignature(SIG_HEX).length).toBe(64)
  })
  it('decodes base64 to 64 bytes', () => {
    const b64 = Buffer.alloc(64, 7).toString('base64')
    expect(decodeVoucherSignature(b64).length).toBe(64)
  })
  it('rejects a wrong-length signature', () => {
    expect(() => decodeVoucherSignature('deadbeef')).toThrow()
  })
})

describe('latest-voucher store', () => {
  it('round-trips and only advances monotonically', async () => {
    const kv = makeKv()
    const e = env(kv)
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.0220000',
      cumulativeRaw: '220000',
      signature: SIG_HEX,
    })
    let v = await getLatestVoucher(e, CHANNEL)
    expect(v?.signature).toBe(SIG_HEX)
    expect(v?.lastSettledRaw).toBe('0')

    // A lower cumulative must NOT overwrite (stale concurrent write).
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.0100000',
      cumulativeRaw: '100000',
      signature: 'cc'.repeat(64),
    })
    v = await getLatestVoucher(e, CHANNEL)
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
    v = await getLatestVoucher(e, CHANNEL)
    expect(v?.lastSettledRaw).toBe('500000')
  })
})

describe('settleOneChannel', () => {
  let kv: ReturnType<typeof makeKv>
  let closeMock: ReturnType<typeof vi.fn>
  let deps: SettleDeps

  beforeEach(async () => {
    kv = makeKv()
    closeMock = vi.fn(async () => 'tx-hash-abc')
    deps = {
      getChannelState: vi.fn(async () => ({ closeEffectiveAtLedger: null, currentLedger: 100 })),
      close: closeMock,
    }
    await putLatestVoucher(env(kv), CHANNEL, {
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
    const e = env(kv)
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    const tx = await settleOneChannel(e, CHANNEL, voucher, deps)
    expect(tx).toBe('tx-hash-abc')
    expect(closeMock).toHaveBeenCalledOnce()
    const arg = closeMock.mock.calls[0][0]
    expect(arg.channel).toBe(CHANNEL)
    expect(arg.amount).toBe(5_000_000n) // cumulative in i128 base units
    expect(arg.signature).toBeInstanceOf(Uint8Array)
    // The collector key is used ONLY as the close envelope signer.
    expect(arg.feePayer.envelopeSigner).toBe(SIGNER_SECRET)
    // Cumulative recorded as settled so the cron does not re-settle it.
    expect((await getLatestVoucher(e, CHANNEL))!.lastSettledRaw).toBe('5000000')
  })

  it('settles when unsettled amount crosses the threshold even without close_start', async () => {
    const e = env(kv)
    const voucher = (await getLatestVoucher(e, CHANNEL))! // $0.50 > $0.20 threshold
    const tx = await settleOneChannel(e, CHANNEL, voucher, deps)
    expect(tx).toBe('tx-hash-abc')
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('does NOT settle a small unsettled amount with no close_start', async () => {
    const kv2 = makeKv()
    const e = env(kv2)
    await putLatestVoucher(e, CHANNEL, {
      amountDecimal: '0.0100000',
      cumulativeRaw: '100000', // $0.01 < $0.20 threshold
      signature: SIG_HEX,
    })
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    const tx = await settleOneChannel(e, CHANNEL, voucher, deps)
    expect(tx).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('does NOT re-settle an already fully-settled cumulative', async () => {
    const e = env(kv)
    await markVoucherSettled(e, CHANNEL, '5000000')
    const voucher = (await getLatestVoucher(e, CHANNEL))!
    ;(deps.getChannelState as any).mockResolvedValue({
      closeEffectiveAtLedger: 12345,
      currentLedger: 12000,
    })
    const tx = await settleOneChannel(e, CHANNEL, voucher, deps)
    expect(tx).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()
  })
})

describe('settlePlaygroundChannels — fail-safe', () => {
  it('skips settlement entirely when the collector signer secret is unset', async () => {
    const kv = makeKv()
    const closeMock = vi.fn(async () => 'tx')
    const deps: SettleDeps = {
      getChannelState: vi.fn(async () => ({ closeEffectiveAtLedger: 1, currentLedger: 2 })),
      close: closeMock,
    }
    await settlePlaygroundChannels(env(kv, { PLAYGROUND_CHANNEL_SIGNER_SECRET: undefined }), deps)
    expect(closeMock).not.toHaveBeenCalled()
    expect(deps.getChannelState).not.toHaveBeenCalled()
  })
})
