/**
 * CORS for the MPP Router worker.
 *
 * The router is a public paid-API gateway — agents and browser apps
 * (e.g. demo at http://localhost:3001) call it cross-origin. We
 * therefore allow any origin, and explicitly expose the 402-challenge
 * response headers so JS clients running mppx / x402 can read them.
 *
 *   Request headers we accept:
 *     - authorization        (mppx + x402 V1 credential)
 *     - payment-signature    (x402 V2 credential)
 *     - content-type
 *     - x-request-id
 *
 *   Response headers we expose to JS:
 *     - www-authenticate     (mppx 402 challenge)
 *     - payment-required     (x402 402 challenge)
 *     - x-request-id
 *     - retry-after          (429 backoff, read by browser checkout UIs)
 *
 * Echoing the Origin (rather than `*`) keeps the door open for
 * credentialed requests later without a code change.
 */

const ALLOWED_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'payment-signature',
  'x-request-id',
  // mppx/x402 channel-voucher retry sends the credential in these headers
  'accept-payment',
  'x-payment',
  'payment',
].join(', ')

const EXPOSED_RESPONSE_HEADERS = [
  'www-authenticate',
  'payment-required',
  'x-request-id',
  // 402 challenge headers the browser mppx client must read
  'accept-payment',
  'payment',
  // 429 backoff. Without this a browser checkout UI cannot read Retry-After
  // cross-origin — the header is present on the wire but hidden from JS — so
  // the client has no way to back off correctly.
  'retry-after',
].join(', ')

const ALLOWED_METHODS = 'GET, POST, OPTIONS'

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '*'
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_REQUEST_HEADERS,
    'access-control-expose-headers': EXPOSED_RESPONSE_HEADERS,
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

export function handlePreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v)
  // Keep this API domain out of search indexes. apiserver.mpprouter.dev is a
  // machine-facing gateway, not a page for humans to find via Google. This
  // header only affects search-engine crawlers; it does not change anything
  // for agent / API consumers (which never read X-Robots-Tag).
  headers.set('x-robots-tag', 'noindex, nofollow')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
