import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

import {
  assertChallengeMatchesApproval,
  assertOpenedChannel,
  assertSlotsReady,
  installChannel,
  parseSessionChallenge,
  type SlotStore,
} from '../scripts/admin/lib/tempo-channel-migration'
import { loadTempoRouterAccount } from '../scripts/admin/lib/tempo-router-key'

const OUSD = '0x20c0000000000000000000006a37DA5C996874BE'
const USDC = '0x20c000000000000000000000b9537d11c60e8b50'
const PAYEE = '0xca4e835F803cB0b7C428222B3A3B98518d4779Fe'
const ESCROW = '0x4d50500000000000000000000000000000000000'
const WALLET = '0x5096Cf4DF15c039D6a9D9EA4051874372206e795'
const OLD_WALLET = '0x4374b2072ff9bc5c0e263CaE7866a41a4C601d29'

function header(request: Record<string, unknown>, intent = 'session') {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64url')
  return `Payment id="x", realm="r", method="tempo", intent="${intent}", request="${encoded}"`
}
const REQUEST = {
  amount: '1000',
  currency: OUSD,
  recipient: PAYEE,
  methodDetails: { escrowContract: ESCROW, chainId: 4217 },
}
const CHALLENGE = parseSessionChallenge(header(REQUEST))
const DESCRIPTOR = {
  authorizedSigner: WALLET,
  expiringNonceHash: '0x00',
  operator: WALLET,
  payee: PAYEE,
  payer: WALLET,
  salt: '0x01',
  token: OUSD,
}

function store(seed: Record<string, string> = {}): SlotStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return { map, get: (k) => map.get(k) ?? null, put: (k, v) => void map.set(k, v) }
}
const OLD = JSON.stringify({ channelId: '0xold', authorizedSigner: OLD_WALLET, currency: USDC, cumulativeRaw: '3000' })
const NEXT = { channelId: '0xnew', authorizedSigner: WALLET, currency: OUSD, cumulativeRaw: '1000' }
const expected = (over = {}) => ({
  merchantId: 'openai_chat',
  oldChannelId: '0xold',
  walletAddress: WALLET,
  snapshot: () => {},
  ...over,
})

describe('parseSessionChallenge', () => {
  it('reads the live OUSD challenge fields', () => {
    expect(CHALLENGE).toMatchObject({ currency: OUSD, recipient: PAYEE, escrowContract: ESCROW, chainId: 4217, decimals: 6 })
  })
  it.each([
    ['no header', null],
    ['charge intent', header(REQUEST, 'charge')],
    ['no escrow', header({ ...REQUEST, methodDetails: { chainId: 4217 } })],
    ['no currency', header({ ...REQUEST, currency: '' })],
    ['no chain', header({ ...REQUEST, methodDetails: { escrowContract: ESCROW } })],
    ['other decimals', header({ ...REQUEST, decimals: 18 })],
  ])('refuses %s', (_name, value) => {
    expect(() => parseSessionChallenge(value)).toThrow()
  })
})

describe('assertChallengeMatchesApproval', () => {
  it('refuses a currency other than the approved one', () => {
    expect(() =>
      assertChallengeMatchesApproval(CHALLENGE, { currency: USDC, depositRaw: 1n, maxDepositRaw: 1n }),
    ).toThrow(/approved/)
  })
  it('refuses a deposit above the ceiling', () => {
    expect(() =>
      assertChallengeMatchesApproval(CHALLENGE, { currency: OUSD, depositRaw: 2n, maxDepositRaw: 1n }),
    ).toThrow(/ceiling/)
  })
})

describe('assertOpenedChannel', () => {
  const good = {
    channelId: '0xnew',
    escrow: ESCROW,
    descriptor: DESCRIPTOR,
    onChain: { token: OUSD, deposit: 1_000_000n, settled: 0n, closeRequestedAt: 0n },
  }
  it('accepts a channel that agrees everywhere', () => {
    expect(() => assertOpenedChannel(good, CHALLENGE, WALLET, 1_000_000n)).not.toThrow()
  })
  it.each([
    ['missing descriptor', { descriptor: undefined }],
    ['wrong escrow', { escrow: PAYEE }],
    ['wrong token', { descriptor: { ...DESCRIPTOR, token: USDC } }],
    ['wrong payee', { descriptor: { ...DESCRIPTOR, payee: WALLET } }],
    ['wrong payer', { descriptor: { ...DESCRIPTOR, payer: OLD_WALLET } }],
    ['wrong signer', { descriptor: { ...DESCRIPTOR, authorizedSigner: OLD_WALLET } }],
    ['short deposit', { onChain: { ...good.onChain, deposit: 1n } }],
    ['closing', { onChain: { ...good.onChain, closeRequestedAt: 5n } }],
  ])('refuses %s', (_name, over) => {
    expect(() => assertOpenedChannel({ ...good, ...over }, CHALLENGE, WALLET, 1_000_000n)).toThrow(/refusing/)
  })
})

