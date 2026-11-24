/**
 * Tiered funder wallets: the mirrored selector against the shared vectors, and
 * the FUNDER_TIERS_ENABLED resolver in src/funder-address.ts.
 */
import { describe, expect, it } from 'vitest'
import vectors from '../src/funder-tier-vectors.json'
import {
  DEFAULT_ORDER_CAP_ATOMIC,
  orderCapAtomicFromUsd,
  parseUsdcAtomic,
  payFromReceivingWallet,
  routeFunder,
  routeNoOrderFunder,
  selectFunderTier,
  servedByLegacyFunder,
} from '../src/funder-tiers'
import { ORDER_CAP_USD } from '../src/routes/native-sources'
import {
  coinbaseOrderKind,
  BASE_FUNDER_ADDRESS,
  FUNDER_ORDER_CAP_ATOMIC,
  RETIRED_FUNDER_ADDRESS_20261124,
  checksumFunderAddress,
  configuredFunderWallets,
  funderTierAddress,
  funderTiersEnabled,
  isAnyConfiguredFunderTier,
  resolveFunder,
  resolveNoOrderFunder,
  resolvePayingFunder,
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

type Vec = { kind: string; amount: string; expect: string; band?: string; cap?: string }
const VECS = (vectors as any).vectors as Vec[]
const TEST_CAP = BigInt((vectors as any).testCap)
const capOf = (v: { cap?: string }) => (v.cap === undefined ? TEST_CAP : BigInt(v.cap))
/**
 * Rows checked through resolveFunder, whose cap is the live ORDER_CAP_USD
 * (FUNDER_ORDER_CAP_ATOMIC): only rows whose cap equals it. Raising the live
 * cap later just skips the testCap rows here; the pure selector tests above
 * keep covering every row with its own cap.
 */
const LIVE_CAP_VECS = VECS.filter((v) => capOf(v) === FUNDER_ORDER_CAP_ATOMIC)

describe('mirrored selector vs shared vectors', () => {
  it('selectFunderTier (band only) and routeFunder (band + the row cap) match every vector', () => {
    expect(VECS.length).toBeGreaterThan(10)
    for (const v of VECS) {
      const band = v.band ?? v.expect
      const got = selectFunderTier(v.kind, BigInt(v.amount))
      const label = `${v.kind} ${v.amount} cap ${v.cap ?? 'test'}`
      if (band.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: band.slice('refuse:'.length) })
      } else {
        expect(got, label).toEqual({ ok: true, tier: band })
      }
      const r = routeFunder(v.kind, BigInt(v.amount), 'isolated', capOf(v))
      expect(r.ok ? r.wallet : `refuse:${r.reason}`, label).toBe(v.expect)
    }
  })

  it('order cap setting: one source (ORDER_CAP_USD), garbage fails closed to $1,200, bands never move', () => {
    expect(FUNDER_ORDER_CAP_ATOMIC).toBe(orderCapAtomicFromUsd(ORDER_CAP_USD))
    for (const c of (vectors as any).capParse as Array<{ in: unknown; out: string }>) {
      expect(orderCapAtomicFromUsd(c.in).toString(), JSON.stringify(c.in)).toBe(c.out)
    }
    expect(DEFAULT_ORDER_CAP_ATOMIC).toBe(1_200_000_000n)
    // Cap 10,000: $5,000 Coinbase -> T3A, $199.99 -> T2 (bands unchanged).
    expect(routeFunder('coinbase', USD(5000), 'isolated', USD(10000))).toEqual({ ok: true, wallet: 'T3A' })
    expect(routeFunder('coinbase', USD(199.99), 'isolated', USD(10000))).toEqual({ ok: true, wallet: 'T2' })
    // Cap 1,200: $1,200.01 refused with the distinct cap reason.
    expect(routeFunder('coinbase', USD(1200.01), 'isolated', USD(1200))).toEqual({ ok: false, reason: 'over_order_cap' })
    // A non-positive cap is the $1,200 default, never "no cap".
    expect(routeFunder('coinbase', USD(1200.01), 'isolated', 0n)).toEqual({ ok: false, reason: 'over_order_cap' })
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
    expect(LIVE_CAP_VECS.length).toBeGreaterThan(10)
    for (const v of LIVE_CAP_VECS) {
      const got = resolveFunder(TIER_ENV, v.kind, BigInt(v.amount))
      const label = `${v.kind} ${v.amount}`
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice(7), tier: null })
      } else if (v.expect === 'LEGACY') {
        expect(got, label).toEqual({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS })
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

  it('configuredFunderWallets lists all four tiers, gaps with a reason, and the legacy funder (phase 2b drain)', () => {
    expect(configuredFunderWallets(TIER_ENV)).toEqual([
      { tier: 'T1', address: T1 },
      { tier: 'T2', address: T2 },
      { tier: 'T3A', address: T3A },
      { tier: 'T3B', address: T3B },
      // Still pays legacy-destination orders and no-order T3-sized payments: watched.
      { tier: 'legacy', address: BASE_FUNDER_ADDRESS },
    ])
    expect(configuredFunderWallets({ ...TIER_ENV, FUNDER_T1_ADDRESS: undefined })[0]).toEqual({
      tier: 'T1', address: null, reason: 'tier_address_missing',
    })
    expect(isAnyConfiguredFunderTier(TIER_ENV, T3B.toUpperCase().replace('0X', '0x'))).toBe(true)
    // The legacy funder is a funder wallet too: never a Bitrefill receiver.
    expect(isAnyConfiguredFunderTier(TIER_ENV, BASE_FUNDER_ADDRESS)).toBe(true)
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
    for (const v of LIVE_CAP_VECS) {
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
    const route = (vectors as any).route as Array<{ kind: string; amount: string; backend: string | null; expect: string; cap?: string }>
    expect(route.length).toBeGreaterThan(10)
    for (const v of route) {
      const backend = v.backend ?? undefined
      const got = routeFunder(v.kind, BigInt(v.amount), backend, capOf(v))
      const label = `${v.kind} ${v.amount} ${v.backend}`
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice(7) })
      } else {
        expect(got, label).toEqual({ ok: true, wallet: v.expect })
      }
      // resolveFunder uses the live cap; only rows at that cap are comparable.
      if (capOf(v) !== FUNDER_ORDER_CAP_ATOMIC) continue
      const env = { ...TIER_ENV, FUNDER_T3_BACKEND: backend }
      const r = resolveFunder(env, v.kind, BigInt(v.amount))
      if (v.expect.startsWith('refuse:')) expect(r.ok, label).toBe(false)
      else expect(r.ok && r.address, label).toBe(v.expect === 'LEGACY' ? BASE_FUNDER_ADDRESS : ADDR[v.expect])
    }
  })

  it('alpha (new order) in 2a: below $200 -> T2, $200 to $1,200 -> legacy, above refused; 2b: like Coinbase (T3A from $200)', () => {
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(20))).toEqual({ ok: true, tier: 'T2', address: T2, expectedFunder: T2 })
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(199.99))).toEqual({ ok: true, tier: 'T2', address: T2, expectedFunder: T2 })
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(200))).toEqual({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS })
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(900))).toMatchObject({ ok: true, address: BASE_FUNDER_ADDRESS })
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(1200))).toMatchObject({ ok: true, address: BASE_FUNDER_ADDRESS })
    expect(resolveFunder(P2A, 'tron_ton_alpha', USD(1200) + 1n)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    // T2 not configured: an alpha order below $200 is refused (no fallback to legacy).
    expect(resolveFunder({ ...P2A, FUNDER_T2_ADDRESS: undefined }, 'tron_ton_alpha', USD(20))).toEqual({ ok: false, reason: 'tier_address_missing', tier: 'T2' })
    expect(resolveFunder(P2A, 'coinbase', USD(20))).toMatchObject({ ok: true, address: T2 })
    const ISO2B = { ...TIER_ENV, FUNDER_T3_BACKEND: 'isolated' }
    expect(resolveFunder(ISO2B, 'tron_ton_alpha', USD(20))).toEqual({ ok: true, tier: 'T2', address: T2, expectedFunder: T2 })
    expect(resolveFunder(ISO2B, 'tron_ton_alpha', USD(200))).toEqual({ ok: true, tier: 'T3A', address: T3A, expectedFunder: T3A })
    expect(resolveFunder(ISO2B, 'tron_ton_alpha', USD(1200))).toMatchObject({ ok: true, address: T3A })
    expect(resolveFunder(ISO2B, 'tron_ton_alpha', USD(1200) + 1n)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    expect(resolveFunder({ ...ISO2B, FUNDER_T3A_ADDRESS: undefined }, 'tron_ton_alpha', USD(300))).toEqual({ ok: false, reason: 'tier_address_missing', tier: 'T3A' })
    expect(resolveFunder(TIER_ENV, 'tron_ton_alpha', USD(20))).toMatchObject({ ok: true, address: T2 })
    // Flag off: legacy as always.
    expect(resolveFunder({}, 'tron_ton_alpha', USD(20))).toEqual({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: undefined })
    expect(resolveFunder({ FUNDER_T2_ADDRESS: T2, FUNDER_T3_BACKEND: 'legacy' }, 'tron_ton_alpha', USD(20))).toEqual({
      ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: undefined,
    })
  })

  it('alpha (order already created): paid by the recorded destination, never the amount (in-flight legacy orders)', () => {
    // Created before the T2 rule: legacy destination below $200 -> legacy pays, warning only.
    for (const amt of [USD(20), USD(199.99)]) {
      const r = resolvePayingFunder(P2A, 'tron_ton_alpha', amt, BASE_FUNDER_ADDRESS.toLowerCase())
      expect(r).toMatchObject({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS, nominal: 'T2' })
      expect(r.ok && typeof r.warning).toBe('string')
    }
    // Created after it: T2 destination, no warning.
    expect(resolvePayingFunder(P2A, 'tron_ton_alpha', USD(199.99), T2)).toEqual({
      ok: true, tier: 'T2', address: T2, expectedFunder: T2, nominal: 'T2', warning: null,
    })
    // $200 and $1,200 on legacy: no warning. Above the cap: refused.
    expect(resolvePayingFunder(P2A, 'tron_ton_alpha', USD(200), BASE_FUNDER_ADDRESS)).toMatchObject({ ok: true, tier: 'legacy', warning: null })
    expect(resolvePayingFunder(P2A, 'tron_ton_alpha', USD(1200), BASE_FUNDER_ADDRESS)).toMatchObject({ ok: true, tier: 'legacy', warning: null })
    expect(resolvePayingFunder(P2A, 'tron_ton_alpha', USD(1200) + 1n, BASE_FUNDER_ADDRESS)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
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

describe('paying from the receiving wallet', () => {
  it('payFromReceivingWallet matches every pay vector', () => {
    const pay = (vectors as any).pay as Array<{ kind: string; amount: string; wallet: string; backend: string | null; expect: string; warn?: boolean; cap?: string }>
    expect(pay.length).toBeGreaterThan(10)
    for (const v of pay) {
      const got = payFromReceivingWallet(v.kind, BigInt(v.amount), v.wallet as any, v.backend ?? undefined, capOf(v))
      const label = JSON.stringify(v)
      if (v.expect.startsWith('refuse:')) {
        expect(got, label).toEqual({ ok: false, reason: v.expect.slice(7) })
      } else {
        expect(got.ok, label).toBe(true)
        expect(got.ok && got.wallet, label).toBe(v.expect)
        expect(got.ok && got.warning !== null, label).toBe(v.warn === true)
      }
    }
  })

  const ISO = { ...TIER_ENV, FUNDER_T3_BACKEND: 'isolated' }
  const P2A = { FUNDER_TIERS_ENABLED: 'true', FUNDER_T1_ADDRESS: T1, FUNDER_T2_ADDRESS: T2, FUNDER_T3_BACKEND: 'legacy' }

  it('flag off: always the legacy funder, receiver ignored', () => {
    expect(resolvePayingFunder({}, 'coinbase', USD(230), T2)).toEqual({
      ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: undefined, nominal: null, warning: null,
    })
  })

  it('T2 destination + $230 -> T2 with a warning; T3A destination + $50 -> T3A', () => {
    const a = resolvePayingFunder(ISO, 'coinbase', USD(230), T2.toLowerCase())
    expect(a).toMatchObject({ ok: true, tier: 'T2', address: T2, expectedFunder: T2, nominal: 'T3A' })
    expect(a.ok && a.warning).toMatch(/amount_outside_nominal_range/)
    const b = resolvePayingFunder(ISO, 'coinbase', USD(50), T3A)
    expect(b).toMatchObject({ ok: true, tier: 'T3A', address: T3A, nominal: 'T2' })
  })

  it('the legacy funder is a paying wallet in 2a and, for orders created before the switch, in 2b (drain)', () => {
    expect(resolvePayingFunder(P2A, 'coinbase', USD(50), BASE_FUNDER_ADDRESS)).toMatchObject({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, nominal: 'T2' })
    for (const kind of ['coinbase', 'stripe', 'bitrefill', 'tron_ton_alpha']) {
      for (const amt of [USD(50), USD(250), USD(1200)]) {
        const r = resolvePayingFunder(ISO, kind, amt, BASE_FUNDER_ADDRESS)
        expect(r, `${kind} ${amt}`).toMatchObject({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS })
        // 2b routes a NEW order to legacy only for Stripe (Permit): a warning for every other kind.
        expect(r.ok && (kind === 'stripe' ? r.warning === null : typeof r.warning === 'string'), `${kind} ${amt}`).toBe(true)
      }
    }
    expect(resolvePayingFunder(ISO, 'coinbase', USD(1200) + 1n, BASE_FUNDER_ADDRESS)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    // 2b never routes a NEW Coinbase / Bitrefill / alpha order to the legacy funder (Stripe: below).
    for (const kind of ['coinbase', 'bitrefill', 'tron_ton_alpha']) {
      for (const amt of [USD(50), USD(250), USD(1200)]) {
        const n = resolveFunder(ISO, kind, amt)
        expect(n.ok && n.address !== BASE_FUNDER_ADDRESS, `${kind} ${amt}`).toBe(true)
      }
    }
    // Stripe stays on the legacy funder on every backend (the KMS T3B signs no EIP-2612 Permit).
    expect(resolveFunder(ISO, 'stripe', USD(50))).toEqual({ ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS })
    // A T3 address left over in 2a is not a paying wallet (T3 is the legacy funder).
    expect(resolvePayingFunder({ ...P2A, FUNDER_T3A_ADDRESS: T3A }, 'coinbase', USD(300), T3A)).toEqual({ ok: false, reason: 'receiver_not_tier_wallet', tier: null })
  })

  it('hard refusals: non-tier / retired / blocklisted / missing destination, T1 for order money, x402 not T1, over the cap', () => {
    for (const r of ['0x9999999999999999999999999999999999999999', RETIRED_FUNDER_ADDRESS_20261124, '0x235248a78985cb2166c2d5b43d527ea09fc31739', undefined, '', 'nope']) {
      expect(resolvePayingFunder(ISO, 'coinbase', USD(50), r).ok, String(r)).toBe(false)
    }
    expect(resolvePayingFunder(ISO, 'coinbase', USD(1), T1)).toEqual({ ok: false, reason: 'wrong_wallet_for_kind', tier: null })
    expect(resolvePayingFunder(ISO, 'x402', USD(1), T2)).toEqual({ ok: false, reason: 'wrong_wallet_for_kind', tier: null })
    expect(resolvePayingFunder(ISO, 'coinbase', USD(1200) + 1n, T3A)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    expect(resolvePayingFunder({ ...ISO, FUNDER_T3A_ADDRESS: undefined }, 'coinbase', USD(300), T3A)).toEqual({ ok: false, reason: 'receiver_not_tier_wallet', tier: null })
  })
})

describe('payments with no intents order (coupon, UPI, admin pay)', () => {
  it('mirrored noOrder vectors', () => {
    for (const v of (vectors as any).noOrder as Array<{ kind: string; amount: string; backend: string | null; expect: string; cap?: string }>) {
      const r = routeNoOrderFunder(v.kind, BigInt(v.amount), v.backend ?? undefined, v.cap === undefined ? TEST_CAP : BigInt(v.cap))
      expect(r.ok ? r.wallet : `refuse:${r.reason}`, JSON.stringify(v)).toBe(v.expect)
    }
  })

  it('resolveNoOrderFunder: 2b T3-sized -> legacy funder (KMS T3 needs an order); T2 unchanged; 2a and flag off = resolveFunder', () => {
    const ISO = { ...TIER_ENV, FUNDER_T3_BACKEND: 'isolated' }
    const LEG = { ok: true, tier: 'legacy', address: BASE_FUNDER_ADDRESS, expectedFunder: BASE_FUNDER_ADDRESS }
    expect(resolveNoOrderFunder(ISO, 'coinbase', USD(250))).toEqual(LEG)
    expect(resolveNoOrderFunder(ISO, 'stripe', USD(20))).toEqual(LEG)
    expect(resolveNoOrderFunder(ISO, 'coinbase', USD(20))).toEqual({ ok: true, tier: 'T2', address: T2, expectedFunder: T2 })
    expect(resolveNoOrderFunder(ISO, 'coinbase', USD(1200) + 1n)).toEqual({ ok: false, reason: 'over_order_cap', tier: null })
    // The T3 addresses are not needed for no-order payments.
    expect(resolveNoOrderFunder({ ...ISO, FUNDER_T3A_ADDRESS: undefined }, 'coinbase', USD(250))).toEqual(LEG)
    const P2A = { ...TIER_ENV, FUNDER_T3_BACKEND: 'legacy' }
    for (const [k, a] of [['coinbase', USD(250)], ['coinbase', USD(20)], ['stripe', USD(20)]] as const) {
      expect(resolveNoOrderFunder(P2A, k, a)).toEqual(resolveFunder(P2A, k, a))
      expect(resolveNoOrderFunder({}, k, a)).toEqual(resolveFunder({}, k, a))
    }
  })
})

describe('shared blocklist refactor', () => {
  it('the Bitrefill blocklist is the shared list plus the retired funder (same 18 entries)', () => {
    expect(BITREFILL_BLOCKED_RECEIVERS.size).toBe(18)
    for (const a of EVM_BLOCKED_ADDRESSES) expect(BITREFILL_BLOCKED_RECEIVERS.has(a)).toBe(true)
    expect(BITREFILL_BLOCKED_RECEIVERS.has(RETIRED_FUNDER_ADDRESS_20261124.toLowerCase())).toBe(true)
  })
})
