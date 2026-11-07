import { describe, expect, it } from 'vitest'

import {
  filterPayableCandidates,
  parseTempoChallenges,
  parseTempoChallengesStrict,
  selectSessionChallenge,
  sessionChallengeMismatch,
  tokenSymbol,
} from '../src/mpp/tempo-challenges'

const USDC = '0x20c000000000000000000000b9537d11c60e8b50'
const OUSD = '0x20c0000000000000000000006a37DA5C996874BE'
const MACH = '0x20c0000000000000000000000000000000c032'
const PAYEE = '0xca4e835F803cB0b7C428222B3A3B98518d4779Fe'
const ESCROW = '0x4d50500000000000000000000000000000000000'

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function challenge(id: string, currency: string, extra: Record<string, unknown> = {}, intent = 'session'): string {
  const request = {
    amount: '1000',
    currency,
    recipient: PAYEE,
    decimals: 6,
    methodDetails: { escrowContract: ESCROW, chainId: 4217 },
    ...extra,
  }
  return `Payment id="${id}", realm="mpp.tempo.xyz", method="tempo", intent="${intent}", request="${b64url(request)}", expires="2099-01-01T00:00:00Z"`
}

const usdcChannel = { currency: USDC as `0x${string}`, payee: PAYEE as `0x${string}`, escrowContract: ESCROW as `0x${string}`, chainId: 4217 }
const ousdChannel = { ...usdcChannel, currency: OUSD as `0x${string}` }

describe('selectSessionChallenge', () => {
  const live = [challenge('a', OUSD), challenge('b', USDC), challenge('c', MACH)].join(', ')
  const reversed = [challenge('c', MACH), challenge('b', USDC), challenge('a', OUSD)].join(', ')

  it('parses every challenge in one header', () => {
    expect(parseTempoChallenges(live).map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  for (const [name, header] of [['live order', live], ['reversed order', reversed]] as const) {
    it(`picks the channel token, ${name}`, () => {
      const usdc = selectSessionChallenge(parseTempoChallenges(header), usdcChannel)
      const ousd = selectSessionChallenge(parseTempoChallenges(header), ousdChannel)
      expect(usdc.ok && usdc.challenge.id).toBe('b')
      expect(ousd.ok && ousd.challenge.id).toBe('a')
    })
  }

  it('refuses when the channel token is not offered', () => {
    const r = selectSessionChallenge(parseTempoChallenges(challenge('a', OUSD)), usdcChannel)
    expect(r).toEqual({ ok: false, reason: 'no_matching_challenge', offered: ['OUSD'] })
  })

  it('refuses a charge-only header', () => {
    const r = selectSessionChallenge(parseTempoChallenges(challenge('x', USDC, {}, 'charge')), usdcChannel)
    expect(r.ok).toBe(false)
  })

  it('splits a lower-case payment scheme like mppx does', () => {
    const header = `${challenge('a', OUSD)}, ${challenge('b', USDC).replace(/^Payment/, 'payment')}`
    const r = selectSessionChallenge(parseTempoChallenges(header), usdcChannel)
    expect(r.ok && r.challenge.id).toBe('b')
  })

  it('skips an unparseable challenge and still finds the good one', () => {
    const header = `Payment id="bad", request="%%%", ${challenge('b', USDC)}`
    const r = selectSessionChallenge(parseTempoChallenges(header), usdcChannel)
    expect(r.ok && r.challenge.id).toBe('b')
  })
})

describe('sessionChallengeMismatch', () => {
  const ok = { currency: USDC, recipient: PAYEE, decimals: 6, methodDetails: { escrowContract: ESCROW, chainId: 4217 } }

  it('accepts a full match, case-insensitive', () => {
    expect(sessionChallengeMismatch({ ...ok, currency: USDC.toUpperCase().replace('0X', '0x') }, usdcChannel)).toBeNull()
  })

  it('reads escrow and chain before mppx moves them into methodDetails', () => {
    expect(sessionChallengeMismatch({ currency: USDC, recipient: PAYEE, escrowContract: ESCROW, chainId: 4217 }, usdcChannel)).toBeNull()
  })

  it.each([
    ['currency', { ...ok, currency: OUSD }],
    ['payee', { ...ok, recipient: '0x0000000000000000000000000000000000000001' }],
    ['escrow', { ...ok, methodDetails: { escrowContract: '0x33b901018174DDabE4841042ab76ba85D4e24f25', chainId: 4217 } }],
    ['chain', { ...ok, methodDetails: { escrowContract: ESCROW, chainId: 1 } }],
    ['chain', { ...ok, methodDetails: { escrowContract: ESCROW } }],
    ['decimals', { ...ok, decimals: 18 }],
  ] as const)('flags %s', (field, request) => {
    expect(sessionChallengeMismatch(request as any, usdcChannel)).toBe(field)
  })
})

describe('filterPayableCandidates (mppx orderChallenges)', () => {
  const candidate = (currency: string) => ({
    challenge: { intent: 'session', request: { currency, recipient: PAYEE, methodDetails: { escrowContract: ESCROW, chainId: 4217 } } },
  })

  it('keeps only the channel token, whatever the order', () => {
    expect(filterPayableCandidates([candidate(OUSD), candidate(USDC)], usdcChannel)).toEqual([candidate(USDC)])
    expect(filterPayableCandidates([candidate(USDC), candidate(OUSD)], ousdChannel)).toEqual([candidate(OUSD)])
  })

  it('never keeps a charge candidate, even with matching fields', () => {
    const charge = { challenge: { ...candidate(USDC).challenge, intent: 'charge' } }
    expect(filterPayableCandidates([charge, candidate(USDC)], usdcChannel)).toEqual([candidate(USDC)])
  })

  it('returns nothing to sign when the token is absent', () => {
    expect(filterPayableCandidates([candidate(OUSD)], usdcChannel)).toEqual([])
  })
})

describe('tokenSymbol', () => {
  it('labels known tokens and shortens others', () => {
    expect(tokenSymbol(USDC)).toBe('USDC.e')
    expect(tokenSymbol(OUSD)).toBe('OUSD')
    expect(tokenSymbol(MACH)).toBe('0x20c0...c032')
  })
})

describe('parseTempoChallengesStrict (mppx parser)', () => {
  it('parses the live three-token header like the lenient parser', () => {
    const header = [challenge('a', OUSD), challenge('b', USDC), challenge('c', MACH)].join(', ')
    const strict = parseTempoChallengesStrict(header)
    expect(strict.map((c) => String(c.request.currency).toLowerCase())).toEqual([OUSD, USDC, MACH].map((x) => x.toLowerCase()))
    const r = selectSessionChallenge(strict, usdcChannel)
    expect(r.ok && String(r.challenge.request.currency).toLowerCase()).toBe(USDC)
  })

  it('throws on a malformed entry, so the proxy refuses before charging', () => {
    expect(() => parseTempoChallengesStrict(`Payment id="bad", request="%%%", ${challenge('b', USDC)}`)).toThrow()
  })
})
