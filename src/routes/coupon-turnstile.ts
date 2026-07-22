/**
 * Server-side Cloudflare Turnstile verification for the public coupon redeem
 * endpoint.
 *
 * The frontend widget produces a single-use token; a token that is only
 * checked in the browser is worthless (an attacker scripts the POST directly).
 * We therefore ALWAYS re-verify the token against Cloudflare's siteverify API
 * on the backend, and additionally pin the `hostname` and `action` so a token
 * minted for some other site/action cannot be replayed here.
 *
 * Cloudflare siteverify already enforces single-use (a token verified twice
 * returns `timeout-or-duplicate`), which defeats replay of a captured token.
 *
 * Configuration:
 *   env.TURNSTILE_SECRET   — the widget's secret key (wrangler secret).
 *   env.TURNSTILE_HOSTNAME — optional expected hostname (e.g. "open.rozo.ai").
 *                            When unset, hostname is not pinned.
 *
 * When TURNSTILE_SECRET is unset the verifier reports `notConfigured` so the
 * caller can decide the posture. The redeem path treats missing configuration
 * as a HARD FAIL in production (fail closed on a money endpoint); tests and a
 * staged rollout can leave it unset to keep Turnstile off until the widget is
 * wired on the frontend.
 */

import type { Env } from '../index'

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

// The action string the frontend widget is configured with. A token minted for
// any other action (e.g. lifted from a different Turnstile-protected form) is
// rejected. Keep in sync with claim.html's `data-action`.
export const TURNSTILE_ACTION = 'coupon_redeem'

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: 'notConfigured' }
  | { ok: false; reason: 'missingToken' }
  | { ok: false; reason: 'rejected'; codes: string[] }
  | { ok: false; reason: 'unreachable' }

interface SiteverifyResponse {
  success: boolean
  'error-codes'?: string[]
  hostname?: string
  action?: string
}

/**
 * Verify a Turnstile token. Never throws — network failures collapse to
 * `unreachable` so the caller can fail closed with a uniform response.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | null | undefined,
  remoteIp: string | null | undefined,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: 'notConfigured' }

  const t = (token ?? '').trim()
  if (!t) return { ok: false, reason: 'missingToken' }

  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET)
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

  // Pin action: the token MUST carry our exact action. A missing action field
  // (P2, codex 2026-07-22) is treated as a failure, not a pass — an incomplete
  // or unexpected siteverify response must never satisfy a money-endpoint gate.
  if (data.action !== TURNSTILE_ACTION) {
    return { ok: false, reason: 'rejected', codes: ['action-mismatch'] }
  }

  // Pin hostname when an expected value is configured. Hostname pinning is
  // OPT-IN (unset TURNSTILE_HOSTNAME = not pinned, staged-rollout posture). But
  // when it IS configured, the token MUST carry a non-empty matching hostname —
  // a missing/empty hostname field is rejected (fail closed, P2 codex).
  const expectedHost = env.TURNSTILE_HOSTNAME?.trim()
  if (expectedHost && (!data.hostname || data.hostname !== expectedHost)) {
    return { ok: false, reason: 'rejected', codes: ['hostname-mismatch'] }
  }

  return { ok: true }
}
