/**
 * mpp-spec §3.4 channel registration — the spec body shape.
 *
 *   { channel, commitmentKey, salt, from, signature }
 *
 * Two checks the legacy body cannot perform: the channel must be the address
 * the factory deploys for (from, salt) (check 1), and the request must be
 * signed by `from` (check 6). Everything after that is the shared on-chain
 * verification, exercised in channel-register.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Keypair, Networks, hash } from '@stellar/stellar-sdk'

vi.mock('../src/mpp/rate-limit-do', () => ({
  checkAndBumpDailyLimit: vi.fn(async () => ({ ok: true, used: 1, limit: 30 })),
  utcDateKey: () => '2026-09-15',
}))

import { deriveChannelAddress, parseSaltHex } from '../src/playground/channel-address'
import {
  channelRegisterMessage,
  signChannelRegister,
  verifyChannelRegisterSignature,
} from '../src/playground/channel-register-auth'
import type { OnChainChannel } from '../src/playground/channel-onchain'
import { handleChannelRegister } from '../src/routes/playground-channel'

const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const COLLECTOR = 'GBD64XFGJHG42CEVQKH4TYCIAMEHVBMW7A24KS22TKOSSA73IVW3CYIK'
const FACTORY = 'CCR2HE6CAMBYNUQG4N27CH5EAYELGYTQIONTYJ72K63XQZSL23OV7RTX'
const WASM_HASH = 'ab'.repeat(32)

const funderKp = Keypair.random()
const FUNDER = funderKp.publicKey()
const commitKp = Keypair.random()
const COMMIT_G = commitKp.publicKey()
const COMMIT_HEX = Buffer.from(commitKp.rawPublicKey()).toString('hex')
const SALT = Buffer.from('11'.repeat(32), 'hex')
const CHANNEL = deriveChannelAddress(FACTORY, FUNDER, SALT, Networks.PUBLIC)

describe('deriveChannelAddress', () => {
  it('reproduces the pubnet factory: open(salt) from the collector account', () => {
    // Fixture captured 2026-09-15 by simulating factory.open(salt, USDC, from=
    // collector, ..., amount=0) on pubnet against CCR2HE6C… and reading the
    // returned address. Locks the derivation (DeploymentSaltPreimage =
    // Vec[Address, Bytes]) so an SDK/xdr change cannot silently move it.
    const salt = Buffer.from('f1a6d5c01ae86dd50cd4d12cb1b2a1c0e2d9f4b8a3c7e6d5f4a3b2c1d0e9f8a7', 'hex')
    const addr = deriveChannelAddress(FACTORY, COLLECTOR, salt, Networks.PUBLIC)
    expect(addr).toBe('CCSXOEEWJ5A35APKRRXCFECPSLIKRIEOOORBTC5EMB6XBLXLZYLA3W3T')
    // Deterministic and sensitive to every input.
    expect(deriveChannelAddress(FACTORY, COLLECTOR, salt, Networks.PUBLIC)).toBe(addr)
    expect(deriveChannelAddress(FACTORY, FUNDER, salt, Networks.PUBLIC)).not.toBe(addr)
    expect(deriveChannelAddress(FACTORY, COLLECTOR, Buffer.from('00'.repeat(32), 'hex'), Networks.PUBLIC)).not.toBe(addr)
    expect(deriveChannelAddress(FACTORY, COLLECTOR, salt, Networks.TESTNET)).not.toBe(addr)
  })

  it('parses hex salts with or without 0x and rejects anything else', () => {
    expect(parseSaltHex('11'.repeat(32))?.equals(SALT)).toBe(true)
    expect(parseSaltHex('0x' + '11'.repeat(32))?.equals(SALT)).toBe(true)
    expect(parseSaltHex('11'.repeat(31))).toBeNull()
    expect(parseSaltHex('zz'.repeat(32))).toBeNull()
    expect(parseSaltHex(42)).toBeNull()
  })
})

describe('channel register signature', () => {
  const tuple = { channel: CHANNEL, commitmentKey: COMMIT_G, saltHex: SALT.toString('hex'), from: FUNDER }

  it('message is domain-separated and binds every field', () => {
    const m = channelRegisterMessage(tuple)
    expect(m.split('\n')).toEqual(['mpprouter.channel-register.v1', CHANNEL, COMMIT_G, SALT.toString('hex'), FUNDER])
  })

  it('accepts a raw ed25519 signature by from', () => {
    expect(verifyChannelRegisterSignature(tuple, signChannelRegister(tuple, funderKp))).toBe(true)
  })

  it('accepts a SEP-53 signed message by from (browser wallets)', () => {
    const digest = hash(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(channelRegisterMessage(tuple))]))
    const sig = funderKp.sign(digest).toString('base64')
    expect(verifyChannelRegisterSignature(tuple, sig)).toBe(true)
  })

  it('rejects another key, a spliced tuple, and garbage', () => {
    const other = Keypair.random()
    expect(verifyChannelRegisterSignature(tuple, signChannelRegister(tuple, other))).toBe(false)
    const sig = signChannelRegister(tuple, funderKp)
    expect(verifyChannelRegisterSignature({ ...tuple, commitmentKey: other.publicKey() }, sig)).toBe(false)
    expect(verifyChannelRegisterSignature({ ...tuple, saltHex: '22'.repeat(32) }, sig)).toBe(false)
    expect(verifyChannelRegisterSignature(tuple, 'not base64!!')).toBe(false)
    expect(verifyChannelRegisterSignature(tuple, '')).toBe(false)
  })
})

// ---- endpoint -------------------------------------------------------------

function goodOnChain(overrides: Partial<OnChainChannel> = {}): OnChainChannel {
  return {
    token: USDC_SAC,
    from: FUNDER,
    to: COLLECTOR,
    commitmentKeyHex: COMMIT_HEX,
    refundWaitingPeriod: 100,
    balanceRaw: '2000000',
    wasmHash: WASM_HASH,
    closeEffectiveAtLedger: null,
    ...overrides,
  }
}

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
    PLAYGROUND_CHANNEL_FACTORY: FACTORY,
  } as any
}

function registerReq(body: unknown) {
  return new Request('https://api.test/v1/playground/channel/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  })
}

function specBody(overrides: Record<string, unknown> = {}, signer: Keypair = funderKp) {
  const base = { channel: CHANNEL, commitmentKey: COMMIT_G, salt: SALT.toString('hex'), from: FUNDER, ...overrides }
  const saltHex = (parseSaltHex(base.salt) ?? SALT).toString('hex')
  const signature = signChannelRegister(
    { channel: String(base.channel), commitmentKey: String(base.commitmentKey), saltHex, from: String(base.from) },
    signer,
  )
  return { ...base, signature, ...('signature' in overrides ? { signature: overrides.signature } : {}) }
}

describe('handleChannelRegister — spec body', () => {
  let kv: ReturnType<typeof makeKv>
  beforeEach(() => {
    kv = makeKv()
  })

  it('registers with camelCase fields and replies in camelCase', async () => {
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(registerReq(specBody()), makeEnv(kv), { readChannelOnChain: read })
    expect(res.status).toBe(200)
    const j = (await res.json()) as any
    expect(j).toEqual({ ok: true, replayed: false, channel: CHANNEL, from: FUNDER, commitmentKey: COMMIT_G, depositUsd: '0.20' })
    expect(read).toHaveBeenCalledOnce()
    expect(kv.map.get(`pgChannel:${CHANNEL}`)).toBeTruthy()
    expect(kv.map.get(`pgAgent:${FUNDER}`)).toBe(CHANNEL)
  })

  it('is idempotent: same signed body replays in camelCase without a chain read', async () => {
    const env = makeEnv(kv)
    await handleChannelRegister(registerReq(specBody()), env, { readChannelOnChain: async () => goodOnChain() })
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(registerReq(specBody()), env, { readChannelOnChain: read })
    expect(res.status).toBe(200)
    expect((await res.json()).replayed).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a bad salt (address_mismatch) before any chain read or KV write', async () => {
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(registerReq(specBody({ salt: '22'.repeat(32) })), makeEnv(kv), { readChannelOnChain: read })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('address_mismatch')
    expect(read).not.toHaveBeenCalled()
    expect(kv.map.size).toBe(0)
  })

  it('rejects a malformed salt', async () => {
    const res = await handleChannelRegister(registerReq(specBody({ salt: 'abc' })), makeEnv(kv), { readChannelOnChain: async () => goodOnChain() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_salt')
  })

  it('rejects a wrong from: the factory would have deployed a different address', async () => {
    const other = Keypair.random()
    const read = vi.fn(async () => goodOnChain())
    // `other` signs honestly for itself, but CHANNEL was derived for FUNDER.
    const res = await handleChannelRegister(registerReq(specBody({ from: other.publicKey() }, other)), makeEnv(kv), { readChannelOnChain: read })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('address_mismatch')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a registration not signed by from (griefing, spec check 6)', async () => {
    const read = vi.fn(async () => goodOnChain())
    for (const body of [
      specBody({}, Keypair.random()), // someone else's key over the right tuple
      specBody({ signature: '' }),
      { channel: CHANNEL, commitmentKey: COMMIT_G, salt: SALT.toString('hex'), from: FUNDER }, // no signature
    ]) {
      const res = await handleChannelRegister(registerReq(body), makeEnv(kv), { readChannelOnChain: read })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('unauthenticated')
    }
    expect(read).not.toHaveBeenCalled()
    expect(kv.map.size).toBe(0)
  })

  it('a signature for one commitment key cannot be reused for another', async () => {
    const good = specBody()
    const otherCommit = Keypair.random().publicKey()
    const res = await handleChannelRegister(
      registerReq({ ...good, commitmentKey: otherCommit }),
      makeEnv(kv),
      { readChannelOnChain: async () => goodOnChain() },
    )
    expect(res.status).toBe(401)
  })

  it('rejects a from with a bad StrKey checksum as 400, not 500', async () => {
    const badFrom = FUNDER.slice(0, -1) + (FUNDER.endsWith('A') ? 'B' : 'A')
    const res = await handleChannelRegister(registerReq(specBody({ from: badFrom })), makeEnv(kv), { readChannelOnChain: async () => goodOnChain() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_funder')
  })

  it('fails closed (503) when the factory is not configured', async () => {
    const env = { ...makeEnv(kv), PLAYGROUND_CHANNEL_FACTORY: '' }
    const res = await handleChannelRegister(registerReq(specBody()), env, { readChannelOnChain: async () => goodOnChain() })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('factory_not_configured')
  })

  it('still runs the shared on-chain checks after address + signature pass', async () => {
    const res = await handleChannelRegister(registerReq(specBody()), makeEnv(kv), {
      readChannelOnChain: async () => goodOnChain({ balanceRaw: '0' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('insufficient_deposit')
    expect(kv.map.size).toBe(0)
  })

  it('rejects the legacy snake_case body with a pointed error, no chain read', async () => {
    const read = vi.fn(async () => goodOnChain())
    const res = await handleChannelRegister(
      registerReq({ channel_contract: CHANNEL, funder: FUNDER, commitment_key: COMMIT_G, token: USDC_SAC, network: 'stellar:pubnet', deposit_raw: '2000000' }),
      makeEnv(kv),
      { readChannelOnChain: read },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('legacy_body')
    expect(read).not.toHaveBeenCalled()
    expect(kv.map.size).toBe(0)
  })
})
