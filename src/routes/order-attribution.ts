/**
 * Order-level attribution written to `metadata.attribution` on intent creation.
 *
 * Why: every OpenRouter-line order is created by this Worker, and every caller
 * (agent.rozo.ai, checkout.rozo.ai, the `@rozoai/checkout` skill) posts the
 * same body shape. The legacy top-level `client` label is self-declared and in
 * practice two different surfaces send the same value, so paid and unpaid
 * orders cannot be split by surface or campaign from the backend alone.
 *
 * Relationship to the other attribution field: the raw top-level `attribution`
 * object is still forwarded untouched to payment-api, whose own whitelist
 * (utm-attribution.ts) files a strict subset under the server-only
 * `metadata.internal.attribution`. That stays as it is. This module owns a
 * different, wider record (it keeps `client` and a referrer origin+path, which
 * the payment-api whitelist rejects by design) under a different key, so the
 * two never parse into the same field.
 *
 * Contract (shared with the frontends, fixed 2026-09-25):
 *  - allowed keys only: client (<=64), utm_source / utm_medium / utm_campaign /
 *    utm_content (<=100 each), referrer (<=512, origin + path for our own
 *    hosts, origin only for third-party hosts), and
 *    landing_path (<=256, query stripped)
 *  - unknown keys and non-string values are dropped; control and format
 *    characters are stripped; over-length values are truncated
 *  - when `client` is absent it is derived from the User-Agent header
 *
 * Telemetry rules, same as the rest of the money path: this never throws, and
 * it never influences pricing, routing, validation or error codes. Anything it
 * cannot parse is dropped, never rejected.
 */

export interface OrderAttribution {
  client?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  referrer?: string
  landing_path?: string
}

const CLIENT_MAX = 64
const UTM_MAX = 100
const REFERRER_MAX = 512
const LANDING_PATH_MAX = 256
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const

// C0/C1 controls (Cc) and invisible format characters (Cf: zero-width, bidi
// overrides, BOM). Stripped rather than enumerated glyph by glyph.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

const SKILL_UA = /^rozo-checkout-skill\/[A-Za-z0-9._+-]+/

/** Strip invisibles, trim, truncate. Returns null for non-strings / empty. */
function cleanString(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  // Bound the work before the regex pass: an oversized value cannot burn CPU.
  const cleaned = raw.slice(0, max * 4).replace(INVISIBLE, '').trim().slice(0, max).trim()
  return cleaned.length ? cleaned : null
}

// Hosts whose paths are our own pages. A third-party referrer path can carry
// someone else's token, invite code or email address, and metadata is returned
// to anyone holding the order id, so only our own paths are kept (codex P1).
const OWN_HOST = /(^|\.)(rozo\.ai|mpprouter\.dev)$/i

/**
 * Referrer of an absolute http(s) URL with query and fragment dropped:
 * origin + path for our own hosts, origin only for everyone else.
 */
function cleanReferrer(raw: unknown): string | null {
  const value = cleanString(raw, REFERRER_MAX * 4)
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const out = OWN_HOST.test(url.hostname) ? `${url.origin}${url.pathname}` : url.origin
  return cleanString(out, REFERRER_MAX)
}

/** Path with any query / fragment removed. */
function cleanLandingPath(raw: unknown): string | null {
  const value = cleanString(raw, LANDING_PATH_MAX * 4)
  if (!value) return null
  const cut = value.split(/[?#]/, 1)[0]
  return cleanString(cut, LANDING_PATH_MAX)
}

/** Client label derived from the caller's User-Agent header. */
export function clientFromUserAgent(ua: string | null | undefined): string {
  try {
    const value = typeof ua === 'string' ? ua.trim() : ''
    const skill = value.match(SKILL_UA)
    if (skill) return skill[0].slice(0, CLIENT_MAX)
    if (value.startsWith('Mozilla/')) return 'browser'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Sanitize the caller-supplied `attribution` object. Returns null when nothing
 * survives (including a missing or non-object value). Never throws.
 */
export function sanitizeOrderAttribution(raw: unknown): OrderAttribution | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const src = raw as Record<string, unknown>
    const out: OrderAttribution = {}
    const client = cleanString(src.client, CLIENT_MAX)
    if (client) out.client = client
    for (const key of UTM_KEYS) {
      const v = cleanString(src[key], UTM_MAX)
      if (v) out[key] = v
    }
    const referrer = cleanReferrer(src.referrer)
    if (referrer) out.referrer = referrer
    const landing = cleanLandingPath(src.landing_path)
    if (landing) out.landing_path = landing
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

/**
 * The `metadata.attribution` value for a newly created intent: the sanitized
 * caller object with `client` filled from the User-Agent when absent. Returns
 * null only if something unexpected throws, in which case the key is omitted.
 */
export function buildOrderAttribution(raw: unknown, request: Request): OrderAttribution | null {
  try {
    const sanitized = sanitizeOrderAttribution(raw) ?? {}
    if (!sanitized.client) {
      let ua: string | null = null
      try {
        ua = request.headers.get('user-agent')
      } catch {
        ua = null
      }
      sanitized.client = clientFromUserAgent(ua)
    }
    return sanitized
  } catch {
    return null
  }
}

/** Spread helper: `{ attribution }` or `{}`. */
export function attributionMetadata(attr: OrderAttribution | null): { attribution?: OrderAttribution } {
  return attr && Object.keys(attr).length ? { attribution: attr } : {}
}
