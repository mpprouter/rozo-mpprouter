/**
 * Unit tests for src/mpp/stellar-channel-store.ts.
 *
 * These are pure unit tests against a fake in-memory KV — no
 * Miniflare, no network, no real Stellar RPC. The store is
 * deliberately simple (get / put / list, no monotone bump)
 * because mppx owns cumulative tracking under its own
 * `stellar:channel:*` prefix. We only verify that our sidecar
 * metadata round-trips cleanly and tolerates a corrupt entry
 * the same way the Tempo store does.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getStellarChannel,
  getChannelForAgent,
  putStellarChannel,
  listStellarChannels,
  type StellarChannelState,
} from '../src/mpp/stellar-channel-store'

/**
 * Fake KV that matches the subset of KVNamespace the store uses.
 * Mirrors tests/channel-store.test.ts to keep the two stores'
 * test harnesses shape-compatible — if we ever share infra
 * between them, the fakes line up.
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
    _raw: m,
  }
}

function makeEnv() {
  return { MPP_STORE: makeFakeKV() } as any
}

function sampleState(overrides: Partial<StellarChannelState> = {}): StellarChannelState {
  return {
    channelContract: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    commitmentKey: 'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7',
    agentAccount: 'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7',
    currency: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    network: 'stellar:pubnet',
    depositRaw: '10000000', // 1.00 USDC at 7 decimals
    openedAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('getStellarChannel', () => {
  let env: ReturnType<typeof makeEnv>
  beforeEach(() => {
    env = makeEnv()
  })

  it('returns null when no channel is registered', async () => {
    expect(await getStellarChannel(env, 'CAAAAA...')).toBeNull()
  })

  it('round-trips a full state through JSON', async () => {
    const state = sampleState()
    await putStellarChannel(env, state.channelContract, state)
    const loaded = await getStellarChannel(env, state.channelContract)
    expect(loaded).toEqual(state)
  })

  it('returns null on a corrupt KV entry instead of throwing', async () => {
    // Simulate an operator who hand-edited a KV value and left
    // it broken. The store should degrade gracefully — returning
    // null lets the dispatch path treat the channel as unknown
    // and reject with 402 rather than 500.
    await env.MPP_STORE.put(
      'stellarChannel:CBADDDDDDD',
      '{ not valid json',
    )
    expect(await getStellarChannel(env, 'CBADDDDDDD')).toBeNull()
  })

  it('isolates keys per channel contract', async () => {
    const a = sampleState({
      channelContract: 'CAAAAA',
      depositRaw: '1000000',
    })
    const b = sampleState({
      channelContract: 'CBBBBB',
      depositRaw: '5000000',
    })
    await putStellarChannel(env, 'CAAAAA', a)
    await putStellarChannel(env, 'CBBBBB', b)
    expect((await getStellarChannel(env, 'CAAAAA'))?.depositRaw).toBe('1000000')
    expect((await getStellarChannel(env, 'CBBBBB'))?.depositRaw).toBe('5000000')
  })
})

describe('putStellarChannel', () => {
  it('blind-overwrites — callers must read-modify-write if they want to preserve fields', async () => {
    const env = makeEnv()
    await putStellarChannel(env, 'CAAAAA', sampleState({ depositRaw: '5000000' }))
    await putStellarChannel(env, 'CAAAAA', sampleState({ depositRaw: '1000000' }))
    const loaded = await getStellarChannel(env, 'CAAAAA')
    expect(loaded?.depositRaw).toBe('1000000')
  })
})

describe('listStellarChannels', () => {
  it('returns every registered channel', async () => {
    const env = makeEnv()
    await putStellarChannel(env, 'CAAAAA', sampleState({ channelContract: 'CAAAAA' }))
    await putStellarChannel(env, 'CBBBBB', sampleState({ channelContract: 'CBBBBB' }))
    const list = await listStellarChannels(env)
    expect(list).toHaveLength(2)
    const contracts = list.map((e) => e.channelContract).sort()
    expect(contracts).toEqual(['CAAAAA', 'CBBBBB'])
  })

  it('returns an empty array when no channels are registered', async () => {
    const env = makeEnv()
    expect(await listStellarChannels(env)).toEqual([])
  })

  it('ignores unrelated KV entries that share the Worker', async () => {
    const env = makeEnv()
    // A Tempo channel from src/mpp/channel-store.ts (different prefix).
    await env.MPP_STORE.put('tempoChannel:openrouter_chat', '{"whatever":1}')
    // A V1 idempotency record from src/routes/proxy.ts.
    await env.MPP_STORE.put('idempotency:req-12345', 'cached-body')
    // An mppx-internal cumulative record from a LIVE stellar channel.
    // Same first word `stellar` as our prefix — this is the collision
    // audit from internaldocs/v2-stellar-channel-notes.md §N4 and it
    // MUST NOT be confused with our `stellarChannel:` prefix.
    await env.MPP_STORE.put('stellar:channel:cumulative:CAAAAA', '{"amount":"123"}')
    await putStellarChannel(env, 'CAAAAA', sampleState({ channelContract: 'CAAAAA' }))

    const list = await listStellarChannels(env)
    // Exactly one match. The tempoChannel, idempotency, and
    // mppx-internal `stellar:channel:cumulative:*` keys must be
    // ignored — any of them leaking into the results would signal
    // a collision bug.
    expect(list).toHaveLength(1)
    expect(list[0].channelContract).toBe('CAAAAA')
  })
})

describe('getChannelForAgent', () => {
  it('returns null when the agent has no registered channel', async () => {
    const env = makeEnv()
    expect(await getChannelForAgent(env, 'GAAAAAAAA')).toBeNull()
  })

  it('returns the channel contract address for a registered agent', async () => {
    const env = makeEnv()
    await putStellarChannel(env, 'CAAAAA', sampleState({
      channelContract: 'CAAAAA',
      agentAccount: 'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7',
    }))
    const found = await getChannelForAgent(
      env,
      'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7',
    )
    expect(found).toBe('CAAAAA')
  })

  it('putStellarChannel overwrites the agent index when the same agent registers a new channel', async () => {
    const env = makeEnv()
    const agent = 'GAK67E2ZPVO7S2ALE3M6RT5HKWLKOMWIYNCOIKIMXSBUV5RRRQI7B7K7'
    await putStellarChannel(env, 'CAAAAA', sampleState({
      channelContract: 'CAAAAA',
      agentAccount: agent,
    }))
    expect(await getChannelForAgent(env, agent)).toBe('CAAAAA')
    // Register a second channel for the same agent. V2 assumes
    // one channel per agent, so the later write wins.
    await putStellarChannel(env, 'CBBBBB', sampleState({
      channelContract: 'CBBBBB',
      agentAccount: agent,
    }))
    expect(await getChannelForAgent(env, agent)).toBe('CBBBBB')
  })
})
