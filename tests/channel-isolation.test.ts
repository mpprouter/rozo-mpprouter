/**
 * P0-A isolation: the playground channel dispatch resolves ONLY from the
 * isolated pg registry and never trusts a shared/legacy production
 * stellarAgent/stellarChannel record. It also re-asserts provenance stored at
 * register time against the current config.
 */

import { describe, expect, it, vi } from 'vitest'

// createStellarChannelPayment needs the atomic store; stub mppx/server.
vi.mock('mppx/server', () => ({
  Store: { cloudflare: () => ({ get: async () => null, update: async () => true }) },
  Mppx: { create: () => ({ tag: 'mppx' }) },
}))
vi.mock('../src/mpp/kv-atomic-store', () => ({ doAtomicParams: () => ({}) }))

import { resolvePgChannelMppx } from '../src/playground/channel-pg-dispatch'
import { StellarChannelNotRegisteredError } from '../src/mpp/stellar-channel-dispatch'
import { PG_PROVENANCE_VERSION } from '../src/playground/channel-pg-store'

const CHANNEL = 'C' + 'A'.repeat(55)
const FUNDER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const COLLECTOR = 'GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK'
const WASM_HASH = 'ab'.repeat(32)

function makeKv(seed: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    map: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v)
    },
  }
}

function env(kv: ReturnType<typeof makeKv>, overrides: Record<string, unknown> = {}) {
  return {
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_RPC_URL: 'https://rpc.example',
    MPP_STORE: kv,
    ATOMIC_STORE: {},
    MPP_SECRET_KEY: 'k',
    PLAYGROUND_CHANNEL_TO: COLLECTOR,
    PLAYGROUND_CHANNEL_WASM_HASH: WASM_HASH,
    ...overrides,
  } as any
}

const AUTH = null
const HINT = FUNDER

const goodPgRecord = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    channelContract: CHANNEL,
    commitmentKey: FUNDER,
    agentAccount: FUNDER,
    currency: USDC_SAC,
    network: 'stellar:pubnet',
    depositRaw: '2000000',
    to: COLLECTOR,
    wasmHash: WASM_HASH,
    provenanceVersion: PG_PROVENANCE_VERSION,
    openedAt: 'now',
    ...over,
  })

describe('resolvePgChannelMppx — isolation + provenance re-assert', () => {
  it('IGNORES a shared/legacy production stellarAgent/stellarChannel record', async () => {
    // Only production-namespace records exist — no pgAgent/pgChannel.
    const kv = makeKv({
      [`stellarAgent:${FUNDER}`]: CHANNEL,
      [`stellarChannel:${CHANNEL}`]: JSON.stringify({
        channelContract: CHANNEL,
        commitmentKey: FUNDER,
        agentAccount: FUNDER,
        currency: USDC_SAC,
        network: 'stellar:pubnet',
        depositRaw: '2000000',
        openedAt: 'now',
      }),
    })
    await expect(resolvePgChannelMppx(env(kv), AUTH, HINT)).rejects.toBeInstanceOf(
      StellarChannelNotRegisteredError,
    )
  })

  it('resolves a valid, provenanced pg record', async () => {
    const kv = makeKv({ [`pgAgent:${FUNDER}`]: CHANNEL, [`pgChannel:${CHANNEL}`]: goodPgRecord() })
    const r = await resolvePgChannelMppx(env(kv), AUTH, HINT)
    expect(r.channelContract).toBe(CHANNEL)
    expect(r.agentAccount).toBe(FUNDER)
  })

  it('rejects a pg record whose provenance version is stale', async () => {
    const kv = makeKv({
      [`pgAgent:${FUNDER}`]: CHANNEL,
      [`pgChannel:${CHANNEL}`]: goodPgRecord({ provenanceVersion: 0 }),
    })
    await expect(resolvePgChannelMppx(env(kv), AUTH, HINT)).rejects.toBeInstanceOf(
      StellarChannelNotRegisteredError,
    )
  })

  it('rejects a pg record whose stored `to` no longer matches the collector (config drift)', async () => {
    const kv = makeKv({
      [`pgAgent:${FUNDER}`]: CHANNEL,
      [`pgChannel:${CHANNEL}`]: goodPgRecord({ to: FUNDER }),
    })
    await expect(resolvePgChannelMppx(env(kv), AUTH, HINT)).rejects.toBeInstanceOf(
      StellarChannelNotRegisteredError,
    )
  })

  it('rejects a pg record whose stored WASM hash no longer matches config', async () => {
    const kv = makeKv({
      [`pgAgent:${FUNDER}`]: CHANNEL,
      [`pgChannel:${CHANNEL}`]: goodPgRecord({ wasmHash: 'cd'.repeat(32) }),
    })
    await expect(resolvePgChannelMppx(env(kv), AUTH, HINT)).rejects.toBeInstanceOf(
      StellarChannelNotRegisteredError,
    )
  })
})
