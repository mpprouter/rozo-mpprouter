/**
 * Partner self-serve issuance — thin routes over partner-store.ts.
 *
 * Design: ainative `todos/20260807-coupon-reseller-platform.md` §3.2 / §3.10.
 *
 * Endpoints: `GET /partner/me`, `POST /partner/coupon/issue`,
 * `POST /admin/partner/topup`.
 *
 * Everything that moves money lives in partner-store. This file validates
 * input, converts units, and shapes responses. If a change here ever needs to
 * read or write `balanceAtomic`, the change belongs in the store instead.
 *
 * ## Units — the thing most likely to be got wrong
 *
 *   credits    what the end customer is buying (OpenRouter credits)
 *   face value USD on the coupon; MUST equal the customer's payment link to the
 *              cent, or redemption is refused
 *   balance    USD, prepaid by the partner — the only number we store
 *
 * `1 credit = $1.05`. The 5% is OpenRouter's crypto surcharge passed straight
 * through; Rozo takes no margin. Balances are held in USD rather than credits
 * so that adding a second product line later is a new SKU rather than an
 * account-ledger migration.
 *
 * The conversion is done in **bigint atomic units (6dp)**. Floats are banned on
 * this path: `50 * 1.05` is 52.500000000000007 in IEEE-754, and a face value
 * one micro-dollar off its payment link is a coupon that cannot be redeemed.
 */

import type { Env } from '../index'
import { formatUsdc, parseUsdc } from './create-invoice'
import {
  PartnerError,
  getPartner,
  issuePartnerCoupon,
  readLedger,
  reconcilePending,
  topupPartner,
  isValidPartnerIdentifier,} from './partner-store'
import { requirePartnerSession } from './partner-auth'

// ── Tunables ─────────────────────────────────────────────────────────────────

/** 1 credit = $1.05, as an exact rational. Never a float. */
const CREDIT_NUMERATOR = 21n
const CREDIT_DENOMINATOR = 20n

/**
 * Mirrors `MAX_FACE_VALUE_ATOMIC` in coupon.ts ($1050). Duplicated rather than
 * imported because that constant is not exported and route registration (T4) is
 * the only task permitted to touch shared files this round. The store enforces
 * nothing about this cap — the coupon path does — so validating here just buys
 * a clean 400 instead of a late failure.
 *
 * TODO(T4): export the constant from coupon.ts and import it here so the two
 * cannot drift.
 */
const MAX_FACE_VALUE_ATOMIC = 1_050_000_000n

/** Minimum issuance: 1 credit (§3.2). */
const MIN_CREDITS_ATOMIC = 1_000_000n

/**
 * 14 days (founder 2026-08-07). Partners resell to end customers who may sit
 * on a code for a week or more, and a code that dies before the buyer gets to
 * it turns into a support ticket for us.
 *
 * This is only defensible now that codes are 10 digits. Expiry is what caps
 * how many coupons are live at once, and the brute-force hit rate scales
 * linearly with that: at ~140 live coupons a 14-day window is ~0.24% against
 * 10^10, but would have been ~24% against the old 10^8 space. Do NOT raise
 * this further without redoing that arithmetic — see ainative
 * todos/20260807-coupon-reseller-platform.md §9.2.
 */
const DEFAULT_EXPIRES_MINUTES = 60 * 24 * 14
const MAX_EXPIRES_MINUTES = 60 * 24 * 14 // same as the default; shorter is allowed

const MAX_LEDGER_ROWS = 50

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Map a store-level failure onto HTTP. `INSUFFICIENT_BALANCE` is 402 by
 * product decision (§3.2) — and the store guarantees no coupon was created,
 * because the balance check happens inside the debit CAS.
 */
function partnerErrorResponse(err: PartnerError): Response {
  const status =
    err.code === 'INSUFFICIENT_BALANCE'
      ? 402
      : err.code === 'PARTNER_SUSPENDED'
        ? 403
        : err.code === 'PARTNER_NOT_FOUND' || err.code === 'COUPON_NOT_FOUND'
          ? 404
          : err.code === 'NOT_YOUR_COUPON'
            ? 404 // never confirm that someone else's code exists
            : err.code === 'INVALID_AMOUNT'
              ? 400
              : err.code === 'ISSUE_IN_FLIGHT' || err.code === 'TOO_MANY_PENDING'
                ? 409
                : 500
  return json(status, { error: err.code, message: err.message })
}

// ── Unit conversion ──────────────────────────────────────────────────────────

export interface AmountResolution {
  amountAtomic: bigint
  /** Decimal credits string when the caller came in through the credits entry
   * point, null for the direct-USD entry point. */
  credits: string | null
}

/**
 * Resolve `{ credits }` or `{ amountUsd }` into an exact atomic face value.
 *
 * Rejects a credits amount whose face value is not a whole micro-dollar
 * (`creditsAtomic × 21 / 20` must divide exactly). Rounding instead would make
 * the coupon's face value differ from what the confirmation dialog promised,
 * and the customer's payment link has to match to the cent.
 */
