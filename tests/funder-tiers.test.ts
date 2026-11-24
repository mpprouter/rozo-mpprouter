/**
 * Tiered funder wallets: the mirrored selector against the shared vectors, and
 * the FUNDER_TIERS_ENABLED resolver in src/funder-address.ts.
 */
import { describe, expect, it } from 'vitest'
import vectors from '../src/funder-tier-vectors.json'
import { parseUsdcAtomic, routeFunder, selectFunderTier, servedByLegacyFunder } from '../src/funder-tiers'
import {
  coinbaseOrderKind,
  BASE_FUNDER_ADDRESS,
  RETIRED_FUNDER_ADDRESS_20261124,
  checksumFunderAddress,
  configuredFunderWallets,
  funderTierAddress,
  funderTiersEnabled,
  isAnyConfiguredFunderTier,
  resolveFunder,
} from '../src/funder-address'
import { EVM_BLOCKED_ADDRESSES } from '../src/evm-blocked-addresses'
import { BITREFILL_BLOCKED_RECEIVERS } from '../src/routes/bitrefill-binding'

// Valid, distinct, checksummed test addresses (not real wallets).
export const T1 = '0x1000000000000000000000000000000000000001'
export const T2 = '0x2000000000000000000000000000000000000002'
export const T3A = '0x3000000000000000000000000000000000000003'
export const T3B = '0x4000000000000000000000000000000000000004'
export const TIER_ENV = {
  FUNDER_TIERS_ENABLED: 'true',
  FUNDER_T1_ADDRESS: T1,
  FUNDER_T2_ADDRESS: T2,
  FUNDER_T3A_ADDRESS: T3A,
  FUNDER_T3B_ADDRESS: T3B,
}
const ADDR: Record<string, string> = { T1, T2, T3A, T3B }
const USD = (n: number) => BigInt(Math.round(n * 1e6))

describe('mirrored selector vs shared vectors', () => {
  it('selectFunderTier matches every vector', () => {
    expect(vectors.vectors.length).toBeGreaterThan(10)
    for (const v of vectors.vectors) {
      const got = selectFunderTier(v.kind, BigInt(v.amount))
      const label = `${v.kind} ${v.amount}`
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice('refuse:'.length) })
      } else {
        expect(got, label).toEqual({ ok: true, tier: v.expect })
      }
    }
  })

  it('parseUsdcAtomic matches every parse case', () => {
    for (const p of vectors.parse) {
      const got = parseUsdcAtomic(p.in)
      expect(got === null ? null : got.toString(), p.in).toBe(p.out)
    }
  })
})

describe('resolveFunder, flag off (parity)', () => {
  const kinds = ['x402', 'coinbase', 'stripe', 'bitrefill', 'other', 'upi', '']
  const amounts = [0n, -1n, 1n, USD(5), USD(5) + 1n, USD(199.999999), USD(200), USD(1200), USD(1200) + 1n, USD(5000)]
  const offEnvs: Array<Record<string, string | undefined> | undefined | null> = [
    undefined,
    null,
    {},
    { ...TIER_ENV, FUNDER_TIERS_ENABLED: undefined },
    { ...TIER_ENV, FUNDER_TIERS_ENABLED: 'false' },
    { ...TIER_ENV, FUNDER_TIERS_ENABLED: 'TRUE' },
    { ...TIER_ENV, FUNDER_TIERS_ENABLED: ' true' },
    { ...TIER_ENV, FUNDER_TIERS_ENABLED: '1' },
  ]
  it('returns the legacy funder for every kind and amount, with no expected_funder', () => {
    for (const env of offEnvs) {
      expect(funderTiersEnabled(env as any)).toBe(false)
      for (const k of kinds) {
        for (const a of amounts) {
          expect(resolveFunder(env as any, k, a)).toEqual({
            ok: true,
            tier: 'legacy',
            address: BASE_FUNDER_ADDRESS,
            expectedFunder: undefined,
          })
        }
      }
      expect(configuredFunderWallets(env as any)).toEqual([{ tier: 'legacy', address: BASE_FUNDER_ADDRESS }])
      expect(isAnyConfiguredFunderTier(env as any, T1)).toBe(false)
    }
  })
})

