/**
 * Forward what THIS Worker saw from its caller to rozo-intents-api.
 *
 * Why: payment-api records a `client_hint` (UA / IP / referer / origin) on every
 * order it creates, but for the OpenRouter checkout line every order arrives
 * through this Worker, so that hint is this Worker's own Cloudflare egress IP
 * with no UA — 33 of 33 orders in W37 carried the identical hint. The only hop
 * that ever sees the browser or agent is create-invoice, so it packs those
 * headers into one JSON header, `x-rozo-client-hint`, which payment-api stores
 * under `metadata.internal.client_hint.forwarded` (keyed callers only).
 *
 * Telemetry rules, same as everything else on the money path:
 *  - never throws, never blocks: any failure yields `null` and no header
 *  - bounded: each field is truncated, the whole header is capped
 *  - the IP is PII: payment-api keeps it in the server-only `internal`
 *    namespace that is stripped from every API response
 */

export const FORWARDED_HINT_HEADER = 'x-rozo-client-hint'

const MAX_UA = 200
const MAX_URL = 300
const MAX_IP = 64
const MAX_HEADER = 1024

export interface ForwardedClientHint {
  ua: string | null
  ip: string | null
  referer: string | null
  origin: string | null
  client: string | null
}

function header(request: Request, name: string, max: number): string | null {
  try {
    const raw = request.headers.get(name)
    if (!raw) return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed
  } catch {
    return null
  }
}

/** The caller's hint as seen by this Worker. Exported for tests. */
export function buildForwardedClientHint(request: Request, client: string | null): ForwardedClientHint {
  return {
    ua: header(request, 'user-agent', MAX_UA),
    ip: header(request, 'cf-connecting-ip', MAX_IP) ?? header(request, 'x-real-ip', MAX_IP),
    referer: header(request, 'referer', MAX_URL),
    origin: header(request, 'origin', MAX_URL),
    client,
  }
}

/**
 * Header value for the upstream POST, or `null` when there is nothing worth
 * forwarding (every field empty) or the encoded value would be oversized.
 */
export function forwardedClientHintHeader(request: Request, client: string | null): string | null {
  try {
    const hint = buildForwardedClientHint(request, client)
    if (!hint.ua && !hint.ip && !hint.referer && !hint.origin && !hint.client) return null
    const encoded = JSON.stringify(hint)
    return encoded.length > MAX_HEADER ? null : encoded
  } catch {
    return null
  }
}

/** Add the header to an outgoing header map when there is one to add. */
export function withForwardedClientHint(
  headers: Record<string, string>,
  hintHeader: string | null | undefined,
): Record<string, string> {
  return hintHeader ? { ...headers, [FORWARDED_HINT_HEADER]: hintHeader } : headers
}
