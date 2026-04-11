/**
 * Unit tests for src/mpp/channel-store.ts — the KV helpers that
 * persist Tempo channel state for the session path.
 *
 * Uses a fake in-memory KV that implements the subset of
 * KVNamespace the store actually touches (get, put, list). The
 * goal is to exercise the monotone-bump semantics and the JSON
 * round-trip without booting Miniflare.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getTempoChannel,
  putTempoChannel,
  listTempoChannels,
  bumpCumulative,
  type TempoChannelState,
} from '../src/mpp/channel-store'

/**
 * Minimal in-memory KV that matches the subset of KVNamespace
 * used by channel-store.ts. Deliberately NOT a full KV polyfill —
 * adding more surface area here would only obscure what the store
 * actually depends on.
 */
function makeFakeKV() {
  const m = new Map<string, string>()
  return {
    async get(k: string) {
      return m.has(k) ? (m.get(k) as string) : null
    },
    async put(k: string, v: string) {
      m.set(k, v)
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const keys = [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }))
      return { keys, list_complete: true, cursor }
    },
    // Test-only helper; not part of the KVNamespace surface.
    _raw: m,
  }
}

function makeEnv() {
  return { MPP_STORE: makeFakeKV() } as any
}

function sampleState(overrides: Partial<TempoChannelState> = {}): TempoChannelState {
  return {
    channelId: '0xabc',
    escrowContract: '0xdef',
    payee: '0x111',
    currency: '0x222',
    chainId: 12345,
    authorizedSigner: '0x4374b2072ff9bc5c0e263CaE7866a41a4C601d29',
    cumulativeRaw: '0',
    depositRaw: '5000000', // $5 at 6 decimals
    openedAt: '2026-04-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('getTempoChannel', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => {
    env = makeEnv()
  })

  it('returns null when no channel exists', async () => {
    expect(await getTempoChannel(env, 'openrouter')).toBeNull()
  })

  it('round-trips a full state through JSON', async () => {
    const state = sampleState({ cumulativeRaw: '12345' })
    await putTempoChannel(env, 'openrouter', state)
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded).toEqual(state)
  })

  it('returns null on a corrupt KV entry rather than throwing', async () => {
    // Hand-edited garbage simulating operator error.
    await env.MPP_STORE.put('tempoChannel:broken', '{ not valid json')
    expect(await getTempoChannel(env, 'broken')).toBeNull()
  })
})

describe('putTempoChannel', () => {
  it('blind-overwrites cumulativeRaw — callers that want monotone must use bumpCumulative', async () => {
    const env = makeEnv()
    await putTempoChannel(env, 'openrouter', sampleState({ cumulativeRaw: '500' }))
    await putTempoChannel(env, 'openrouter', sampleState({ cumulativeRaw: '100' }))
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded?.cumulativeRaw).toBe('100')
  })
})

describe('listTempoChannels', () => {
  it('returns every installed channel keyed by merchantId', async () => {
    const env = makeEnv()
    await putTempoChannel(env, 'openrouter', sampleState({ channelId: '0xaaa' }))
    await putTempoChannel(env, 'other', sampleState({ channelId: '0xbbb' }))
    const list = await listTempoChannels(env)
    expect(list).toHaveLength(2)
    const ids = list.map((e) => e.merchantId).sort()
    expect(ids).toEqual(['openrouter', 'other'])
  })

  it('returns an empty array when no channels are installed', async () => {
    const env = makeEnv()
    expect(await listTempoChannels(env)).toEqual([])
  })

  it('ignores unrelated KV entries that share the worker', async () => {
    const env = makeEnv()
    // An unrelated idempotency cache entry from the charge path.
    await env.MPP_STORE.put('idempotency:some-request', 'cached-body')
    await putTempoChannel(env, 'openrouter', sampleState())
    const list = await listTempoChannels(env)
    expect(list).toHaveLength(1)
    expect(list[0].merchantId).toBe('openrouter')
  })
})

describe('bumpCumulative', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => {
    env = makeEnv()
  })

  it('advances cumulative on a strictly greater value', async () => {
    await putTempoChannel(env, 'openrouter', sampleState({ cumulativeRaw: '1000' }))
    await bumpCumulative(env, 'openrouter', '5000')
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded?.cumulativeRaw).toBe('5000')
  })

  it('sets lastVoucherAt on a successful bump', async () => {
    await putTempoChannel(env, 'openrouter', sampleState({ cumulativeRaw: '0' }))
    await bumpCumulative(env, 'openrouter', '1')
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded?.lastVoucherAt).toBeTruthy()
    // ISO-8601, parseable
    expect(new Date(loaded!.lastVoucherAt!).toString()).not.toBe('Invalid Date')
  })

  it('silently drops a bump with an equal value (no rewind, no update)', async () => {
    await putTempoChannel(env, 'openrouter', sampleState({ cumulativeRaw: '1000' }))
    await bumpCumulative(env, 'openrouter', '1000')
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded?.cumulativeRaw).toBe('1000')
    // Equal values mean "no new voucher" — lastVoucherAt stays unset.
    expect(loaded?.lastVoucherAt).toBeUndefined()
  })

  it('silently drops a bump with a lower value (race losing writer, not an error)', async () => {
    await putTempoChannel(env, 'openrouter', sampleState({ cumulativeRaw: '5000' }))
    await bumpCumulative(env, 'openrouter', '3000')
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded?.cumulativeRaw).toBe('5000')
  })

  it('handles amounts larger than Number.MAX_SAFE_INTEGER via BigInt', async () => {
    await putTempoChannel(
      env,
      'openrouter',
      sampleState({ cumulativeRaw: '9007199254740993' }), // 2^53 + 1
    )
    await bumpCumulative(env, 'openrouter', '18014398509481984') // 2 * (2^53 + ε)
    const loaded = await getTempoChannel(env, 'openrouter')
    expect(loaded?.cumulativeRaw).toBe('18014398509481984')
  })

  it('throws when the incoming cumulative is not a non-negative integer string', async () => {
    await putTempoChannel(env, 'openrouter', sampleState())
    await expect(bumpCumulative(env, 'openrouter', '1.5')).rejects.toThrow(/non-negative integer/)
    await expect(bumpCumulative(env, 'openrouter', '-5')).rejects.toThrow(/non-negative integer/)
    await expect(bumpCumulative(env, 'openrouter', 'abc')).rejects.toThrow(/non-negative integer/)
  })

  it('throws when no channel exists for the merchant', async () => {
    await expect(bumpCumulative(env, 'nonexistent', '100')).rejects.toThrow(/no channel/)
  })
})