export function resolveAmount(body: any): AmountResolution | { error: string } {
  const hasCredits = body?.credits !== undefined && body?.credits !== null && body?.credits !== ''
  const hasUsd = body?.amountUsd !== undefined && body?.amountUsd !== null && body?.amountUsd !== ''

  if (hasCredits && hasUsd) {
    return { error: 'provide either credits or amountUsd, not both' }
  }
  if (!hasCredits && !hasUsd) {
    return { error: 'credits or amountUsd is required' }
  }

  if (hasCredits) {
    const raw = typeof body.credits === 'number' ? body.credits.toString() : String(body.credits).trim()
    let creditsAtomic: bigint
    try {
      creditsAtomic = parseUsdc(raw)
    } catch {
      return { error: 'credits must be a positive decimal number, e.g. "50"' }
    }
    if (creditsAtomic < MIN_CREDITS_ATOMIC) return { error: 'minimum is 1 credit' }
    const scaled = creditsAtomic * CREDIT_NUMERATOR
    if (scaled % CREDIT_DENOMINATOR !== 0n) {
      return {
        error: 'credits amount does not convert to a whole face value; use a coarser amount',
      }
    }
    return { amountAtomic: scaled / CREDIT_DENOMINATOR, credits: formatUsdc(creditsAtomic) }
  }

  // Advanced entry: the customer often sends a non-standard payment link
  // ($10.50, $7.35) and the coupon must match it exactly, so a USD amount can
  // be given directly.
  const raw =
    typeof body.amountUsd === 'number' ? body.amountUsd.toString() : String(body.amountUsd).trim()
  let amountAtomic: bigint
  try {
    amountAtomic = parseUsdc(raw)
  } catch {
    return { error: 'amountUsd must be a decimal USD amount, e.g. "52.50"' }
  }
  // The floor is expressed in credits (§3.2), so the equivalent USD floor is
  // 1 credit of face value. Otherwise this entry point would quietly bypass it.
  if (amountAtomic < (MIN_CREDITS_ATOMIC * CREDIT_NUMERATOR) / CREDIT_DENOMINATOR) {
    return { error: 'minimum is 1 credit ($1.05)' }
  }
  return { amountAtomic, credits: null }
}

/**
 * A face value must land on a whole cent.
 *
 * The coupon only redeems if the customer's OpenRouter payment link is for
 * EXACTLY this amount, and no payment UI lets anyone enter $1.05525. A
 * sub-cent face is therefore a coupon that was paid for and can never be
 * spent. The money is recoverable by voiding it, so this is not a loss — it
 * is a support ticket, which is worse per hour of our time.
 *
 * Reachable from both entry points: `credits: 1.005` survives the ×21/20
 * conversion, and the direct amountUsd path accepts 6dp because parseUsdc does.
 */
function wholeCents(amountAtomic: bigint): boolean {
  return amountAtomic % 10_000n === 0n
}

// ── GET /partner/me ──────────────────────────────────────────────────────────

/** Balance + recent ledger for the SESSION's partner. No id is accepted from
 * the caller anywhere in this file. */
export async function handlePartnerMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  const session = await requirePartnerSession(request, env)
  if (!session.ok) return session.response

  // Repair first, so the balance shown is never a mid-flight number.
  await reconcilePending(env, session.partnerId)
  const partner = await getPartner(env, session.partnerId)
  if (!partner) return json(404, { error: 'PARTNER_NOT_FOUND' })
  const ledger = await readLedger(env, session.partnerId, MAX_LEDGER_ROWS)

  const balanceAtomic = BigInt(partner.balanceAtomic)
  return json(200, {
    ok: true,
    partnerId: partner.id,
    email: partner.email,
    status: partner.status,
    balanceUsd: formatUsdc(balanceAtomic),
    balanceAtomic: partner.balanceAtomic,
    // "You can still issue about N credits." Floor, never rounded up: this line
    // is a promise, and a rounded-up number leads straight to a 402.
    issuableCredits: ((balanceAtomic * CREDIT_DENOMINATOR) / CREDIT_NUMERATOR / 1_000_000n).toString(),
    ledger: ledger.map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      deltaUsd: formatUsdc(BigInt(e.deltaAtomic)),
      balanceAfterUsd: e.balanceAfterAtomic ? formatUsdc(BigInt(e.balanceAfterAtomic)) : null,
      ref: e.ref,
    })),
  })
}

// ── POST /partner/coupon/issue ───────────────────────────────────────────────

/**
 * Issue a coupon against the session partner's balance.
 *
 * `clientKey` is REQUIRED and supplied by the caller. Without a stable key, a
 * submitted request whose response is lost becomes a second debit when the user
 * clicks again — the store's idempotency is only as good as the key it is
 * handed, so this endpoint refuses to make one up.
 */