describe('slot migration', () => {
  it('moves the old record to alt, installs the new one and snapshots first', () => {
    const kv = store({ 'tempoChannel:openai_chat': OLD })
    const snaps: unknown[] = []
    installChannel(kv, expected({ snapshot: (s: unknown) => snaps.push(s) }), NEXT)
    expect(kv.map.get('tempoChannelAlt:openai_chat')).toBe(OLD)
    expect(JSON.parse(kv.map.get('tempoChannel:openai_chat')!).channelId).toBe('0xnew')
    expect(snaps).toEqual([{ primary: OLD, alt: null }])
  })
  it('refuses to overwrite an occupied alt slot', () => {
    const kv = store({ 'tempoChannel:openai_chat': OLD, 'tempoChannelAlt:openai_chat': '{}' })
    expect(() => assertSlotsReady(kv, expected())).toThrow(/overwrite/)
  })
  it('refuses when the primary is not the expected channel', () => {
    const kv = store({ 'tempoChannel:openai_chat': OLD })
    expect(() => assertSlotsReady(kv, expected({ oldChannelId: '0xother' }))).toThrow(/not the expected/)
  })
  it('refuses a primary this wallet already signs', () => {
    const mine = JSON.stringify({ channelId: '0xold', authorizedSigner: WALLET, currency: USDC, cumulativeRaw: '0' })
    expect(() => assertSlotsReady(store({ 'tempoChannel:openai_chat': mine }), expected())).toThrow(/already signed/)
  })
  it('stops when the primary changes during the move, without installing', () => {
    const kv = store({ 'tempoChannel:openai_chat': OLD })
    const put = kv.put
    kv.put = (k, v) => {
      put(k, v)
      if (k.startsWith('tempoChannelAlt:')) kv.map.set('tempoChannel:openai_chat', OLD.replace('3000', '4000'))
    }
    expect(() => installChannel(kv, expected(), NEXT)).toThrow(/not idle/)
    expect(kv.map.get('tempoChannel:openai_chat')).toContain('4000')
  })
  it('waits out KV lag on read-back', () => {
    const kv = store({ 'tempoChannel:openai_chat': OLD })
    const put = kv.put
    let pending: [string, string] | null = null
    kv.put = (k, v) => { pending = [k, v] }
    kv.wait = () => { if (pending) { put(pending[0], pending[1]); pending = null } }
    installChannel(kv, expected(), NEXT)
    expect(kv.map.get('tempoChannelAlt:openai_chat')).toBe(OLD)
    expect(JSON.parse(kv.map.get('tempoChannel:openai_chat')!).channelId).toBe('0xnew')
  })
  it('stops when a write does not read back', () => {
    const kv = store({ 'tempoChannel:openai_chat': OLD })
    kv.put = () => {}
    expect(() => installChannel(kv, expected(), NEXT)).toThrow(/read back/)
  })
})

describe('loadTempoRouterAccount', () => {
  const KEY = `0x${'11'.repeat(32)}`
  it('derives the account from the Keychain value', () => {
    expect(loadTempoRouterAccount(() => `${KEY}\n`).address).toBe(privateKeyToAccount(KEY as `0x${string}`).address)
  })
  it('refuses a malformed value without echoing it', () => {
    expect(() => loadTempoRouterAccount(() => 'secret-garbage')).toThrow(/does not hold/)
    try {
      loadTempoRouterAccount(() => 'secret-garbage')
    } catch (err) {
      expect(String(err)).not.toContain('secret-garbage')
    }
  })
  it('reports a missing item', () => {
    expect(() => loadTempoRouterAccount(() => { throw new Error('nope') })).toThrow(/not found/)
  })
})
