/**
 * Wallet-signature authentication for provider registration.
 *
 * ## Why a signature and not just a form field
 *
 * A payout address typed into a form is one wrong character away from a
 * stranger's wallet, and on the direct-settlement path we cannot fix that
 * afterwards — the funds never pass through us, so there is nothing to
 * claw back and nobody to ask. The provider would be told their integration
 * works, calls would succeed, and the money would land somewhere else,
 * forever, silently.
 *
 * A signature removes the failure mode rather than mitigating it: an
 * address that can sign is an address someone holds the key to, and it is
 * the same five seconds of work as pasting. Email stays on the record for
 * notifications and recovery, but it authorises nothing — an attacker with
 * the provider's inbox still cannot move their payouts.
 *
 * ## What the signature commits to
 *
 * Not a bare "I own this address" — that is replayable across every site
 * that ever asks for one. The signed message binds:
 *
 *   - this router (realm) and this purpose, so a signature collected by
 *     some other dapp cannot be presented here;
 *   - the provider id and the specific address/network being claimed;
 *   - a digest of the full registration payload, so the signature cannot
 *     be lifted onto a registration naming a different API origin, a
 *     different price, or a different second payout address;
 *   - an `issued_at` timestamp, checked against a short window;
 *   - a nonce, consumed once (`provider_nonce:*` in KV).
 *
 * Bind-the-payload is the part that is easy to leave out and expensive to
 * omit. Without it a provider who signs once has signed for every future
 * edit of their own record, which is the same authorisation hole as the
 * email.
 *
 * ## Chain coverage
 *
 * Stellar (ed25519 via the bundled stellar-sdk), EVM (EIP-191 via viem),
 * and Solana (ed25519 via WebCrypto). All three are already reachable from
 * this Worker's dependency set — none of this adds a package. A network we
 * cannot verify is REFUSED rather than accepted on trust: an unverifiable
 * payout address is exactly the hazard this file exists to remove.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { verifyMessage } from 'viem'
import type { Env } from '../index'

const NONCE_PREFIX = 'provider_nonce:'

/**
 * How long a signed registration stays valid.
 *
 * Long enough to sign in a wallet, read the confirmation and submit;
 * short enough that a signature captured from a user's clipboard or a
 * proxy log is dead before it is useful. The nonce is the real replay
 * guard; this bounds the window in which one must be remembered.
 */
const SIGNATURE_TTL_MS = 10 * 60_000

/** KV TTL on a consumed nonce. Must exceed SIGNATURE_TTL_MS. */
const NONCE_TTL_SECONDS = 3600

export const SIGNATURE_REALM = 'apiserver.mpprouter.dev'

export class ProviderAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ProviderAuthError'
  }
}

/**
 * Canonical digest of the registration a signature commits to.
 *
 * Field order is fixed here rather than taken from the request's JSON key
 * order — two JSON encodings of the same registration must produce the
 * same digest, or a provider whose wallet re-serialises the message gets
 * an unexplainable rejection.
 */
