/**
 * Authentication of a channel registration as `from` (mpp-spec §3.4,
 * registration check 6): "Without this anyone can bind a channel whose
 * identifiers are public, grief the real agent, and leave its deposit locked
 * for a window."
 *
 * The funder proves control of `from` by signing a domain-separated message
 * over the exact registration tuple with the account's own ed25519 key. The
 * message binds every field the router acts on, so a signature captured from
 * one registration cannot be spliced onto another channel, commitment key or
 * salt. Replaying an identical signed body only re-registers the same channel
 * with the same parameters, which register already treats as idempotent.
 *
 * Two encodings are accepted, both over the same message:
 *   1. raw ed25519 over the UTF-8 message bytes (`Keypair.sign(message)`), the
 *      simplest thing a CLI agent can do;
 *   2. SEP-53 signed message (`sha256("Stellar Signed Message:\n" + message)`),
 *      which is what browser wallets such as Freighter produce from
 *      `signMessage`, so the playground frontend can adopt the spec body
 *      without a raw-key signing path.
 *
 * Pure functions, no I/O.
 */

import { Keypair, hash } from '@stellar/stellar-sdk'

export const CHANNEL_REGISTER_DOMAIN = 'mpprouter.channel-register.v1'

const SEP53_PREFIX = 'Stellar Signed Message:\n'

export interface RegisterTuple {
  channel: string
  commitmentKey: string
  /** Lowercase hex, no 0x prefix — exactly as canonicalized by the router. */
  saltHex: string
  from: string
}

/** The exact text the funder signs. Newline-joined so no field can run into the next. */
export function channelRegisterMessage(t: RegisterTuple): string {
  return [CHANNEL_REGISTER_DOMAIN, t.channel, t.commitmentKey, t.saltHex.toLowerCase(), t.from].join('\n')
}

/**
 * True iff `signatureB64` is `from`'s ed25519 signature over the register
 * message, in either accepted encoding. Never throws on malformed input.
 */
export function verifyChannelRegisterSignature(t: RegisterTuple, signatureB64: string): boolean {
  let sig: Buffer
  let kp: Keypair
  try {
    sig = Buffer.from(signatureB64, 'base64')
    kp = Keypair.fromPublicKey(t.from)
  } catch {
    return false
  }
  if (sig.length !== 64) return false
  const message = Buffer.from(channelRegisterMessage(t), 'utf8')
  try {
    if (kp.verify(message, sig)) return true
    const sep53 = hash(Buffer.concat([Buffer.from(SEP53_PREFIX, 'utf8'), message]))
    return kp.verify(sep53, sig)
  } catch {
    return false
  }
}

/** Client-side helper (tests, scripts): raw-ed25519 signature, base64. */
export function signChannelRegister(t: RegisterTuple, funder: Keypair): string {
  return funder.sign(Buffer.from(channelRegisterMessage(t), 'utf8')).toString('base64')
}
