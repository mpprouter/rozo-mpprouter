/**
 * Partner authentication — thin routes over the primitives in partner-store.ts.
 *
 * Design: ainative `todos/20260807-coupon-reseller-platform.md` §3.1 / §3.10.
 *
 * There is exactly one credential (a username + a password WE generate) and one
 * fallback (an admin-minted, 15-minute, single-use login link). No signup, no
 * self-serve reset, no password change. That is a deliberate product decision,
 * not an omission: with a single partner, every one of those flows is a new
 * public attack surface bought for nothing.
 *
 * ## Username is the partner's email
 *
 * The store keys accounts by a normalised email and there is no second index,
 * so `username` on the login body IS the email. Keeping one identity avoids the
 * class of bug where an account is reachable under one name and not the other.
 *
 * ## Two properties this module exists to hold
 *
 * 1. **No account-existence oracle.** An unknown username and a wrong password
 *    return the identical body. To also avoid a trivial timing oracle we run a
 *    full PBKDF2 derivation against a decoy credential when the account is
 *    absent, so both branches cost the same. (Side-channel hardening beyond
 *    this is explicitly out of scope — founder 2026-08-07.)
 * 2. **A lockout on the password endpoint.** 10 failures in an hour locks the
 *    account for an hour. A public password endpoint without one is a back
 *    door: 100 bits of generated password are irrelevant if an attacker gets
 *    unlimited guesses at a password a human might later ask us to shorten.
 *    Counted per ACCOUNT (per-IP is trivially evaded and would let one attacker
 *    lock out the real partner).
 *
 * ## Session cookie
 *
 * `partnerId|expiry` signed with HMAC-SHA-256 under `PARTNER_SESSION_SECRET`,
 * 45 days, `HttpOnly; Secure; SameSite=Lax; Path=/`. Page and API are same
 * origin (the Worker serves both), so Lax is sufficient and SameSite=None —
 * which would expose the cookie to cross-site requests — is not needed.
 *
 * Missing secret FAILS CLOSED (500), never "unsigned session". An unsigned or
 * fixed-key session cookie is forgeable, and a forged cookie here spends the
 * partner's balance.
 *
 * ⚠️ T4 must add `PARTNER_SESSION_SECRET?: string` to the `Env` interface in
 * src/index.ts. This module reads it through a cast because T2 may not edit
 * that file (route registration is T4's, to avoid three agents colliding in
 * one file).
 */

import type { Env } from '../index'
import {
  clearAuthFailures,
  consumeLoginToken,
  createLoginToken,
  decoyAuth,
  generatePartnerPassword,
  getOrCreatePartnerByEmail,
  getPartner,
  getPartnerIdByEmail,
  isAuthLocked,
  normalizeEmail,
  recordAuthFailure,
  resolvePartnerIdByApiKey,
  setPartnerApiKey,
  setPartnerPassword,
  verifyPassword,
  isValidPartnerIdentifier,} from './partner-store'

// ── Tunables ─────────────────────────────────────────────────────────────────

export const SESSION_TTL_MS = 45 * 24 * 60 * 60_000 // 45 days (§3.1)
export const SESSION_COOKIE = 'rozo_partner_session'
/** Where a successful login-link lands. Served by the same Worker (§3.11). */
export const PARTNER_APP_PATH = '/partner/app'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * The ONE response every failed credential attempt returns. Shared by "no such
 * user", "no password set", "wrong password" and "locked", so nothing about the
 * account can be inferred from a login attempt.
 *
 * The lock case is folded in on purpose: a distinct "account locked" reply
 * confirms the account exists, and it also tells an attacker exactly when to
 * resume.
 */
function invalidCredentials(): Response {
  return json(401, {
    error: 'INVALID_CREDENTIALS',
    message: 'Invalid username or password.',
  })
}

// ── Session cookie ───────────────────────────────────────────────────────────

function sessionSecret(env: Env): string | null {
  const s = (env as unknown as { PARTNER_SESSION_SECRET?: string }).PARTNER_SESSION_SECRET
  return typeof s === 'string' && s.length > 0 ? s : null
}

function b64urlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(input: string): string | null {
  try {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
    return atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad)
  } catch {
    return null
  }
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `v1.<b64url({p,e})>.<hmac>`. The payload is signed, not encrypted — a
 * partner id is not a secret; forgeability is the only thing that matters. */
export async function signSession(
  secret: string,
  partnerId: string,
  expiresAtMs: number,
): Promise<string> {
  const body = b64urlEncode(JSON.stringify({ p: partnerId, e: expiresAtMs }))
  return `v1.${body}.${await hmacHex(secret, body)}`
}

