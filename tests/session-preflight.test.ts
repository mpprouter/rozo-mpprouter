import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/mpp/channel-store', () => ({ getTempoChannel: vi.fn() }))
vi.mock('../src/mpp/tempo-rpc', () => ({ getTempoClient: vi.fn() }))

const { getTempoChannel } = await import('../src/mpp/channel-store')
const { checkSessionPreflight, evaluateSessionPreflight } = await import('../src/mpp/session-preflight')

const OUSD = '0x20c0000000000000000000006a37DA5C996874BE'
const USDC = '0x20c000000000000000000000b9537d11c60e8b50'
const CHANNEL = { channelId: '0xabc', currency: OUSD, cumulativeRaw: '1000' }
const STATE = { deposit: 1_000_000n, settled: 0n, closeRequestedAt: 0n }
const env = {} as never

describe('evaluateSessionPreflight', () => {
  it('passes with room for two calls', () => {
    expect(evaluateSessionPreflight(CHANNEL, OUSD.toLowerCase(), 1000n, STATE)).toEqual({ ok: true })
  })
  it('refuses a channel in another token', () => {
    expect(evaluateSessionPreflight({ ...CHANNEL, currency: USDC }, OUSD, 1000n, STATE))
      .toEqual({ ok: false, reason: 'currency_mismatch' })
  })
  it('refuses a closing channel', () => {
    expect(evaluateSessionPreflight(CHANNEL, OUSD, 1000n, { ...STATE, closeRequestedAt: 9n }))
      .toEqual({ ok: false, reason: 'channel_closing' })
  })
  it('refuses headroom for one call but not two', () => {
    expect(evaluateSessionPreflight(CHANNEL, OUSD, 600_000n, STATE))
      .toEqual({ ok: false, reason: 'insufficient_headroom' })
  })
  it('uses settled when it runs ahead of the KV watermark', () => {
    expect(evaluateSessionPreflight(CHANNEL, OUSD, 1000n, { ...STATE, settled: 999_000n }))
      .toEqual({ ok: false, reason: 'insufficient_headroom' })
  })
})

describe('checkSessionPreflight', () => {
  it('refuses when no channel is installed', async () => {
    vi.mocked(getTempoChannel).mockResolvedValue(null)
    expect(await checkSessionPreflight(env, 'openai_chat', OUSD, 1n)).toEqual({ ok: false, reason: 'channel_not_installed' })
  })
  it('refuses when the chain cannot be read', async () => {
    vi.mocked(getTempoChannel).mockResolvedValue(CHANNEL as never)
    const read = vi.fn().mockRejectedValue(new Error('rpc down'))
    expect(await checkSessionPreflight(env, 'openai_chat', OUSD, 1n, read)).toEqual({ ok: false, reason: 'read_failed' })
  })
  it('passes on a healthy channel', async () => {
    vi.mocked(getTempoChannel).mockResolvedValue(CHANNEL as never)
    expect(await checkSessionPreflight(env, 'openai_chat', OUSD, 1n, async () => STATE)).toEqual({ ok: true })
  })
})
