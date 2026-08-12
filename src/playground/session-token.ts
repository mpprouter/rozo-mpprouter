/**
 * Playground session tokens: `base64url(payload).base64url(hmac)`.
 *
 * ---------------------------------------------------------------------------
 * Why a bespoke token and not the existing MPP challenge HMAC
 * ---------------------------------------------------------------------------
 * `MPP_SECRET_KEY` binds 402 payment challenges. Rotating it invalidates every
 * outstanding challenge across the paid proxy — a production payment event.
 * If playground sessions shared that key, a playground incident (leaked token,
 * abuse wave) could only be contained by taking the paid proxy's challenge
 * binding down with it. `PLAYGROUND_SESSION_SECRET` is a separate secret so
 * the playground can be rotated to zero independently, and so a compromise of
 * one never yields the other.
 *
 * ---------------------------------------------------------------------------
 * What the token does and does not carry
 * ---------------------------------------------------------------------------
 * The token carries identity (`sub` = the depositor's Stellar G-address) and
 * nothing else of value. It deliberately does NOT carry a balance: a signed
 * balance would be a bearer instrument that goes stale the moment a call is
 * charged, and replaying an old one would be a free top-up. Balance is read
 * from the ledger DO on every call, keyed by `sub`.
 *
 * `kv` (key version) is stamped so a future secret rotation can accept both
 * old and new tokens during a cutover window instead of logging every user out.
 */

const ISSUER = 'mpprouter-playground'
const AUDIENCE = 'playground'
export const KEY_VERSION = 1

export interface SessionPayload {
  iss: string
  aud: string
  /** Subject: the depositor's Stellar G-address. */
  sub: string
  /** Token id — equals the intent's `session_jti`, so re-open returns this same token. */
  jti: string
  iat: number
  exp: number
  kv: number
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

/**
 * Constant-time comparison.
 *
 * Verification uses `sign`-then-compare rather than `crypto.subtle.verify`
 * so the comparison is explicitly branch-free on content. A naive `===` on
 * the MAC leaks a prefix-match oracle: an attacker can recover a valid MAC
 * byte by byte from response-time differences. Length is compared first and
 * separately — length is not secret.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 16) {
    // Fail closed and loudly. A missing/short secret must never degrade into
    // "issue tokens anyway" — that would make every session forgeable.
    throw new Error('PLAYGROUND_SESSION_SECRET is not configured (min 16 chars)')
  }
  return secret
}

/** Mint a session token for `account`, valid for `ttlSeconds`. */
export async function mintSessionToken(
  secret: string | undefined,
  args: { account: string; jti: string; now: number; ttlSeconds: number },
): Promise<{ token: string; payload: SessionPayload }> {
  const key = await hmacKey(requireSecret(secret))
  const iat = Math.floor(args.now / 1000)
  const payload: SessionPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: args.account,
    jti: args.jti,
    iat,
    exp: iat + args.ttlSeconds,
    kv: KEY_VERSION,
  }
  const encodedPayload = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload)),
  )
  return { token: `${encodedPayload}.${base64urlEncode(mac)}`, payload }
}

export type VerifyFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_audience'
  | 'unknown_key_version'

export type VerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: VerifyFailure }

/**
 * Verify a session token.
 *
 * Signature is checked BEFORE any payload field is trusted — expiry, issuer
 * and audience checks on an unverified payload would be checks on
 * attacker-controlled data.
 */
export async function verifySessionToken(
  secret: string | undefined,
  token: string,
  now: number,
): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' }
  const [encodedPayload, encodedMac] = parts

  let presentedMac: Uint8Array
  try {
    presentedMac = base64urlDecode(encodedMac)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const key = await hmacKey(requireSecret(secret))
  const expectedMac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload)),
  )
  if (!timingSafeEqual(presentedMac, expectedMac)) return { ok: false, reason: 'bad_signature' }

  let payload: SessionPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(encodedPayload)))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (payload.iss !== ISSUER || payload.aud !== AUDIENCE) {
    return { ok: false, reason: 'wrong_audience' }
  }
  if (payload.kv !== KEY_VERSION) return { ok: false, reason: 'unknown_key_version' }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof payload.exp !== 'number' || Math.floor(now / 1000) >= payload.exp) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, payload }
}

/** Extract a bearer token from an Authorization header, or null. */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

/**
 * Mask a Stellar address for display: first 6 + last 4.
 *
 * The playground echoes the depositor's address back to its own owner, but
 * masking is house policy for any address in a response body, log line, or
 * agent transcript.
 */
export function maskAccount(account: string): string {
  if (account.length <= 10) return account
  return `${account.slice(0, 6)}...${account.slice(-4)}`
}