export async function registrationDigest(input: {
  id: string
  name: string
  email: string
  apiBaseUrl: string
  payouts: Array<{ network: string; payTo: string; asset: string }>
  routes: Array<{ operation: string; method: string; upstreamPath: string; priceUsd: string }>
}): Promise<string> {
  const canonical = JSON.stringify({
    id: input.id,
    name: input.name,
    email: input.email,
    api_base_url: input.apiBaseUrl,
    payouts: [...input.payouts]
      .map(p => ({ network: p.network, pay_to: p.payTo, asset: p.asset }))
      .sort((a, b) => a.network.localeCompare(b.network)),
    routes: [...input.routes]
      .map(r => ({
        operation: r.operation,
        method: r.method,
        upstream_path: r.upstreamPath,
        price_usd: r.priceUsd,
      }))
      .sort((a, b) => a.operation.localeCompare(b.operation)),
  })
  const bytes = new TextEncoder().encode(canonical)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * The exact string the provider's wallet signs.
 *
 * Human-readable on purpose: every wallet shows this text to the person
 * approving it, and "sign this opaque hex" is how people are taught to
 * approve things they would not approve if they could read them.
 */
export function buildSignatureMessage(params: {
  providerId: string
  network: string
  address: string
  digest: string
  issuedAt: string
  nonce: string
}): string {
  return [
    `${SIGNATURE_REALM} wants you to prove you control this address.`,
    '',
    'Purpose: register as an MPP Router service provider and receive payments at this address.',
    `Provider: ${params.providerId}`,
    `Network: ${params.network}`,
    `Address: ${params.address}`,
    `Registration: ${params.digest}`,
    `Issued At: ${params.issuedAt}`,
    `Nonce: ${params.nonce}`,
  ].join('\n')
}

function assertFreshTimestamp(issuedAt: string): void {
  const t = Date.parse(issuedAt)
  if (!Number.isFinite(t)) {
    throw new ProviderAuthError('issued_at is not a valid ISO timestamp.', 'bad_timestamp')
  }
  const skew = Date.now() - t
  // Allow a minute of clock running fast; a signature dated the future by
  // more than that is either a broken clock or an attempt to mint one that
  // outlives the window.
  if (skew < -60_000) {
    throw new ProviderAuthError('issued_at is in the future.', 'bad_timestamp')
  }
  if (skew > SIGNATURE_TTL_MS) {
    throw new ProviderAuthError(
      `Signature expired (older than ${SIGNATURE_TTL_MS / 60_000} minutes). Sign again.`,
      'expired',
    )
  }
}

/**
 * Consume a nonce, refusing a second use.
 *
 * KV is eventually consistent, so two simultaneous submissions of the same
 * nonce can both pass — the same caveat the x402 replay guard documents.
 * It is not load-bearing here: replaying a registration signature can only
 * re-write the record the signature already authorised, byte for byte,
 * because the digest pins every field. There is no state a duplicate could
 * put us in that one submission does not.
 */
async function consumeNonce(env: Env, nonce: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
    throw new ProviderAuthError('nonce must be 8-64 URL-safe characters.', 'bad_nonce')
  }
  const key = NONCE_PREFIX + nonce
  const seen = await env.MPP_STORE.get(key)
  if (seen) {
    throw new ProviderAuthError('This nonce has already been used.', 'replay')
  }
  await env.MPP_STORE.put(key, '1', { expirationTtl: NONCE_TTL_SECONDS })
}

// ---------------------------------------------------------------------
// Per-chain verification
// ---------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Decode base58 (Bitcoin/Solana alphabet).
 *
 * Hand-rolled because no bundled dependency exposes one and the
 * alternative is adding a package to a Worker that already pins its
 * dependency set carefully. ~20 lines, no allocation surprises, and it
 * rejects rather than guesses on an out-of-alphabet character.
 */
function base58Decode(input: string): Uint8Array {
  if (input.length === 0 || input.length > 128) {
    throw new ProviderAuthError('Malformed base58 value.', 'bad_address')
  }
  const bytes: number[] = [0]
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value === -1) {
      throw new ProviderAuthError('Malformed base58 value.', 'bad_address')
    }
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  // Leading '1's are leading zero bytes.
  for (const char of input) {
    if (char !== '1') break
    bytes.push(0)
  }
  return new Uint8Array(bytes.reverse())
}

async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  // workerd exposes Ed25519 under the standard name; older runtimes used
  // the NODE-ED25519 alias. Try both rather than pinning to whichever this
  // deploy happens to have.
  for (const algorithm of ['Ed25519', 'NODE-ED25519'] as const) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        publicKey as unknown as BufferSource,
        { name: algorithm, namedCurve: 'Ed25519' } as any,
        false,
        ['verify'],
      )
      return await crypto.subtle.verify(
        { name: algorithm } as any,
        key,
        signature as unknown as BufferSource,
        message as unknown as BufferSource,
      )
    } catch {
      // Try the next alias.
    }
  }
  return false
}

/**
 * Does this network id name a chain we can verify a signature on?
 *
 * Registration refuses anything else. The alternative — accepting an
 * address on a chain we cannot check — reintroduces exactly the typo
 * hazard the signature exists to remove, on the chain where we would be
 * least able to notice.
 */
export function isSupportedPayoutNetwork(network: string): boolean {
  return (
    network.startsWith('stellar:') ||
    network.startsWith('eip155:') ||
    network.startsWith('solana:')
  )
}

/**
 * Verify one address-ownership signature.
 *
 * Returns nothing and throws `ProviderAuthError` on every failure —
 * a boolean return invites `if (verify(...))` with a missing `!`, and the
 * consequence of that mistake here is publishing an unproven payout
 * address.
 */
