/**
 * Partner coupon listing and voiding — thin routes over partner-store.ts.
 *
 * Design: ainative `todos/20260807-coupon-reseller-platform.md` §3.5 / §3.10.
 *
 * Endpoints: `GET /partner/coupons`, `POST /partner/coupon/:code/void`.
 *
 * All refund logic lives in `voidPartnerCoupon`. This file supplies the second
 * factor, the audit record, and the response shape.
 *
 * ## Two independent guards on voiding, and why both are needed
 *
 * 1. **The status gate (in the store).** Only an `issued` coupon may be
 *    refunded. `redeeming` has a redemption in flight; `paying`/`redeemed` mean
 *    the money already left our funder pool. A pre-existing `status === 'void'`
 *    proves nothing, because the admin resolve path can stamp `void` onto a
 *    `paying` record — so the store keys the refund on a `refundOpId` it wrote
 *    itself. None of that is re-implemented here.
 *
 * 2. **The typed confirmation (here).** The caller must type the coupon's last
 *    4 digits. This defends against a mis-click, nothing else. It is NOT a
 *    substitute for the status gate: a partner can type the digits perfectly
 *    and still be asking to refund a coupon we already paid for. Conversely the
 *    status gate does not stop a fat finger. Different failures, both real.
 *
 * ## Audit
 *
 * Every void ATTEMPT is recorded on the coupon's event chain — including
 * refusals, which is where a dispute usually lands. Per the redaction
 * invariant, the client IP is stored only as a keyed digest of its /24 (or
 * /48) network prefix; the full address is never written.
 */

import type { Env } from '../index'
import { CODE_RE } from './coupon'
import { formatUsdc } from './create-invoice'
import { identifierKeys } from '../utils/redact'
import {
  PartnerError,
  appendCouponAuditEvent,
  listPartnerCoupons,
  readPartnerCoupon,
  voidPartnerCoupon,
} from './partner-store'
import { requirePartnerSession } from './partner-auth'

/** Newest-first, no pagination and no filters (§3.10). */
const LIST_LIMIT = 200

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function partnerErrorResponse(err: PartnerError): Response {
  const status =
    err.code === 'COUPON_NOT_FOUND' || err.code === 'NOT_YOUR_COUPON'
      ? 404
      : err.code === 'COUPON_NOT_REFUNDABLE'
        ? 409
        : err.code === 'TOO_MANY_PENDING'
          ? 409
          : err.code === 'PARTNER_SUSPENDED'
            ? 403
            : 500
  return json(status, { error: err.code, message: err.message })
}

/**
 * Build the audit envelope. The timestamp is OURS: a client-supplied time is
 * exactly the field someone would want to alter after the fact.
 */
async function buildAudit(
  request: Request,
  env: Env,
  partnerId: string,
  confirmInput: string,
  statusBefore: string,
): Promise<Record<string, unknown>> {
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null

  // Digest requires the server-only key. Without it we record NOTHING about
  // the IP rather than degrade to a plaintext prefix — a coarse plaintext
  // network address in a long-lived record still identifies a household, and
  // the redaction invariant does not have a fallback mode.
  let ipPrefixHash: string | null = null
  if (env.COUPON_HASH_SECRET) {
    try {
      ipPrefixHash = (await identifierKeys(env.COUPON_HASH_SECRET, { ip })).ipPrefix
    } catch {
      ipPrefixHash = null
    }
  }

  return {
    at: new Date().toISOString(),
    partnerId,
    ipPrefixHash,
    userAgent: (request.headers.get('user-agent') ?? '').slice(0, 200) || null,
    confirmInput,
    statusBefore,
  }
}

// ── GET /partner/coupons ─────────────────────────────────────────────────────

/**
 * The session partner's own coupons, newest first. `listPartnerCoupons` runs
 * the reconcile pass first, so a listing never shows a half-settled issue.
 *
 * Scoping is structural: the partner id comes from the signed cookie and the
 * store reads only that partner's index, so there is no query parameter to
 * forget to validate.
 */