export async function handlePartnerIssueCoupon(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const session = await requirePartnerSession(request, env)
  if (!session.ok) return session.response

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const clientKey = typeof body?.clientKey === 'string' ? body.clientKey.trim() : ''
  if (!clientKey || clientKey.length > 128) {
    return json(400, {
      error: 'clientKey is required (a caller-generated idempotency key, ≤128 chars)',
    })
  }

  const resolved = resolveAmount(body)
  if ('error' in resolved) return json(400, { error: resolved.error })
  if (resolved.amountAtomic > MAX_FACE_VALUE_ATOMIC) {
    return json(400, {
      error: `face value exceeds the ${formatUsdc(MAX_FACE_VALUE_ATOMIC)} USD per-coupon cap`,
    })
  }

  // Accept BOTH spellings. The dashboard shipped `expiresMinutes` while this
  // handler read `expiresInMinutes`, so every custom expiry was silently
  // dropped to the 12h default with no error — the worst kind of bug, because
  // the UI looked like it worked. The UI now sends the canonical name; this
  // keeps the alias so an older cached page does not regress.
  const expiresRaw = body?.expiresInMinutes ?? body?.expiresMinutes
  const expiresInMinutes =
    typeof expiresRaw === 'number' && expiresRaw > 0
      ? Math.min(Math.floor(expiresRaw), MAX_EXPIRES_MINUTES)
      : DEFAULT_EXPIRES_MINUTES
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null

  if (!wholeCents(resolved.amountAtomic)) {
    return json(400, {
      error:
        'face value must be a whole number of cents — the customer cannot create a payment link for a fraction of a cent',
      amountUsd: formatUsdc(resolved.amountAtomic),
    })
  }

  try {
    const result = await issuePartnerCoupon(env, {
      partnerId: session.partnerId,
      amountAtomic: resolved.amountAtomic,
      credits: resolved.credits,
      expiresInMinutes,
      note,
      clientKey,
    })
    return json(200, {
      ok: true,
      code: result.code,
      // Same public claim domain the admin issuance path hands out.
      claimUrl: `https://open.rozo.ai/claim?code=${result.code}`,
      amountUsd: result.amountUsd,
      credits: resolved.credits,
      expiresAt: result.expiresAt,
      balanceAfterUsd: formatUsdc(BigInt(result.balanceAfterAtomic)),
      balanceAfterAtomic: result.balanceAfterAtomic,
      // True when this was a replay of an already-satisfied clientKey: the same
      // coupon comes back and no money moved.
      reused: result.reused,
    })
  } catch (err) {
    if (err instanceof PartnerError) return partnerErrorResponse(err)
    throw err
  }
}

// ── POST /admin/partner/topup ────────────────────────────────────────────────

/**
 * Operator-only credit. `proof` (the transfer reference the operator already
 * has to type) doubles as the idempotency key inside the store: a manual
 * top-up has the same ambiguous-commit hazard as an automated one — the write
 * lands, the response is lost, the operator retries — and without a key that
 * credits the balance twice.
 */
export async function handleAdminPartnerTopup(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!env.ADMIN_TOKEN) return json(500, { error: 'ADMIN_TOKEN is not configured' })
  const secret = request.headers.get('x-admin-secret')?.trim()
  if (!secret || secret !== env.ADMIN_TOKEN) return json(401, { error: 'Unauthorized' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!email || !isValidPartnerIdentifier(email)) {
    return json(400, { error: 'email is required (a username or an email address)' })
  }

  const proof = typeof body?.proof === 'string' ? body.proof.trim() : ''
  if (!proof) {
    return json(400, {
      error: 'proof is required — it is also the idempotency key for this credit',
    })
  }

  const rawAmount =
    typeof body?.amountUsd === 'number' ? body.amountUsd.toString() : String(body?.amountUsd ?? '').trim()
  let amountAtomic: bigint
  try {
    amountAtomic = parseUsdc(rawAmount)
  } catch {
    return json(400, { error: 'amountUsd must be a decimal USD amount, e.g. "100" or "5.50"' })
  }
  // No minimum by product decision (§3.7) — $1 top-ups are expected.
  if (amountAtomic <= 0n) return json(400, { error: 'amountUsd must be > 0' })

  const sourceAddress = typeof body?.sourceAddress === 'string' ? body.sourceAddress.trim() : null
  const operator = typeof body?.operator === 'string' ? body.operator.trim() : 'admin'

  try {
    const { partner, applied } = await topupPartner(env, {
      email,
      amountAtomic,
      proof,
      sourceAddress,
      operator,
    })
    return json(200, {
      ok: true,
      partnerId: partner.id,
      email: partner.email,
      // false => this proof had already been credited; the balance below is the
      // existing one and nothing moved.
      applied,
      balanceAfterUsd: formatUsdc(BigInt(partner.balanceAtomic)),
      balanceAfterAtomic: partner.balanceAtomic,
    })
  } catch (err) {
    if (err instanceof PartnerError) return partnerErrorResponse(err)
    throw err
  }
}
