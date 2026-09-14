/**
 * Idempotency cache keys for the paid proxy path.
 *
 * ## Why this file exists
 *
 * The original implementation cached merchant responses under the bare
 * client-supplied `x-request-id`:
 *
 *     idempotency:<x-request-id>          // <- global namespace
 *
 * and looked that key up at the very top of `handleProxy`, *before* any
 * Authorization header was parsed and before anybody was charged. Two
 * things fell out of that:
 *
 *   1. **Free rides.** Replaying a known request id returned a paid
 *      merchant response with no credential at all.
 *   2. **Cross-account disclosure.** The key was not bound to the payer,
 *      the route, or the request body, so one account's response could be
 *      served to a different caller that guessed (or observed) the id.
 *
 * The fix has two halves, and both matter:
 *
 *   - The cache is now read *after* the credential has been
 *     cryptographically verified and the payer charged, so a cache hit is
 *     never a way to skip payment.
 *   - The key is derived from `(payer, routeId, requestId, sha256(body))`
 *     rather than the request id alone, so a hit can only ever return the
 *     same payer's own response to the same route with the same body.
 *
 * The v2 prefix keeps these entries in a separate namespace from any
 * `idempotency:*` values written by the old code (and from the unrelated
 * `tempoChannel:*` / channel-store keys that share this KV binding).
 */

const IDEMPOTENCY_KEY_PREFIX = 'idempotency:v2:'

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Length-prefix one field so the concatenation below is an injective
 * encoding of the tuple.
 *
 * A plain `a=1\nb=2` join is NOT injective when any field is caller
 * controlled: `route="openrouter\nrequest=X"` with requestId `Y`
 * serializes byte-for-byte the same as route `openrouter` with requestId
 * `X\nrequest=Y`. Hashing an ambiguous string just hashes the ambiguity.
 * With an explicit byte length in front of every value, no field can
 * absorb a delimiter and impersonate its neighbour.
 */
function lengthPrefixed(value: string): string {
  const bytes = new TextEncoder().encode(value).length
  return `${bytes}:${value}`
}

/**
 * Build the KV key for one payer's idempotent retry of one request.
 *
 * The keyed identity is everything that can change the merchant response:
 * who paid, which route, which upstream method + path + query (routes
 * resolve `:placeholder` segments and forward query params, so one route
 * id addresses many distinct merchant resources), the caller's request
 * id, and the request body. Miss any of those and a cache hit can serve
 * the response to a *different* upstream call.
 *
 * All fields are folded into a single SHA-256 so the stored key doesn't
 * leak the payer account to anyone able to list the namespace.
 */
export async function buildIdempotencyKey(params: {
  requestId: string
  routeId: string
  payer: string
  method: string
  upstreamPath: string
  forwardedSearch: string
  body: string | undefined
}): Promise<string> {
  const bodyHash = await sha256Hex(params.body ?? '')
  const material = [
    params.payer,
    params.routeId,
    params.method,
    params.upstreamPath,
    params.forwardedSearch,
    params.requestId,
    bodyHash,
  ].map(lengthPrefixed).join('')
  return `${IDEMPOTENCY_KEY_PREFIX}${await sha256Hex(material)}`
}

const X402_REPLAY_KEY_PREFIX = 'idempotency:x402:'

/**
 * Cache key for the stellar.x402 branch, where the *signed payload itself*
 * is the identity.
 *
 * That branch could not use buildIdempotencyKey(): the payer there is
 * decoded from XDR for ledger attribution only and may be null, and scoping
 * a cached paid response to an unverified identity is exactly the
 * cross-account leak the payer-keyed cache exists to prevent.
 *
 * The payload hash sidesteps that. Only the holder of the signing key can
 * produce the signed transaction, a payload is single-use on this router
 * (checkAndReserveNonce), and a bearer who re-presents it is by construction
 * the same party who paid with it. So a hit can only ever hand back the
 * result that this very payment already bought. Route, method, upstream path
 * + query and body are still folded in: the signature covers the Soroban
 * invoke, not the HTTP request, so without them one payment could be
 * replayed against a different upstream call.
 */
export async function buildX402ReplayKey(params: {
  payloadHash: string
  routeId: string
  method: string
  upstreamPath: string
  forwardedSearch: string
  body: string | undefined
}): Promise<string> {
  const bodyHash = await sha256Hex(params.body ?? '')
  const material = [
    params.payloadHash,
    params.routeId,
    params.method,
    params.upstreamPath,
    params.forwardedSearch,
    bodyHash,
  ].map(lengthPrefixed).join('')
  return `${X402_REPLAY_KEY_PREFIX}${await sha256Hex(material)}`
}

/** What the x402 replay cache stores: the delivered body plus its receipt. */
export interface X402CachedResult {
  status: number
  body: string
  headers: Record<string, string>
}

/**
 * Validate a value read back from KV before serving it. The entry is our
 * own write, but a stale or malformed record must degrade to the ordinary
 * replay error rather than throw inside the payment path. Only the header
 * set the x402 branch itself constructs (content type + payment receipt)
 * is accepted; nothing else is ever stored, so nothing else is replayed.
 */
const X402_CACHED_HEADER = /^(content-type|payment-response|x-payment-[a-z-]+|x-mpprouter-[a-z-]+)$/i

export function parseX402CachedResult(value: unknown): X402CachedResult | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.status !== 200 || typeof v.body !== 'string') return null
  if (!v.headers || typeof v.headers !== 'object' || Array.isArray(v.headers)) return null
  const headers: Record<string, string> = {}
  for (const [name, val] of Object.entries(v.headers as Record<string, unknown>)) {
    if (typeof val !== 'string' || !X402_CACHED_HEADER.test(name)) return null
    headers[name] = val
  }
  return { status: 200, body: v.body, headers }
}
