/**
 * Router-hosted paywall for providers who have an API but no payment layer.
 *
 * ## The shape
 *
 * A provider gives us an origin (`https://api.example.com`), a payout
 * address, the routes and prices, and ONE credential the gateway will
 * present to the origin — either a key the origin already requires, or a
 * secret we generate that they make the origin check. We then serve
 * `https://<id>.<PROVIDER_HOSTED_SUFFIX>` (default `pay.mpprouter.dev`)
 * as the paid endpoint: unpaid → our 402 naming THEIR payout address;
 * paid (x402, exact scheme, Stellar) → we call the origin with the
 * credential injected, and settle the buyer's transfer to the provider
 * only after the origin answered 2xx. The money never enters a ROZO
 * account: the facilitator submits a transfer the buyer signed to the
 * provider. That is the same direct-settlement claim the relay makes, with
 * the paywall on our infrastructure instead of theirs.
 *
 * ## What is and is not proven
 *
 * There is no domain to prove — the origin's operator is whoever can make
 * the origin accept the credential. So the ownership proof for hosted
 * records is `hosted_origin_auth`: the paid gate calls the origin through
 * the gateway with the stored credential and the origin serves the call.
 * A supplied key proves the registrant is at least a customer of the
 * origin; a generated secret the origin honours proves they configured
 * the origin. Neither proves key custody of the payout address, and the
 * public record says so, exactly as it does for `x402_pay_to`.
 *
 * ## The credential at rest
 *
 * Encrypted with AES-256-GCM under a key derived from
 * `PROVIDER_HOSTING_KEK` (a Worker secret), one random IV per record,
 * never returned by any endpoint, never logged. Without the KEK hosted
 * registration answers 503 rather than storing anything in the clear.
 *
 * ## mppx charge is refused on hosted routes
 *
 * The router's mppx `stellar.charge` branch settles the buyer's transfer
 * at verify time, BEFORE the origin is called. On a route we host that
 * would mean a buyer pays and then sees the origin's 500 with no refund.
 * The x402 branch settles after the origin's 2xx, so hosted routes accept
 * x402 credentials only and their unpaid 402 carries only the x402
 * challenge.
 */

import type { Env } from '../index'
import type { PublicServiceRoute } from './merchants-types'
import { getProviderRecord, listOverlayRoutes, validateApiBaseUrl, ProviderValidationError } from './provider-registry'

export const DEFAULT_HOSTED_SUFFIX = 'pay.mpprouter.dev'

export function hostedSuffix(env: Env): string {
  return (env.PROVIDER_HOSTED_SUFFIX || DEFAULT_HOSTED_SUFFIX).toLowerCase()
}

/** The hosted origin a provider id is served on. */
export function hostedOriginFor(env: Env, providerId: string): string {
  return `https://${providerId}.${hostedSuffix(env)}`
}

/** The provider id a hosted hostname names, or null when the host is not ours. */
export function hostedProviderIdFor(env: Env, hostname: string): string | null {
  const suffix = `.${hostedSuffix(env)}`
  const host = hostname.toLowerCase()
  if (!host.endsWith(suffix)) return null
  const id = host.slice(0, -suffix.length)
  return /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(id) ? id : null
}

export interface HostedAuthSpec {
  /** Header the origin expects, e.g. `Authorization` or `X-API-Key`. */
  header: string
  scheme: 'bearer' | 'raw'
  /** Plaintext credential — only ever in memory. */
  value: string
  /** True when the router generated the value for the provider to configure. */
  generated: boolean
}

export interface HostedConfig {
  originUrl: string
  auth: HostedAuthSpec
}

/** What is stored on the record: header/scheme in the clear, value encrypted. */
export interface StoredHosting {
  mode: 'router'
  originUrl: string
  auth: { header: string; scheme: 'bearer' | 'raw'; iv: string; ciphertext: string; generated: boolean }
  /** SHA-256 of the plaintext, so a provider can confirm which secret is live without us returning it. */
  authDigest: string
}

const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const MAX_SECRET_BYTES = 1024

