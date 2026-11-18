/**
 * Bech32 / bech32m decoding and segwit address validation (BIP173, BIP350).
 *
 * Small, dependency-free and pure. Used to verify the checksum of an on-chain
 * Bitcoin address before the router hands it to a payer: a regex alone lets a
 * one-character typo (or a tampered upstream answer) through.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_CONST = 1
const BECH32M_CONST = 0x2bc830a3

export type Bech32Encoding = 'bech32' | 'bech32m'

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i]
    }
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

/**
 * Decode a bech32 or bech32m string. Returns null on any violation of
 * BIP173: length over 90, characters outside 33..126, mixed case, missing
 * separator, empty HRP, data part shorter than the 6-char checksum, a
 * character outside the charset, or a checksum matching neither constant.
 */
export function bech32Decode(str: string): { hrp: string; data: number[]; encoding: Bech32Encoding } | null {
  if (typeof str !== 'string' || str.length > 90) return null
  let lower = false
  let upper = false
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 33 || c > 126) return null
    if (c >= 97 && c <= 122) lower = true
    if (c >= 65 && c <= 90) upper = true
  }
  if (lower && upper) return null
  const s = str.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length) return null
  const hrp = s.slice(0, pos)
  const data: number[] = []
  for (let i = pos + 1; i < s.length; i++) {
    const d = CHARSET.indexOf(s[i])
    if (d === -1) return null
    data.push(d)
  }
  const check = polymod([...hrpExpand(hrp), ...data])
  const encoding: Bech32Encoding | null =
    check === BECH32_CONST ? 'bech32' : check === BECH32M_CONST ? 'bech32m' : null
  if (!encoding) return null
  return { hrp, data: data.slice(0, -6), encoding }
}

/** Regroup 5-bit words into 8-bit bytes without padding (BIP173 convertbits). */
function fromWords(words: number[]): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const w of words) {
    acc = (acc << 5) | w
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
    acc &= (1 << bits) - 1
  }
  // Leftover bits must be fewer than 5 and all zero.
  if (bits >= 5 || acc !== 0) return null
  return out
}

/**
 * Decode a segwit address for the given HRP ("bc" = mainnet). Witness v0
 * must use bech32 with a 20 or 32 byte program; v1..v16 must use bech32m
 * with a 2..40 byte program (BIP350).
 */
export function decodeSegwitAddress(
  expectedHrp: string,
  addr: string,
): { version: number; program: number[] } | null {
  const dec = bech32Decode(addr)
  if (!dec || dec.hrp !== expectedHrp || dec.data.length < 1) return null
  const version = dec.data[0]
  if (version > 16) return null
  const program = fromWords(dec.data.slice(1))
  if (!program || program.length < 2 || program.length > 40) return null
  if (version === 0 && program.length !== 20 && program.length !== 32) return null
  if (version === 0 && dec.encoding !== 'bech32') return null
  if (version !== 0 && dec.encoding !== 'bech32m') return null
  return { version, program }
}