describe('resolveFunder, flag on', () => {
  it('picks the configured address of the vector tier, refuses with the vector reason', () => {
    for (const v of vectors.vectors) {
      const got = resolveFunder(TIER_ENV, v.kind, BigInt(v.amount))
      const label = `${v.kind} ${v.amount}`
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice(7), tier: null })
      } else {
        expect(got, label).toEqual({ ok: true, tier: v.expect, address: ADDR[v.expect], expectedFunder: ADDR[v.expect] })
      }
    }
  })

  it('boundaries: $199.999999 -> T2, $200 -> T3A, $1,200 -> T3A, $1,200.000001 refused', () => {
    expect(resolveFunder(TIER_ENV, 'coinbase', USD(199.999999))).toMatchObject({ ok: true, tier: 'T2', address: T2 })
    expect(resolveFunder(TIER_ENV, 'coinbase', USD(200))).toMatchObject({ ok: true, tier: 'T3A', address: T3A })
    expect(resolveFunder(TIER_ENV, 'coinbase', USD(1200))).toMatchObject({ ok: true, tier: 'T3A' })
    expect(resolveFunder(TIER_ENV, 'coinbase', USD(1200) + 1n)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    expect(resolveFunder(TIER_ENV, 'stripe', USD(1200) + 1n)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    expect(resolveFunder(TIER_ENV, 'x402', USD(5) + 1n)).toEqual({ ok: false, reason: 'over_tier_cap', tier: null })
  })

  it('accepts lowercase and correct checksum, returns the checksummed form', () => {
    const real = '0xabCDeF0123456789AbcdEf0123456789aBCDEF01'
    expect(checksumFunderAddress(real)).toEqual({ ok: true, address: real })
    const c = checksumFunderAddress(real.toLowerCase())
    expect(c).toEqual({ ok: true, address: real })
    const env = { ...TIER_ENV, FUNDER_T2_ADDRESS: real.toLowerCase() }
    const r = resolveFunder(env, 'coinbase', USD(10))
    expect(r.ok && r.address).toBe((c as any).address)
  })

  const refusals: Array<[string, Record<string, string | undefined>, string]> = [
    ['missing', { FUNDER_T2_ADDRESS: undefined }, 'tier_address_missing'],
    ['empty', { FUNDER_T2_ADDRESS: '' }, 'tier_address_missing'],
    ['placeholder', { FUNDER_T2_ADDRESS: 'TODO' }, 'tier_address_invalid'],
    ['short hex', { FUNDER_T2_ADDRESS: '0x1234' }, 'tier_address_invalid'],
    ['bad checksum', { FUNDER_T2_ADDRESS: '0xAbCDeF0123456789AbcdEf0123456789aBCDEF01' }, 'tier_address_invalid'],
    ['zero', { FUNDER_T2_ADDRESS: '0x0000000000000000000000000000000000000000' }, 'tier_address_zero'],
    ['retired funder', { FUNDER_T2_ADDRESS: RETIRED_FUNDER_ADDRESS_20261124 }, 'tier_address_retired'],
    ['retired funder lowercase', { FUNDER_T2_ADDRESS: RETIRED_FUNDER_ADDRESS_20261124.toLowerCase() }, 'tier_address_retired'],
    ['legacy funder', { FUNDER_T2_ADDRESS: BASE_FUNDER_ADDRESS }, 'tier_address_legacy'],
    ['blocklisted', { FUNDER_T2_ADDRESS: '0x235248a78985cb2166c2d5b43d527ea09fc31739' }, 'tier_address_blocked'],
    ['USDC contract', { FUNDER_T2_ADDRESS: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }, 'tier_address_blocked'],
    ['same as T3A', { FUNDER_T2_ADDRESS: T3A }, 'tier_address_duplicate'],
    ['same as T1 different case', { FUNDER_T1_ADDRESS: T2.toUpperCase().replace('0X', '0x') }, 'tier_address_duplicate'],
  ]
  for (const [name, over, reason] of refusals) {
    it(`refuses a ${name} T2 address (${reason})`, () => {
      const env = { ...TIER_ENV, ...over }
      expect(resolveFunder(env, 'coinbase', USD(10))).toEqual({ ok: false, reason, tier: 'T2' })
    })
  }

  it('every blocklisted EVM address is refused as a tier address', () => {
    for (const a of EVM_BLOCKED_ADDRESSES) {
      const r = funderTierAddress({ ...TIER_ENV, FUNDER_T3B_ADDRESS: a }, 'T3B')
      expect(r.ok, a).toBe(false)
    }
  })

  it('a broken tier only affects its own kind (no fallback, no cross-tier effect)', () => {
    const env = { ...TIER_ENV, FUNDER_T3A_ADDRESS: 'nope' }
    expect(resolveFunder(env, 'coinbase', USD(250))).toEqual({ ok: false, reason: 'tier_address_invalid', tier: 'T3A' })
    expect(resolveFunder(env, 'coinbase', USD(50))).toMatchObject({ ok: true, address: T2 })
  })

  it('configuredFunderWallets lists all four tiers, gaps with a reason', () => {
    expect(configuredFunderWallets(TIER_ENV)).toEqual([
      { tier: 'T1', address: T1 },
      { tier: 'T2', address: T2 },
      { tier: 'T3A', address: T3A },
      { tier: 'T3B', address: T3B },
    ])
    expect(configuredFunderWallets({ ...TIER_ENV, FUNDER_T1_ADDRESS: undefined })[0]).toEqual({
      tier: 'T1', address: null, reason: 'tier_address_missing',
    })
    expect(isAnyConfiguredFunderTier(TIER_ENV, T3B.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isAnyConfiguredFunderTier(TIER_ENV, BASE_FUNDER_ADDRESS)).toBe(false)
  })
})

describe('phase 2a: FUNDER_T3_BACKEND=legacy', () => {
  const P2A = { FUNDER_TIERS_ENABLED: 'true', FUNDER_T1_ADDRESS: T1, FUNDER_T2_ADDRESS: T2, FUNDER_T3_BACKEND: 'legacy' }

  it('servedByLegacyFunder matches every legacy vector', () => {
    expect((vectors as any).legacy.length).toBeGreaterThan(5)
    for (const v of (vectors as any).legacy) {
      expect(servedByLegacyFunder(v.tier, v.backend ?? undefined), JSON.stringify(v)).toBe(v.legacy)
    }
  })

  it('every vector: coinbase/stripe/bitrefill/other -> T2 wallet or legacy funder, x402 -> T1, refusals unchanged', () => {
    for (const v of vectors.vectors) {
      const got = resolveFunder(P2A, v.kind, BigInt(v.amount))
      const label = `${v.kind} ${v.amount}`
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice(7), tier: null })
        continue
      }
      const want = v.expect === 'T1' ? T1 : v.expect === 'T2' ? T2 : BASE_FUNDER_ADDRESS
      const tier = v.expect === 'T1' || v.expect === 'T2' ? v.expect : 'legacy'
      expect(got, label).toEqual({ ok: true, tier, address: want, expectedFunder: want })
      if (v.kind === 'x402') expect(want).toBe(T1)
    }
  })

  it('T3A / T3B addresses are not required; T1 / T2 still may not be the legacy funder', () => {
    expect(resolveFunder(P2A, 'coinbase', USD(200))).toMatchObject({ ok: true, address: BASE_FUNDER_ADDRESS })
    expect(resolveFunder(P2A, 'stripe', USD(10))).toMatchObject({ ok: true, address: BASE_FUNDER_ADDRESS })
    expect(resolveFunder({ ...P2A, FUNDER_T2_ADDRESS: BASE_FUNDER_ADDRESS }, 'coinbase', USD(10))).toEqual({
      ok: false, reason: 'tier_address_legacy', tier: 'T2',
    })
    expect(resolveFunder({ ...P2A, FUNDER_T1_ADDRESS: BASE_FUNDER_ADDRESS }, 'x402', 1n)).toEqual({
      ok: false, reason: 'tier_address_legacy', tier: 'T1',
    })
  })

  it('routeFunder matches every route vector, and resolveFunder agrees', () => {
    const route = (vectors as any).route as Array<{ kind: string; amount: string; backend: string | null; expect: string }>
    expect(route.length).toBeGreaterThan(10)
    for (const v of route) {
      const backend = v.backend ?? undefined
      const got = routeFunder(v.kind, BigInt(v.amount), backend)
      const label = `${v.kind} ${v.amount} ${v.backend}`
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice(7) })
      } else {
        expect(got, label).toEqual({ ok: true, wallet: v.expect })
      }
      const env = { ...TIER_ENV, FUNDER_T3_BACKEND: backend }
      const r = resolveFunder(env, v.kind, BigInt(v.amount))
      if (v.expect.startsWith('refuse:')) expect(r.ok, label).toBe(false)
      else expect(r.ok && r.address, label).toBe(v.expect === 'LEGACY' ? BASE_FUNDER_ADDRESS : ADDR[v.expect])
    }
  })

  it('alpha: $20 and $900 -> legacy in 2a; non-alpha Coinbase $20 -> T2; alpha paused when the backend is not legacy', () => {
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(20))).toEqual({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS })
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(900))).toMatchObject({ ok: true, address: BASE_FUNDER_ADDRESS })
    expect(resolveFunder(P2A, 'coinbase', USD(20))).toMatchObject({ ok: true, address: T2 })
    expect(resolveFunder({ ...TIER_ENV, FUNDER_T3_BACKEND: 'isolated' }, 'tron_ton_alpha', USD(20))).toEqual({ ok: false, reason: 'alpha_paused', tier: null })
    expect(resolveFunder(TIER_ENV, 'tron_ton_alpha', USD(20))).toEqual({ ok: false, reason: 'alpha_paused', tier: null })
    // Flag off: legacy as always.
    expect(resolveFunder({}, 'tron_ton_alpha', USD(20))).toMatchObject({ ok: true, tier: 'legacy', expectedFunder: undefined })
  })

  it('isTronTonAlphaOrder / coinbaseOrderKind read the creator marker', () => {
    expect(coinbaseOrderKind({ metadata: { source: 'mpprouter-tron-ton-alpha' } })).toBe('tron_ton_alpha')
    expect(coinbaseOrderKind({ metadata: JSON.stringify({ source: 'mpprouter-tron-ton-alpha' }) })).toBe('tron_ton_alpha')
    expect(coinbaseOrderKind({ metadata: { source: 'mpprouter-create-invoice' } })).toBe('coinbase')
    expect(coinbaseOrderKind(null)).toBe('coinbase')
  })

  it('a leftover T3 address equal to T2 does not block T2 in phase 2a (still does in 2b)', () => {
    expect(resolveFunder({ ...P2A, FUNDER_T3A_ADDRESS: T2 }, 'coinbase', USD(10))).toMatchObject({ ok: true, address: T2 })
    expect(resolveFunder({ ...P2A, FUNDER_T3_BACKEND: undefined, FUNDER_T3A_ADDRESS: T2 }, 'coinbase', USD(10))).toEqual({
      ok: false, reason: 'tier_address_duplicate', tier: 'T2',
    })
  })

  it('any other backend value keeps T3 tier wallets (and their checks)', () => {
    for (const b of ['LEGACY', ' legacy', 'cdp', '']) {
      expect(resolveFunder({ ...P2A, FUNDER_T3_BACKEND: b }, 'coinbase', USD(200))).toEqual({
        ok: false, reason: 'tier_address_missing', tier: 'T3A',
      })
    }
  })

  it('backend legacy without the flag is still the plain legacy funder', () => {
    expect(resolveFunder({ FUNDER_T3_BACKEND: 'legacy' }, 'coinbase', USD(10))).toEqual({
      ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: undefined,
    })
  })

  it('watch list: T1, T2 and the legacy funder once', () => {
    expect(configuredFunderWallets(P2A)).toEqual([
      { tier: 'T1', address: T1 },
      { tier: 'T2', address: T2 },
      { tier: 'legacy', address: BASE_FUNDER_ADDRESS },
    ])
  })
})

describe('shared blocklist refactor', () => {
  it('the Bitrefill blocklist is the shared list plus the retired funder (same 18 entries)', () => {
    expect(BITREFILL_BLOCKED_RECEIVERS.size).toBe(18)
    for (const a of EVM_BLOCKED_ADDRESSES) expect(BITREFILL_BLOCKED_RECEIVERS.has(a)).toBe(true)
    expect(BITREFILL_BLOCKED_RECEIVERS.has(RETIRED_FUNDER_ADDRESS_20261124.toLowerCase())).toBe(true)
  })
})