/** Parse and validate the `hosting` block of a registration body. */
export function validateHosting(raw: unknown): HostedConfig {
  if (!raw || typeof raw !== 'object') throw new ProviderValidationError('hosting', 'Expected an object.')
  const h = raw as Record<string, unknown>
  const originUrl = validateApiBaseUrl(String(h.origin_url ?? ''))
  const authRaw = (h.auth ?? {}) as Record<string, unknown>
  const header = String(authRaw.header ?? 'Authorization').trim()
  if (!HEADER_PATTERN.test(header)) throw new ProviderValidationError('hosting', 'auth.header must be a plain header name.')
  const lower = header.toLowerCase()
  if (['host', 'content-length', 'transfer-encoding', 'cookie', 'payment-signature', 'x-payment'].includes(lower)) {
    throw new ProviderValidationError('hosting', `auth.header cannot be ${header}.`)
  }
  const scheme = String(authRaw.scheme ?? (lower === 'authorization' ? 'bearer' : 'raw')) as 'bearer' | 'raw'
  if (scheme !== 'bearer' && scheme !== 'raw') throw new ProviderValidationError('hosting', 'auth.scheme must be bearer or raw.')
  const generate = authRaw.generate === true
  const supplied = authRaw.value === undefined ? '' : String(authRaw.value)
  if (generate && supplied) throw new ProviderValidationError('hosting', 'Provide auth.value OR auth.generate, not both.')
  if (!generate && !supplied) {
    throw new ProviderValidationError('hosting', 'auth.value (a credential your origin accepts) or auth.generate=true is required.')
  }
  if (supplied && new TextEncoder().encode(supplied).byteLength > MAX_SECRET_BYTES) {
    throw new ProviderValidationError('hosting', 'auth.value is too long.')
  }
  if (supplied && /[\r\n]/.test(supplied)) throw new ProviderValidationError('hosting', 'auth.value cannot contain newlines.')
  const value = generate ? generateGatewaySecret() : supplied
  return { originUrl, auth: { header, scheme, value, generated: generate } }
}

function generateGatewaySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'mppg_' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------

async function kek(env: Env): Promise<CryptoKey | null> {
  const material = env.PROVIDER_HOSTING_KEK
  if (!material || material.length < 32) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0))
}

export async function hostingAvailable(env: Env): Promise<boolean> {
  return (await kek(env)) !== null
}

export async function sealHosting(env: Env, config: HostedConfig): Promise<StoredHosting> {
  const key = await kek(env)
  if (!key) throw new Error('PROVIDER_HOSTING_KEK is not configured')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(config.auth.value)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  const digest = await crypto.subtle.digest('SHA-256', plaintext)
  return {
    mode: 'router',
    originUrl: config.originUrl,
    auth: { header: config.auth.header, scheme: config.auth.scheme, iv: b64(iv), ciphertext: b64(ciphertext), generated: config.auth.generated },
    authDigest: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16),
  }
}

export async function openHostingSecret(env: Env, stored: StoredHosting): Promise<string | null> {
  const key = await kek(env)
  if (!key) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(stored.auth.iv) }, key, unb64(stored.auth.ciphertext))
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/**
 * Headers the gateway sends to the origin: the buyer's content negotiation
 * plus the provider's credential. Nothing of the buyer's own credentials
 * (their payment header is ours to verify, not the origin's), nothing of
 * ours.
 */
export async function hostedOriginHeaders(env: Env, providerId: string, request: Request): Promise<Headers | null> {
  const record = await getProviderRecord(env, providerId)
  if (!record?.hosting) return null
  const secret = await openHostingSecret(env, record.hosting)
  if (secret === null) return null
  const headers = new Headers()
  for (const name of ['accept', 'accept-language', 'content-type', 'user-agent', 'idempotency-key', 'x-request-id']) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }
  headers.set(record.hosting.auth.header, record.hosting.auth.scheme === 'bearer' ? `Bearer ${secret}` : secret)
  headers.set('X-MPP-Router-Gateway', providerId)
  return headers
}

/**
 * Resolve a request on a hosted hostname to the overlay route it names.
 * The path on the hosted host mirrors the origin path exactly, so a buyer
 * swaps the host and nothing else.
 */
export async function resolveHostedRoute(
  env: Env,
  hostname: string,
  pathname: string,
  method: string,
): Promise<PublicServiceRoute | undefined> {
  const id = hostedProviderIdFor(env, hostname)
  if (!id) return undefined
  const routes = await listOverlayRoutes(env)
  return routes.find(r => r.hosted && r.operator?.id === id && r.hostedPath === pathname && r.method === method.toUpperCase())
}
