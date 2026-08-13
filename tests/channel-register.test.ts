/**
 * Non-custodial channel playground — register endpoint on-chain verification.
 *
 * The endpoint is the trust boundary between an anonymous browser and the
 * router's money: it must confirm the channel really pays the router, in USDC,
 * funded by the claimed account with the claimed commitment key, above a
 * minimum deposit — BEFORE writing KV. The on-chain read is injected so these
 * tests need no live RPC.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'

// Rate limiter hits a Durable Object; stub it to always allow.
vi.mock('../src/mpp/rate-limit-do', () => ({
  checkAndBumpDailyLimit: vi.fn(async () => ({ ok: true, used: 1, limit: 30 })),
  utcDateKey: () => '2026-08-13',
}))

import { checkChannelMatches, type OnChainChannel } from '../src/playground/channel-onchain'
import { handleChannelRegister } from '../src/routes/playground-channel'

const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const ROUTER = 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV'

// Valid channel contract address (C..., 56 chars). Deterministic fixture.
const CHANNEL = 'C' + 'A'.repeat(55)

const funderKp = Keypair.random()
const FUNDER = funderKp.publicKey()
const commitKp = Keypair.random()
const COMMIT_G = commitKp.publicKey()
const COMMIT_HEX = Buffer.from(commitKp.rawPublicKey()).toString('hex')

function goodOnChain(overrides: Partial<OnChainChannel> = {}): OnChainChannel {
  return {
    token: USDC_SAC,
    from: FUNDER,
    to: ROUTER,
    commitmentKeyHex: COMMIT_HEX,
    refundWaitingPeriod: 100,
    balanceRaw: '2000000', // 0.2 USDC — above the 0.1 minimum
    ...overrides,
  }
}

const EXPECTED = {
  routerPublic: ROUTER,
  usdcSac: USDC_SAC,
  funder: FUNDER,
  commitmentKeyG: COMMIT_G,
  refundWaitingPeriod: 100,
  minDepositRaw: 1_000_000n, // 0.1 USDC
}

describe('checkChannelMatches (pure on-chain comparison)', () => {
  it('accepts a correct channel', () => {
    expect(checkChannelMatches(goodOnChain(), EXPECTED).ok).toBe(true)
  })

  it('rejects wrong recipient (to != router)', () => {
    const r = checkChannelMatches(goodOnChain({ to: FUNDER }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('recipient_mismatch')
  })

  it('rejects wrong token', () => {
    const r = checkChannelMatches(goodOnChain({ token: 'C' + 'B'.repeat(55) }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('token_mismatch')
  })

  it('rejects wrong funder', () => {
    const other = Keypair.random().publicKey()
    const r = checkChannelMatches(goodOnChain({ from: other }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('funder_mismatch')
  })

  it('rejects a commitment-key mismatch', () => {
    const r = checkChannelMatches(goodOnChain({ commitmentKeyHex: 'ab'.repeat(32) }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('commitment_key_mismatch')
  })

  it('rejects wrong refund period', () => {
    const r = checkChannelMatches(goodOnChain({ refundWaitingPeriod: 10 }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('refund_period_mismatch')
  })

  it('rejects an unfunded channel (deposit below minimum)', () => {
    const r = checkChannelMatches(goodOnChain({ balanceRaw: '0' }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('insufficient_deposit')
  })
})

// ---- in-memory KV so getStellarChannel/putStellarChannel round-trip --------
function makeKv() {
  const m = new Map<string, string>()
  return {
    map: m,
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      m.set(k, v)
    }),
  }
}

function makeEnv(kv: ReturnType<typeof makeKv>) {
  return {
    STELLAR_NETWORK: 'stellar:pubnet',
    STELLAR_ROUTER_PUBLIC: ROUTER,
    STELLAR_RPC_URL: 'https://rpc.example',
    MPP_STORE: kv,
    ATOMIC_STORE: {},
    PLAYGROUND_CHANNEL_ENABLED: 'true',
  } as any
}

function registerReq(body: unknown) {
  return new Request('https://api.test/v1/playground/channel/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  })
}

const GOOD_BODY = {
  channelContract: CHANNEL,
  agentAccount: FUNDER,
  commitmentKey: COMMIT_G,
  currency: USDC_SAC,
  network: 'stellar:pubnet',
  depositRaw: '2000000',
}

describe('handleChannelRegister', () => {
  let kv: ReturnType<typeof makeKv>
  beforeEach(() => {
    kv = makeKv()
  })

  it('404s when the channel playground is disabled', async () => {
    const env = { ...makeEnv(kv), PLAYGROUND_CHANNEL_ENABLED: 'false' }
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain(),
    })
    expect(res.status).toBe(404)
  })

  it('writes KV after a passing on-chain verification', async () => {
    const env = makeEnv(kv)
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: read,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.ok).toBe(true)
    expect(json.replayed).toBe(false)
    expect(read).toHaveBeenCalledOnce()
    // Primary + agent index written. deposit persisted from the ON-CHAIN
    // balance, not the client's claim.
    expect(kv.map.get(`stellarChannel:${CHANNEL}`)).toBeTruthy()
    expect(kv.map.get(`stellarAgent:${FUNDER}`)).toBe(CHANNEL)
    const stored = JSON.parse(kv.map.get(`stellarChannel:${CHANNEL}`)!)
    expect(stored.depositRaw).toBe('2000000')
    expect(stored.commitmentKey).toBe(COMMIT_G)
  })

  it('rejects when on-chain recipient is not the router (no KV write)', async () => {
    const env = makeEnv(kv)
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain({ to: FUNDER }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('recipient_mismatch')
    expect(kv.map.size).toBe(0)
  })

  it('rejects wrong token on-chain (no KV write)', async () => {
    const env = makeEnv(kv)
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain({ token: 'C' + 'B'.repeat(55) }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('token_mismatch')
    expect(kv.map.size).toBe(0)
  })

  it('rejects wrong funder on-chain (no KV write)', async () => {
    const env = makeEnv(kv)
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain({ from: Keypair.random().publicKey() }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('funder_mismatch')
    expect(kv.map.size).toBe(0)
  })

  it('rejects an unfunded channel (no KV write)', async () => {
    const env = makeEnv(kv)
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain({ balanceRaw: '0' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('insufficient_deposit')
    expect(kv.map.size).toBe(0)
  })

  it('is idempotent: re-registering the same channel replays without re-reading chain', async () => {
    const env = makeEnv(kv)
    const read = vi.fn(async () => goodOnChain())
    const first = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: read,
    })
    expect(first.status).toBe(200)
    const second = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: read,
    })
    expect(second.status).toBe(200)
    expect((await second.json()).replayed).toBe(true)
    // Second call short-circuits on the existing KV record — no second read.
    expect(read).toHaveBeenCalledOnce()
  })

  it('returns 409 when the same contract is re-registered with different params', async () => {
    const env = makeEnv(kv)
    await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain(),
    })
    const conflicting = { ...GOOD_BODY, agentAccount: Keypair.random().publicKey() }
    const res = await handleChannelRegister(registerReq(conflicting), env, {
      readChannelOnChain: async () => goodOnChain(),
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('channel_conflict')
  })

  it('rejects a non-USDC currency before any chain read', async () => {
    const env = makeEnv(kv)
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(
      registerReq({ ...GOOD_BODY, currency: 'C' + 'C'.repeat(55) }),
      env,
      { readChannelOnChain: read },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unsupported_currency')
    expect(read).not.toHaveBeenCalled()
  })
})
