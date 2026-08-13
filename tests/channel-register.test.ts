/**
 * Non-custodial channel playground — register endpoint on-chain verification.
 *
 * The endpoint is the trust boundary between an anonymous browser and the
 * router's money. It must confirm PROVENANCE (the contract is our known channel
 * WASM), that the channel pays the dedicated COLLECTOR, in USDC, funded by the
 * claimed account with the claimed commitment key, and holds a REAL SAC balance
 * above a minimum — BEFORE writing KV. The on-chain read is injected so these
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
// Dedicated hot collector (Option A) — the channel must pay TO this.
const COLLECTOR = 'GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK'
// Our known channel WASM hash (lowercase hex) — the provenance anchor.
const WASM_HASH = 'ab'.repeat(32)

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
    to: COLLECTOR,
    commitmentKeyHex: COMMIT_HEX,
    refundWaitingPeriod: 100,
    balanceRaw: '2000000', // 0.2 USDC — REAL SAC balance, above the 0.1 minimum
    wasmHash: WASM_HASH,
    closeEffectiveAtLedger: null, // fully open
    ...overrides,
  }
}

const EXPECTED = {
  collector: COLLECTOR,
  usdcSac: USDC_SAC,
  funder: FUNDER,
  commitmentKeyG: COMMIT_G,
  refundWaitingPeriod: 100,
  minDepositRaw: 1_000_000n, // 0.1 USDC
  wasmHash: WASM_HASH,
}

describe('checkChannelMatches (pure on-chain comparison)', () => {
  it('accepts a correct channel', () => {
    expect(checkChannelMatches(goodOnChain(), EXPECTED).ok).toBe(true)
  })

  it('rejects a WASM-hash mismatch (fake look-alike contract)', () => {
    const r = checkChannelMatches(goodOnChain({ wasmHash: 'cd'.repeat(32) }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wasm_mismatch')
  })

  it('rejects a contract with no WASM hash (e.g. a built-in SAC)', () => {
    const r = checkChannelMatches(goodOnChain({ wasmHash: '' }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wasm_mismatch')
  })

  it('fails closed when our WASM hash is not configured', () => {
    const r = checkChannelMatches(goodOnChain(), { ...EXPECTED, wasmHash: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wasm_not_configured')
  })

  it('rejects when `to` is not the collector', () => {
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

  it('rejects a channel whose REAL SAC balance is zero', () => {
    const r = checkChannelMatches(goodOnChain({ balanceRaw: '0' }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('insufficient_deposit')
  })

  it('rejects a channel already in close_start (P0-2)', () => {
    const r = checkChannelMatches(goodOnChain({ closeEffectiveAtLedger: 123456 }), EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('channel_closing')
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
    STELLAR_ROUTER_PUBLIC: 'GBJ7NMENUWLOA5Z5UC3YQROMMY3XKHZYAOYOFL2SXJUGNRVZVG5GAYBV',
    STELLAR_RPC_URL: 'https://rpc.example',
    MPP_STORE: kv,
    ATOMIC_STORE: {},
    PLAYGROUND_CHANNEL_ENABLED: 'true',
    PLAYGROUND_CHANNEL_TO: COLLECTOR,
    PLAYGROUND_CHANNEL_WASM_HASH: WASM_HASH,
  } as any
}

function registerReq(body: unknown) {
  return new Request('https://api.test/v1/playground/channel/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  })
}

// Frontend (PR #20) snake_case contract.
const GOOD_BODY = {
  channel_contract: CHANNEL,
  funder: FUNDER,
  commitment_key: COMMIT_G,
  token: USDC_SAC,
  network: 'stellar:pubnet',
  deposit_raw: '2000000',
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

  it('fails closed (503) when the collector is not configured', async () => {
    const env = { ...makeEnv(kv), PLAYGROUND_CHANNEL_TO: '' }
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain(),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('collector_not_configured')
  })

  it('fails closed (503) when the WASM hash is not configured', async () => {
    const env = { ...makeEnv(kv), PLAYGROUND_CHANNEL_WASM_HASH: '' }
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain(),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('wasm_not_configured')
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
    expect(json.channel).toBe(CHANNEL)
    expect(json.funder).toBe(FUNDER)
    expect(json.commitment_key).toBe(COMMIT_G)
    expect(read).toHaveBeenCalledOnce()
    // Written to the ISOLATED playground namespace (pgChannel/pgAgent), NOT the
    // production stellarChannel/stellarAgent path. deposit persisted from the
    // REAL on-chain SAC balance, not the client's claim.
    expect(kv.map.get(`pgChannel:${CHANNEL}`)).toBeTruthy()
    expect(kv.map.get(`pgAgent:${FUNDER}`)).toBe(CHANNEL)
    // Production registry untouched.
    expect(kv.map.get(`stellarChannel:${CHANNEL}`)).toBeUndefined()
    expect(kv.map.get(`stellarAgent:${FUNDER}`)).toBeUndefined()
    const stored = JSON.parse(kv.map.get(`pgChannel:${CHANNEL}`)!)
    expect(stored.depositRaw).toBe('2000000')
    expect(stored.commitmentKey).toBe(COMMIT_G)
    expect(stored.to).toBe(COLLECTOR)
    expect(stored.wasmHash).toBe(WASM_HASH)
    expect(stored.provenanceVersion).toBe(1)
  })

  it('does NOT replay a stored record that predates provenance — re-verifies on-chain', async () => {
    const env = makeEnv(kv)
    // Seed a stale record (provenanceVersion 0) with the same params.
    kv.map.set(
      `pgChannel:${CHANNEL}`,
      JSON.stringify({
        channelContract: CHANNEL,
        commitmentKey: COMMIT_G,
        agentAccount: FUNDER,
        currency: USDC_SAC,
        network: 'stellar:pubnet',
        depositRaw: '2000000',
        to: COLLECTOR,
        wasmHash: WASM_HASH,
        provenanceVersion: 0,
        openedAt: 'old',
      }),
    )
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: read,
    })
    expect(res.status).toBe(200)
    // Re-verified on-chain (NOT a blind replay short-circuit)...
    expect(read).toHaveBeenCalledOnce()
    expect((await res.json()).replayed).toBe(false)
    // ...and the record was upgraded to the current provenance version.
    expect(JSON.parse(kv.map.get(`pgChannel:${CHANNEL}`)!).provenanceVersion).toBe(1)
  })

  it('rejects a fake look-alike contract (WASM-hash mismatch), no KV write', async () => {
    const env = makeEnv(kv)
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain({ wasmHash: 'cd'.repeat(32) }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('wasm_mismatch')
    expect(kv.map.size).toBe(0)
  })

  it('rejects when on-chain `to` is not the collector (no KV write)', async () => {
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

  it('rejects a channel already in close_start (no KV write) (P0-2)', async () => {
    const env = makeEnv(kv)
    const res = await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain({ closeEffectiveAtLedger: 999999 }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('channel_closing')
    expect(kv.map.size).toBe(0)
  })

  it('rejects a self-reported deposit whose REAL SAC balance is zero (no KV write)', async () => {
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
    expect(read).toHaveBeenCalledOnce()
  })

  it('returns 409 when the same contract is re-registered with different params', async () => {
    const env = makeEnv(kv)
    await handleChannelRegister(registerReq(GOOD_BODY), env, {
      readChannelOnChain: async () => goodOnChain(),
    })
    const conflicting = { ...GOOD_BODY, funder: Keypair.random().publicKey() }
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
      registerReq({ ...GOOD_BODY, token: 'C' + 'C'.repeat(55) }),
      env,
      { readChannelOnChain: read },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unsupported_currency')
    expect(read).not.toHaveBeenCalled()
  })
})