export async function verifyAddressSignature(params: {
  network: string
  address: string
  message: string
  /** base64 for stellar/solana, 0x-hex for EVM. */
  signature: string
}): Promise<void> {
  const { network, address, message, signature } = params
  const messageBytes = new TextEncoder().encode(message)

  if (network.startsWith('stellar:')) {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new ProviderAuthError('Not a valid Stellar public key (G…).', 'bad_address')
    }
    let ok = false
    try {
      ok = Keypair.fromPublicKey(address).verify(
        // stellar-sdk expects a Buffer-like; a Uint8Array satisfies it at
        // runtime and avoids pulling the Buffer shim into the Worker.
        messageBytes as unknown as Buffer,
        base64ToBytes(signature) as unknown as Buffer,
      )
    } catch {
      throw new ProviderAuthError('Malformed Stellar signature (expect base64).', 'bad_signature')
    }
    if (!ok) throw new ProviderAuthError('Stellar signature does not match address.', 'bad_signature')
    return
  }

  if (network.startsWith('eip155:')) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new ProviderAuthError('Not a valid EVM address.', 'bad_address')
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new ProviderAuthError('Malformed EVM signature (expect 0x + 130 hex).', 'bad_signature')
    }
    let ok = false
    try {
      ok = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      })
    } catch {
      throw new ProviderAuthError('EVM signature could not be recovered.', 'bad_signature')
    }
    if (!ok) throw new ProviderAuthError('EVM signature does not match address.', 'bad_signature')
    return
  }

  if (network.startsWith('solana:')) {
    const publicKey = base58Decode(address)
    if (publicKey.length !== 32) {
      throw new ProviderAuthError('Not a valid Solana address.', 'bad_address')
    }
    let signatureBytes: Uint8Array
    try {
      signatureBytes = base64ToBytes(signature)
    } catch {
      throw new ProviderAuthError('Malformed Solana signature (expect base64).', 'bad_signature')
    }
    const ok = await verifyEd25519(publicKey, messageBytes, signatureBytes)
    if (!ok) throw new ProviderAuthError('Solana signature does not match address.', 'bad_signature')
    return
  }

  throw new ProviderAuthError(
    `Cannot verify a signature on "${network}". Supported: stellar:*, eip155:*, solana:*.`,
    'unsupported_network',
  )
}

/**
 * Verify the whole registration: one signature per declared payout
 * address, all committing to the same registration digest.
 *
 * Requiring a signature per address rather than one for the set is the
 * difference between "this person controls these three addresses" and
 * "this person controls one address and typed two others" — and the second
 * reading is the one that loses somebody's money.
 *
 * Returns the owner key: the first signature's address/network, which
 * becomes the key authorised to make future changes to the record.
 */
export async function verifyRegistrationSignatures(
  env: Env,
  params: {
    providerId: string
    digest: string
    payouts: Array<{ network: string; payTo: string; asset: string }>
    signatures: unknown
  },
): Promise<{ ownerKey: { network: string; address: string }; issuedAt: string }> {
  const { providerId, digest, payouts, signatures } = params

  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new ProviderAuthError(
      'signatures[] is required — one per payout address.',
      'missing_signature',
    )
  }

  const byNetwork = new Map<string, { signature: string; issuedAt: string; nonce: string }>()
  for (const entry of signatures) {
    if (!entry || typeof entry !== 'object') {
      throw new ProviderAuthError('Each signature entry must be an object.', 'bad_signature')
    }
    const e = entry as Record<string, unknown>
    const network = String(e.network ?? '')
    if (byNetwork.has(network)) {
      throw new ProviderAuthError(`Two signatures for ${network}.`, 'bad_signature')
    }
    byNetwork.set(network, {
      signature: String(e.signature ?? ''),
      issuedAt: String(e.issued_at ?? ''),
      nonce: String(e.nonce ?? ''),
    })
  }

  let ownerKey: { network: string; address: string } | null = null
  let ownerIssuedAt = ''

  for (const payout of payouts) {
    if (!isSupportedPayoutNetwork(payout.network)) {
      throw new ProviderAuthError(
        `Cannot verify ownership of an address on "${payout.network}". Supported: stellar:*, eip155:*, solana:*.`,
        'unsupported_network',
      )
    }
    const sig = byNetwork.get(payout.network)
    if (!sig) {
      throw new ProviderAuthError(
        `Missing signature for the ${payout.network} payout address. Every payout address must be proven.`,
        'missing_signature',
      )
    }
    assertFreshTimestamp(sig.issuedAt)
    await consumeNonce(env, sig.nonce)
    const message = buildSignatureMessage({
      providerId,
      network: payout.network,
      address: payout.payTo,
      digest,
      issuedAt: sig.issuedAt,
      nonce: sig.nonce,
    })
    await verifyAddressSignature({
      network: payout.network,
      address: payout.payTo,
      message,
      signature: sig.signature,
    })
    if (!ownerKey) {
      ownerKey = { network: payout.network, address: payout.payTo }
      ownerIssuedAt = sig.issuedAt
    }
  }

  if (!ownerKey) {
    throw new ProviderAuthError('No payout address was proven.', 'missing_signature')
  }
  return { ownerKey, issuedAt: ownerIssuedAt }
}
