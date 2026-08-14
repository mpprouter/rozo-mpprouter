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
