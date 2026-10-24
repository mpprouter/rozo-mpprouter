import { describe, it, expect } from 'vitest'
import { checkTempoChannels, CHANNEL_WATCH_INTERVAL_MS, TIP1034_ESCROW } from '../src/utils/tempo-channel-watch'
import { alertAudience } from '../src/utils/alert'
import { getRouteByPublicPath } from '../src/services/merchants'
import { sessionChannelKeyFor } from '../src/mpp/channel-store'

const ID_A = '0x' + 'a'.repeat(64)
const ID_B = '0x' + 'b'.repeat(64)

function memKv(init: Record<string, string>) {
  const m = new Map(Object.entries(init))
  return {
    m,
    async get(k: string) { return m.get(k) ?? null },
    async put(k: string, v: string) { m.set(k, v) },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }
    },
  }
}

function channels() {
  return {
    'tempoChannel:anthropic_messages': JSON.stringify({ channelId: ID_A, escrowContract: TIP1034_ESCROW, cumulativeRaw: '1000', depositRaw: '1001000' }),
    'tempoChannel:openai_chat': JSON.stringify({ channelId: ID_B, escrowContract: TIP1034_ESCROW, cumulativeRaw: '1000', depositRaw: '2001000' }),
    'tempoChannel:dune_execute': JSON.stringify({ channelId: '0x' + 'c'.repeat(64), escrowContract: '0x33b901018174DDabE4841042ab76ba85D4e24f25', cumulativeRaw: '4000000' }),
  }
}

describe('tempo channel watch', () => {
  it('uses the on-chain deposit, not the KV figure, and alerts once on transition', async () => {
    const kv = memKv(channels())
    const seen: string[][] = []
    const readStates = async (ids: `0x${string}`[]) => {
      seen.push(ids)
      return ids.map((id) => (id === ID_A ? { deposit: 1000n, settled: 0n } : { deposit: 5_000_000n, settled: 1000n }))
    }
    const t0 = new Date('2026-10-25T00:00:00Z')
    const r1 = await checkTempoChannels({ kv, readStates, now: t0 })
    expect(seen[0]).toEqual([ID_A, ID_B]) // legacy-escrow channel skipped
    expect(r1!.messages).toHaveLength(1)
    expect(r1!.messages[0]).toContain('anthropic_messages')
    expect(r1!.messages[0]).not.toContain('openai_chat')
    expect(alertAudience(r1!.messages[0])).toBe('founder')
    await r1!.commit()

    // Within the interval: gated.
    expect(await checkTempoChannels({ kv, readStates, now: new Date(t0.getTime() + 60_000) })).toBeNull()

    // Next interval, still low: silent.
    const t1 = new Date(t0.getTime() + CHANNEL_WATCH_INTERVAL_MS)
    const r2 = await checkTempoChannels({ kv, readStates, now: t1 })
    expect(r2!.messages).toHaveLength(0)
    await r2!.commit()

    // Topped up: one recovery message, to ops.
    const r3 = await checkTempoChannels({
      kv,
      readStates: async (ids) => ids.map(() => ({ deposit: 5_000_000n, settled: 0n })),
      now: new Date(t1.getTime() + CHANNEL_WATCH_INTERVAL_MS),
    })
    expect(r3!.messages).toHaveLength(1)
    expect(r3!.messages[0]).toContain('restored')
    expect(alertAudience(r3!.messages[0])).toBe('ops')
  })

  it('treats an unreadable chain as unknown, never low, and does not commit', async () => {
    const kv = memKv(channels())
    const r = await checkTempoChannels({ kv, readStates: async () => { throw new Error('rpc down') } })
    expect(r).toBeNull()
    expect(kv.m.has('tempo-channel-watch:state')).toBe(false)
  })

  it('counts KV cumulative above settled as used', async () => {
    const kv = memKv(channels())
    const r = await checkTempoChannels({
      kv,
      // KV cumulative 0.001: A headroom 0.049999 (low), B headroom 0.05 (ok)
      readStates: async (ids) => ids.map((id) => ({ deposit: id === ID_A ? 50_999n : 51_000n, settled: 0n })),
    })
    expect(r!.messages[0]).toContain('anthropic_messages')
    expect(r!.messages[0]).not.toContain('openai_chat')
  })
})

describe('route fixes 2026-10-25', () => {
  it('anthropic chat_completions pays through the anthropic_messages channel', () => {
    const route = getRouteByPublicPath('/v1/services/anthropic/chat_completions', 'POST')!
    expect(route.upstreamPaymentMethod).toBe('tempo.session')
    expect(sessionChannelKeyFor(route)).toBe('anthropic_messages')
    const messages = getRouteByPublicPath('/v1/services/anthropic/messages', 'POST')!
    expect(sessionChannelKeyFor(messages)).toBe('anthropic_messages')
  })

  it('storage upload is not payable', () => {
    const route = getRouteByPublicPath('/v1/services/storage/upload', 'POST')!
    expect(route.verifiedMode).toBe(false)
  })
})