export async function verifySession(secret: string, token: string): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, body, sig] = parts
  // Verify BEFORE parsing: the payload is attacker-controlled until the MAC
  // says otherwise, and expiry read out of an unverified payload is worthless.
  if (!timingSafeEqualStr(await hmacHex(secret, body), sig)) return null
  const raw = b64urlDecode(body)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { p?: unknown; e?: unknown }
    if (typeof parsed.p !== 'string' || typeof parsed.e !== 'number') return null
    if (parsed.e <= Date.now()) return null
    return parsed.p
  } catch {
    return null
  }
}

export function sessionCookieHeader(token: string, maxAgeMs: number): string {
  // Secure: never sent over plaintext. HttpOnly: unreachable from JS, so an
  // XSS on the partner page cannot exfiltrate the session. Lax: same-origin
  // page + API, so no cross-site request needs it.
  return `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

export type SessionResult =
  | { ok: true; partnerId: string }
  | { ok: false; response: Response }

/** Extract a `Authorization: Bearer <key>` value, or null. */
function readBearer(request: Request): string | null {
  const header = request.headers.get('authorization')?.trim()
  if (!header) return null
  const m = header.match(/^Bearer\s+(\S+)$/i)
  return m ? m[1] : null
}

/**
 * Gate for every `/partner/*` endpoint. The partner id comes ONLY from a signed
 * cookie or a hashed API key — never from the body, query or a plain header —
 * which is what makes tenant isolation structural rather than a check each
 * route has to remember.
 *
 * Two credentials, one gate, deliberately: every downstream money route
 * (issue, void) reads its partner from here, so an API caller gets exactly the
 * authority of the browser session and not a byte more. A second gate would be
 * a second place to forget the suspended-account check below.
 *
 * The cookie is tried first and the Bearer key is a fallback, so a browser —
 * which cannot be made to attach an Authorization header cross-site — is never
 * authenticated by anything an attacking page can control. CSRF therefore
 * stays a cookie-only concern, unchanged by this path.
 */
export async function requirePartnerSession(request: Request, env: Env): Promise<SessionResult> {
  const secret = sessionSecret(env)
  if (!secret) {
    return {
      ok: false,
      response: json(500, { error: 'PARTNER_SESSION_SECRET is not configured' }),
    }
  }
  const raw = readCookie(request, SESSION_COOKIE)
  const bearer = raw ? null : readBearer(request)
  if (!raw && !bearer) return { ok: false, response: json(401, { error: 'UNAUTHENTICATED' }) }

  const partnerId = raw
    ? await verifySession(secret, raw)
    : await resolvePartnerIdByApiKey(env, bearer as string)
  if (!partnerId) return { ok: false, response: json(401, { error: 'UNAUTHENTICATED' }) }

  // A signed cookie for a deleted or suspended account must not keep working.
  const partner = await getPartner(env, partnerId)
  if (!partner) return { ok: false, response: json(401, { error: 'UNAUTHENTICATED' }) }
  if (partner.status !== 'active') {
    return { ok: false, response: json(403, { error: 'PARTNER_SUSPENDED' }) }
  }
  return { ok: true, partnerId }
}

// ── Admin auth (same pattern/secret as the coupon admin endpoints) ───────────

function adminAuthorized(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) return json(500, { error: 'ADMIN_TOKEN is not configured' })
  const secret = request.headers.get('x-admin-secret')?.trim()
  if (!secret || secret !== env.ADMIN_TOKEN) return json(401, { error: 'Unauthorized' })
  return null
}

// ── POST /partner/auth/login ─────────────────────────────────────────────────

/**
 * Username + password. Every failure path returns `invalidCredentials()` and
 * pays roughly the same PBKDF2 cost, so neither the body nor the latency
 * distinguishes "no such account" from "wrong password".
 */
export async function handlePartnerLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const secret = sessionSecret(env)
  if (!secret) return json(500, { error: 'PARTNER_SESSION_SECRET is not configured' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }
  const username = normalizeEmail(typeof body?.username === 'string' ? body.username : '')
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || !password) return invalidCredentials()

  const partnerId = await getPartnerIdByEmail(env, username)
  const partner = partnerId ? await getPartner(env, partnerId) : null

  // Unknown account: still derive, against a decoy that cannot match.
  if (!partner) {
    await verifyPassword(decoyAuth(), password)
    return invalidCredentials()
  }

  // Locked accounts short-circuit BEFORE the derivation. Doing the work anyway
  // would turn the lockout into an amplifier: an attacker keeps burning our
  // CPU for free while learning nothing.
  if (await isAuthLocked(env, partner.id)) return invalidCredentials()

  const ok = await verifyPassword(partner.auth, password)
  if (!ok) {
    await recordAuthFailure(env, partner.id)
    return invalidCredentials()
  }
  if (partner.status !== 'active') {
    // Deliberately the same body: an attacker with the right password should
    // not learn that this is a real-but-suspended account.
    return invalidCredentials()
  }

  await clearAuthFailures(env, partner.id)
  const token = await signSession(secret, partner.id, Date.now() + SESSION_TTL_MS)
  return new Response(JSON.stringify({ ok: true, redirect: PARTNER_APP_PATH }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_MS),
    },
  })
}

