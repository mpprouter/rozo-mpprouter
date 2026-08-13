/**
 * Cloudflare Turnstile verification for `POST /v1/playground/session/intent`.
 *
 * Modelled on `src/routes/coupon-turnstile.ts`, but with three deliberate
 * differences that make it a distinct module rather than a reuse:
 *
 *   1. A dedicated action, `playground_intent`, so a token minted for the
 *      coupon widget (or any other Turnstile form) cannot be replayed here.
 *   2. A HARD-PINNED hostname, `www.mpprouter.dev`. The coupon verifier makes
 *      hostname pinning opt-in; the playground has exactly one legitimate
 *      origin, so the pin is compiled in and not left to configuration.
 *   3. A FAIL-CLOSED posture. Intent creation is the gate in front of an
 *      on-chain deposit, so an unconfigured secret must block the request, not
 *      wave it through. The only way to run without Turnstile is the explicit,
 *      auditable `PLAYGROUND_TURNSTILE_DISABLED='true'` opt-out — silence is
 *      never an allow.
 *
 * The token is ALWAYS re-verified server-side against Cloudflare. A token
 * checked only in the browser is worthless: an attacker scripts the POST
 * directly. Cloudflare siteverify also enforces single-use (a token verified
 * twice returns `timeout-or-duplicate`), which defeats replay of a captured
 * token.
 */

import type { Env } from '../index'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * The action the frontend widget must be configured with (`data-action`).
 * A token carrying any other action — e.g. lifted from the coupon form — is
 * rejected.
 */
export const PLAYGROUND_TURNSTILE_ACTION = 'playground_intent'

/**
 * The only origin the playground widget is served from. Compiled in rather
 * than configurable: there is exactly one legitimate host, and a token minted
 * for anywhere else must never satisfy this gate.
 */
export const PLAYGROUND_TURNSTILE_HOSTNAME = 'www.mpprouter.dev'

export type PlaygroundTurnstileResult =
  | { ok: true; mode: 'verified' | 'disabled' }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'missing_token' }
  | { ok: false; reason: 'rejected'; codes: string[] }
  | { ok: false; reason: 'unreachable' }

interface SiteverifyResponse {
  success: boolean
  'error-codes'?: string[]
  hostname?: string
  action?: string
}

/**
 * Is Turnstile explicitly turned off for the playground?
 *
 * This is the ONLY path that lets intent creation proceed without a verified
 * token. It must be set deliberately (`'true'`), so a missing/typo'd secret
 * fails closed instead of silently disabling the gate.
 */
export function isPlaygroundTurnstileDisabled(env: Env): boolean {
  return env.PLAYGROUND_TURNSTILE_DISABLED === 'true'
}

/**
 * Verify a playground Turnstile token. Never throws — a network failure
 * collapses to `unreachable` so the caller fails closed uniformly.
 */
export async function verifyPlaygroundTurnstile(
  env: Env,
  token: string | null | undefined,
  remoteIp: string | null | undefined,
): Promise<PlaygroundTurnstileResult> {
  if (isPlaygroundTurnstileDisabled(env)) return { ok: true, mode: 'disabled' }

  // Fail closed: no secret configured and not explicitly disabled → block.
  if (!env.PLAYGROUND_TURNSTILE_SECRET) return { ok: false, reason: 'not_configured' }

  const t = (token ?? '').trim()
  if (!t) return { ok: false, reason: 'missing_token' }

  const form = new FormData()
  form.append('secret', env.PLAYGROUND_TURNSTILE_SECRET)
  form.append('response', t)
  if (remoteIp) form.append('remoteip', remoteIp)

  let data: SiteverifyResponse
  try {
    const resp = await fetch(SITEVERIFY_URL, { method: 'POST', body: form })
    if (!resp.ok) return { ok: false, reason: 'unreachable' }
    data = (await resp.json()) as SiteverifyResponse
  } catch {
    return { ok: false, reason: 'unreachable' }
  }

  if (!data.success) {
    return { ok: false, reason: 'rejected', codes: data['error-codes'] ?? [] }
  }

  // Pin action. A missing/mismatched action field is a failure, not a pass —
  // an incomplete siteverify response must never satisfy a money-gate.
  if (data.action !== PLAYGROUND_TURNSTILE_ACTION) {
    return { ok: false, reason: 'rejected', codes: ['action-mismatch'] }
  }

  // Pin hostname, always. Unlike the coupon verifier this is not optional: a
  // missing or non-matching hostname is rejected.
  if (data.hostname !== PLAYGROUND_TURNSTILE_HOSTNAME) {
    return { ok: false, reason: 'rejected', codes: ['hostname-mismatch'] }
  }

  return { ok: true, mode: 'verified' }
}