export async function handlePartnerListCoupons(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' })
  const session = await requirePartnerSession(request, env)
  if (!session.ok) return session.response

  const coupons = await listPartnerCoupons(env, session.partnerId, LIST_LIMIT)
  return json(200, {
    ok: true,
    count: coupons.length,
    coupons: coupons.map((c) => ({
      code: c.code,
      amountUsd: c.amountUsd,
      // Face value / 1.05, floored — the display figure only, never money.
      credits: ((BigInt(parseAtomic(c.amountUsd)) * 20n) / 21n / 1_000_000n).toString(),
      status: c.status,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
      refundable: c.refundable,
      claimUrl: `https://open.rozo.ai/claim?code=${c.code}`,
    })),
  })
}

/** Decimal USD string -> atomic. Local to avoid importing the whole invoice
 * module's parser for one display field. */
function parseAtomic(usd: string): string {
  const m = usd.match(/^(\d+)(?:\.(\d+))?$/)
  if (!m) return '0'
  const frac = (m[2] ?? '').padEnd(6, '0').slice(0, 6)
  return (BigInt(m[1]) * 1_000_000n + BigInt(frac)).toString()
}

// ── POST /partner/coupon/:code/void ──────────────────────────────────────────

/**
 * Void (or reclaim an expired coupon) and refund its face value.
 *
 * One endpoint covers both: the eligibility rule, the idempotency key and the
 * refunded amount are identical, and only the expiry timestamp differs. Two
 * endpoints would be two code paths that must never disagree.
 *
 * `code` is passed in by the router rather than re-parsed from the URL here, so
 * this stays independent of how T4 chooses to match the path.
 */
export async function handlePartnerVoidCoupon(
  request: Request,
  env: Env,
  code: string,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  const session = await requirePartnerSession(request, env)
  if (!session.ok) return session.response

  const trimmed = (code ?? '').trim()
  if (!CODE_RE.test(trimmed)) return json(400, { error: 'code must be 8 or 10 digits' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }
  const confirm = typeof body?.confirm === 'string' ? body.confirm.trim() : ''

  // Tenant scope first. Returns null for both "no such coupon" and "someone
  // else's coupon", so this cannot be used to probe another partner's codes.
  const record = await readPartnerCoupon(env, session.partnerId, trimmed)
  if (!record) return json(404, { error: 'COUPON_NOT_FOUND', message: 'no such coupon' })

  const statusBefore = record.status
  const audit = await buildAudit(request, env, session.partnerId, confirm, statusBefore)

  // Second factor: the last 4 digits, typed. Checked after the ownership read
  // so the audit entry can carry the real prior status.
  if (confirm !== trimmed.slice(-4)) {
    await appendCouponAuditEvent(env, session.partnerId, trimmed, 'partner_void_rejected', {
      ...audit,
      result: 'bad_confirm',
    })
    return json(400, {
      error: 'CONFIRM_MISMATCH',
      message: 'Type the last 4 digits of the code to confirm.',
    })
  }

  // Expired-but-unused coupons are a reclaim; the money movement is identical,
  // only the ledger label differs.
  const expired = record.status === 'issued' && Date.parse(record.expiresAt) < Date.now()

  try {
    const result = await voidPartnerCoupon(env, {
      partnerId: session.partnerId,
      code: trimmed,
      kind: expired ? 'expire_refund' : 'void_refund',
      audit: { ...audit, result: 'ok' },
    })
    return json(200, {
      ok: true,
      code: trimmed,
      kind: expired ? 'expire_refund' : 'void_refund',
      refundedUsd: formatUsdc(BigInt(result.refundedAtomic)),
      balanceAfterUsd: formatUsdc(BigInt(result.balanceAfterAtomic)),
      balanceAfterAtomic: result.balanceAfterAtomic,
    })
  } catch (err) {
    if (err instanceof PartnerError) {
      await appendCouponAuditEvent(env, session.partnerId, trimmed, 'partner_void_rejected', {
        ...audit,
        result: err.code,
      })
      if (err.code === 'COUPON_NOT_REFUNDABLE') {
        return json(409, {
          error: 'COUPON_NOT_REFUNDABLE',
          // Surfaced verbatim so the partner sees WHY, e.g. a `redeeming`
          // coupon is retryable in ~10 minutes while a `paying` one never is.
          message: `This coupon can no longer be refunded (status: ${statusBefore}). Already-used or in-flight coupons cannot be voided.`,
          statusBefore,
        })
      }
      return partnerErrorResponse(err)
    }
    throw err
  }
}