// ── GET /partner/auth/callback?token= ────────────────────────────────────────

/**
 * Login-link landing page. The token is consumed inside a CAS, so two
 * concurrent clicks cannot both authenticate.
 *
 * Redirects rather than rendering, so the single-use token leaves the address
 * bar immediately and does not end up in browser history, a screenshot, or a
 * `Referer` header.
 */
export async function handlePartnerAuthCallback(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  const secret = sessionSecret(env)
  if (!secret) return json(500, { error: 'PARTNER_SESSION_SECRET is not configured' })

  const token = new URL(request.url).searchParams.get('token') ?? ''
  const partnerId = await consumeLoginToken(env, token)
  if (!partnerId) {
    return json(401, {
      error: 'INVALID_LOGIN_LINK',
      message: 'This login link is invalid, already used, or expired. Ask us for a new one.',
    })
  }
  const partner = await getPartner(env, partnerId)
  if (!partner || partner.status !== 'active') {
    return json(401, { error: 'INVALID_LOGIN_LINK' })
  }

  const session = await signSession(secret, partnerId, Date.now() + SESSION_TTL_MS)
  return new Response(null, {
    status: 302,
    headers: {
      Location: PARTNER_APP_PATH,
      'Set-Cookie': sessionCookieHeader(session, SESSION_TTL_MS),
    },
  })
}

// ── POST /admin/partner/login-link ───────────────────────────────────────────

/**
 * Operator-only. Creates the account if absent and returns a login link.
 *
 * `setPassword: true` also mints a fresh password and returns it ONCE — the
 * only moment a plaintext password exists outside the operator's hands. It is
 * never stored, never logged, and cannot be retrieved again.
 */
export async function handleAdminPartnerLoginLink(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const denied = adminAuthorized(request, env)
  if (denied) return denied

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }
  const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '')
  // Deliberately loose: an operator types this by hand and a strict RFC pattern
  // would reject valid addresses. The address is an account label, not a
  // delivery target — we never send mail.
  if (!email || !isValidPartnerIdentifier(email)) {
    return json(400, { error: 'email is required' })
  }

  const partner = await getOrCreatePartnerByEmail(env, email)
  const token = await createLoginToken(env, partner.id)
  const origin = new URL(request.url).origin
  const loginUrl = `${origin}/partner/auth/callback?token=${token}`

  let password: string | undefined
  if (body?.setPassword === true) {
    password = generatePartnerPassword()
    await setPartnerPassword(env, partner.id, password)
  }

  return json(200, {
    ok: true,
    partnerId: partner.id,
    email: partner.email,
    loginUrl,
    expiresInMinutes: 15,
    username: partner.email,
    ...(password ? { password } : {}),
  })
}

// ── POST /admin/partner/api-key ──────────────────────────────────────────────

/**
 * Mint (or rotate) a partner's API key and return the plaintext ONCE.
 *
 * Admin-only, and deliberately not self-serve from `/partner/app`: a key that
 * the dashboard can mint is a key that anyone with a stolen session can mint,
 * and unlike a session an API key does not expire on its own.
 *
 * Calling this again invalidates the previous key. The plaintext is returned
 * here and nowhere else — it is not stored, not logged, and never rendered
 * into the dashboard HTML.
 */
export async function handleAdminPartnerApiKey(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const denied = adminAuthorized(request, env)
  if (denied) return denied

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }
  const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '')
  if (!email || !isValidPartnerIdentifier(email)) {
    return json(400, { error: 'email is required' })
  }

  // Must already exist. Unlike the login-link path this does not create an
  // account: a typo here would otherwise mint a key for an empty partner and
  // report success, and the operator would ship that key to a human.
  const partnerId = await getPartnerIdByEmail(env, email)
  const partner = partnerId ? await getPartner(env, partnerId) : null
  if (!partner) return json(404, { error: 'PARTNER_NOT_FOUND' })

  const rotated = Boolean(partner.apiKeyHash)
  const apiKey = await setPartnerApiKey(env, partner.id)

  return json(200, {
    ok: true,
    partnerId: partner.id,
    email: partner.email,
    apiKey,
    rotated,
    note: 'Shown once. Store it now — any previous key has stopped working.',
  })
}
