import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeInclusionBid,
  currentInclusionBid,
  INCLUSION_BID_CAP_STROOPS,
  INCLUSION_BID_DEFAULT_STROOPS,
  INCLUSION_BID_FLOOR_STROOPS,
  INCLUSION_BID_TTL_MS,
  refreshInclusionBid,
  resetInclusionBidForTest,
} from '../src/mpp/stellar-inclusion-bid'

const URL = 'https://rpc.invalid'

describe('computeInclusionBid', () => {
  it('bids twice the network p90', () => {
    expect(computeInclusionBid('200')).toBe(400)
    expect(computeInclusionBid('1500')).toBe(3000)
  })

  it('holds the floor when the network is quiet', () => {
    expect(computeInclusionBid('100')).toBe(INCLUSION_BID_FLOOR_STROOPS)
    expect(computeInclusionBid('0')).toBe(INCLUSION_BID_FLOOR_STROOPS)
  })

  it('never exceeds the cap however congested the reading', () => {
    expect(computeInclusionBid('5001')).toBe(INCLUSION_BID_CAP_STROOPS)
    expect(computeInclusionBid('99999999999')).toBe(INCLUSION_BID_CAP_STROOPS)
  })

  it.each([undefined, null, '', 'abc', '-5', '1.5', 200, '999999999999999999999999'])(
    'falls back on an unusable reading %s',
    (value) => expect(computeInclusionBid(value)).toBe(INCLUSION_BID_DEFAULT_STROOPS),
  )
})

describe('refreshInclusionBid', () => {
  beforeEach(() => {
    resetInclusionBidForTest()
  })

  it('reads once per TTL', async () => {
    const read = vi.fn().mockResolvedValue('200')
    expect(await refreshInclusionBid(URL, 1_000, read)).toBe(400)
    expect(await refreshInclusionBid(URL, 1_000 + INCLUSION_BID_TTL_MS - 1, read)).toBe(400)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockResolvedValue('600')
    expect(await refreshInclusionBid(URL, 1_000 + INCLUSION_BID_TTL_MS, read)).toBe(1200)
    expect(currentInclusionBid()).toBe(1200)
  })

  it('uses the default when the first read fails, and does not retry inside the TTL', async () => {
    const read = vi.fn().mockRejectedValue(new Error('429 https://x/v2/secret'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await refreshInclusionBid(URL, 1_000, read)).toBe(INCLUSION_BID_DEFAULT_STROOPS)
    await refreshInclusionBid(URL, 2_000, read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret')
    warn.mockRestore()
  })

  it('keeps the last good bid when a later read fails or is unusable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await refreshInclusionBid(URL, 1_000, async () => '600')
    expect(await refreshInclusionBid(URL, 1_000 + INCLUSION_BID_TTL_MS, async () => { throw new Error('x') })).toBe(1200)
    expect(await refreshInclusionBid(URL, 1_000 + 2 * INCLUSION_BID_TTL_MS, async () => 'junk')).toBe(1200)
    warn.mockRestore()
  })

  it('ignores an older read that returns after a newer one started', async () => {
    let finishOld: (v: string) => void = () => undefined
    const old = refreshInclusionBid(URL, 1_000, () => new Promise((r) => { finishOld = r }))
    await refreshInclusionBid(URL, 1_000 + INCLUSION_BID_TTL_MS, async () => '2000')
    finishOld('100')
    await old
    expect(currentInclusionBid()).toBe(4000)
  })

  it('does not wait past the timeout on a hung RPC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = Date.now()
    const bid = await refreshInclusionBid(URL, 1_000, () => new Promise(() => undefined), 20)
    expect(bid).toBe(INCLUSION_BID_DEFAULT_STROOPS)
    expect(Date.now() - started).toBeLessThan(1_000)
    warn.mockRestore()
  })
})
