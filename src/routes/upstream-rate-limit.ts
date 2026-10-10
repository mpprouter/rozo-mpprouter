/**
 * Relay a rozo-intents-api 429 to the create-invoice caller.
 *
 * Since 2026-10-10 the buyer-facing creation limit lives in rozo-intents-api
 * (tiered per forwarded IP, PR #643). Its 429 carries `Retry-After`,
 * `X-RateLimit-*` headers and a JSON body whose `data` names the tier:
 *
 *   { "error": { "code": "rate_limited", "message": "..." },
 *     "data":  { "errorCode": "CREATE_RATE_LIMITED", "tier": "tier0",
 *                "scope": "ip_window", "limit": 10, "windowSeconds": 600,
 *                "remaining": 0, "retryAfterSeconds": 600, "upgrade": "..." } }
 *
 * Before this module every upstream 429 became a 502 INTENTS_API_FAILED, so a
 * buyer or agent could not tell "slow down for N seconds" from "we are down".
 * Now the caller gets status 429, the rate-limit headers, and mpprouter's own
 * `RATE_LIMITED` envelope with the upstream fields lifted to the top level
 * (plus the untouched upstream body under `upstream`).
 */

/** Headers copied verbatim from the upstream 429 (plus any `x-ratelimit-*`). */
const RELAYED_HEADER_PREFIX = 'x-ratelimit-'

/** Upstream `data` fields lifted to the top level of the relayed body. */
const LIFTED_FIELDS = [
  'errorCode',
  'tier',
  'scope',
  'limit',
  'windowSeconds',
  'remaining',
  'retryAfterSeconds',
  'upgrade',
] as const

const MAX_MESSAGE = 500

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function retryAfterFromBody(data: any): string | null {
  const n = Number(data?.retryAfterSeconds)
  return Number.isFinite(n) && n > 0 ? String(Math.ceil(n)) : null
}

/**
 * Build the caller-facing 429 for an upstream 429, or `null` when the
 * upstream status is not 429 (caller keeps its existing error handling).
 * `envelope` lets a branch keep its own error shape (e.g. Bitrefill's
 * `error: <CODE>`, Stripe's `provider`).
 */
export function relayUpstreamRateLimit(
  upstream: Response,
  upstreamText: string,
  envelope: Record<string, unknown> = {},
): Response | null {
  if (upstream.status !== 429) return null

  const body = parseJson(upstreamText)
  const data = body && typeof body === 'object' ? body.data : null

  const headers = new Headers({ 'Content-Type': 'application/json' })
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (lower === 'retry-after' || lower.startsWith(RELAYED_HEADER_PREFIX)) headers.set(name, value)
  })
  // Upstream proxies may drop headers; the body still says how long to wait.
  if (!headers.has('retry-after')) {
    const fromBody = retryAfterFromBody(data)
    if (fromBody) headers.set('Retry-After', fromBody)
  }

  const lifted: Record<string, unknown> = {}
  if (data && typeof data === 'object') {
    for (const key of LIFTED_FIELDS) {
      if (data[key] !== undefined) lifted[key] = data[key]
    }
  }

  const upstreamMessage =
    typeof body?.error?.message === 'string'
      ? body.error.message
      : typeof body?.message === 'string'
        ? body.message
        : null
  const retryAfter = headers.get('retry-after')
  const message = (
    upstreamMessage ||
    `Too many invoice creation requests.${retryAfter ? ` Retry after ${retryAfter}s.` : ' Please try again later.'}`
  ).slice(0, MAX_MESSAGE)
  const upstreamCode =
    typeof body?.error?.code === 'string' ? body.error.code : typeof body?.code === 'string' ? body.code : null

  const payload = {
    ok: false,
    error: message,
    code: 'RATE_LIMITED',
    message,
    ...lifted,
    upstream_status: 429,
    ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
    upstream: body ?? null,
    ...envelope,
  }
  return new Response(JSON.stringify(payload), { status: 429, headers })
}
