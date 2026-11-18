/**
 * Bech32 / bech32m checksum and segwit address validation (BIP173, BIP350),
 * using the official test vectors, plus the router's on-chain BTC address
 * predicates built on top of it.
 */
import { describe, expect, it } from 'vitest'
import { bech32Decode, decodeSegwitAddress } from '../src/routes/bech32'
import { isBtcMainnetSegwitAddress, isBtcP2wpkhAddress } from '../src/routes/native-sources'

describe('bech32Decode: BIP173 string vectors', () => {
  it.each([
    'A12UEL5L',
    'a12uel5l',
    'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
    '11' + 'q'.repeat(82) + 'c8247j',
    '?1ezyfcl',
  ])('valid bech32: %s', (s) => {
    expect(bech32Decode(s)?.encoding).toBe('bech32')
  })

  it.each([
    ['pzry9x0s0muk', 'no separator'],
    ['1pzry9x0s0muk', 'empty HRP'],
    ['x1b4n0q5v', 'invalid data character'],
    ['li1dgmt3', 'too short checksum'],
    ['A1G7SGD8', 'checksum calculated with uppercase HRP'],
    ['10a06t8', 'empty HRP'],
    ['1qzzfhee', 'empty HRP'],
    ['\x201nwldj5', 'HRP character out of range'],
    ['an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx', 'overall max length exceeded'],
  ])('invalid: %s (%s)', (s) => {
    expect(bech32Decode(s)).toBeNull()
  })
})

describe('decodeSegwitAddress: BIP173 / BIP350 address vectors', () => {
  it.each([
    ['bc', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 0, 20],
    ['tb', 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 0, 32],
    ['bc', 'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 1, 40],
    ['bc', 'BC1SW50QGDZ25J', 16, 2],
    ['bc', 'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 2, 16],
    ['tb', 'tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy', 0, 32],
    ['tb', 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 1, 32],
    ['bc', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 1, 32],
  ])('valid (%s): %s', (hrp, addr, version, len) => {
    const d = decodeSegwitAddress(hrp, addr)
    expect(d).not.toBeNull()
    expect(d!.version).toBe(version)
    expect(d!.program.length).toBe(len)
  })

  it.each([
    ['tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', 'invalid HRP'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'invalid checksum'],
    ['BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2', 'invalid witness version'],
    ['bc1rw5uspcuh', 'invalid program length'],
    ['bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90', 'invalid program length'],
    ['BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', 'invalid program length for v0'],
    ['bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', 'zero padding of more than 4 bits'],
    ['bc1gmk9yu', 'empty data section'],
    // BIP350: wrong checksum constant for the witness version.
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut', 'v1 with bech32 checksum'],
    ['BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL', 'v16 with bech32 checksum'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'v0 with bech32m checksum'],
    ['bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', 'invalid character'],
    ['BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', 'witness version 17'],
    ['bc1pw5dgrnzv', 'program length 1'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', 'program length 41'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf', 'zero padding of more than 4 bits'],
  ])('invalid (bc): %s (%s)', (addr) => {
    expect(decodeSegwitAddress('bc', addr)).toBeNull()
  })

  it.each([
    ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7', 'mixed case'],
    ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv', 'non-zero padding'],
    ['tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', 'v0 with bech32m checksum'],
    ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', 'mixed case'],
    ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', 'non-zero padding'],
  ])('invalid (tb): %s (%s)', (addr) => {
    expect(decodeSegwitAddress('tb', addr)).toBeNull()
  })
})

describe('router BTC address predicates', () => {
  const GOOD = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

  it('isBtcP2wpkhAddress: the BIP173 P2WPKH vector passes', () => {
    expect(isBtcP2wpkhAddress(GOOD)).toBe(true)
  })

  it('isBtcP2wpkhAddress: a one-character checksum or payload error is refused', () => {
    expect(isBtcP2wpkhAddress(GOOD.slice(0, -1) + '5')).toBe(false)
    // Every single-character substitution with another charset character fails.
    const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    for (let i = 4; i < GOOD.length; i++) {
      const alt = charset[(charset.indexOf(GOOD[i]) + 1) % 32]
      const typo = GOOD.slice(0, i) + alt + GOOD.slice(i + 1)
      expect(isBtcP2wpkhAddress(typo)).toBe(false)
    }
  })

  it('isBtcP2wpkhAddress: shape-only fakes that passed the old regex are refused', () => {
    expect(isBtcP2wpkhAddress('bc1q' + 'q'.repeat(38))).toBe(false)
    expect(isBtcP2wpkhAddress('bc1q' + '0'.repeat(38))).toBe(false)
  })

  it('isBtcP2wpkhAddress: mixed case, uppercase and other networks are refused', () => {
    expect(isBtcP2wpkhAddress('bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false)
    expect(isBtcP2wpkhAddress(GOOD.toUpperCase())).toBe(false)
    expect(isBtcP2wpkhAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false)
    expect(isBtcP2wpkhAddress('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')).toBe(false) // P2WSH, 32 bytes
    expect(isBtcP2wpkhAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0')).toBe(false) // taproot
    expect(isBtcP2wpkhAddress(null)).toBe(false)
    expect(isBtcP2wpkhAddress(42)).toBe(false)
  })

  it('isBtcMainnetSegwitAddress: v0 and taproot pass, tb1 / mixed case / bad checksum fail', () => {
    expect(isBtcMainnetSegwitAddress(GOOD)).toBe(true)
    expect(isBtcMainnetSegwitAddress(GOOD.toUpperCase())).toBe(true)
    expect(isBtcMainnetSegwitAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0')).toBe(true)
    expect(isBtcMainnetSegwitAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7')).toBe(false)
    expect(isBtcMainnetSegwitAddress('bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false)
    expect(isBtcMainnetSegwitAddress(GOOD.slice(0, -1) + '5')).toBe(false)
  })
})
