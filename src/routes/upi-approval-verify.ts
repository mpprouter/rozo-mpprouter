// Merchant approval check for the UPI rewards path (verified-funding v2).
//
// Zero-cash / credit-funded settlement is only allowed for an exact invoice a
// human approved in MuggleLink (design §6 "OpenRouter 归属不能只看名称"). The
// Router never trusts the approval id it was handed: right before claiming and
// again right before executing it asks MuggleLink, server to server:
//
//   POST {UPI_MUGGLELINK_BASE_URL}/api/internal/rewards/verify-invoice-approval
//   X-Internal-Key: UPI_INTERNAL_KEY
//   X-Timestamp:    unix seconds
//   X-Nonce:        32 lowercase hex chars, fresh per request (retries too)
//   X-Signature:    hex HMAC-SHA256(UPI_INTERNAL_KEY,
//                     "approval-verify:v1\nPOST\n<path>\n<ts>\n<nonce>\n<rawBody>")
//   body {approval_id, provider, invoice_key, fingerprint_version,
//         fingerprint, base_minor, expires_at}
//   200  {approval_id, approved, reason, valid_until}
//
// The purpose prefix keeps this signature from ever verifying as a
// verified-funding body signature (that one is HMAC over the raw body only).
//
// Outcomes are three-valued on purpose:
//   approved     → may proceed
//   refused      → MuggleLink explicitly said no (persistent refusal barrier)
//   unavailable  → anything else: timeout, network, 401, 5xx, bad JSON, a
//                  response for a different approval id. The order stays
//                  queued (eligibility_unavailable); nothing executes and
//                  nothing is released.

import type { Env } from '../index'
import { hmacSha256Hex } from './upi-invoice'

export const APPROVAL_VERIFY_PATH = '/api/internal/rewards/verify-invoice-approval'
export const APPROVAL_VERIFY_PURPOSE = 'approval-verify:v1'
// Network deadline for one verification call. Not a business window: a
// timeout only keeps the order queued for a later retry.
const APPROVAL_VERIFY_TIMEOUT_MS = 10_000

export interface ApprovalVerifyRequest {
  approval_id: string
  provider: 'coinbase_v1' | 'coinbase_v3'
  invoice_key: string
  fingerprint_version: 'upi-reward-binding-v1'
  fingerprint: string
  base_minor: number
  expires_at: string | null
}

export type ApprovalVerifyResult =
  | { kind: 'approved'; approvalId: string; validUntil: string | null }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable'; detail: string }

const REASONS = new Set(['ok', 'not_found', 'revoked', 'expired', 'mismatch'])

export function approvalSigningString(timestamp: string, nonce: string, rawBody: string): string {
  return [APPROVAL_VERIFY_PURPOSE, 'POST', APPROVAL_VERIFY_PATH, timestamp, nonce, rawBody].join('\n')
}

function randomNonce(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function baseUrl(env: Env): string | null {
  const raw = env.UPI_MUGGLELINK_BASE_URL
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

export async function verifyInvoiceApproval(
  env: Env,
  req: ApprovalVerifyRequest,
  nowMs: number = Date.now(),
): Promise<ApprovalVerifyResult> {
  const secret = env.UPI_INTERNAL_KEY
  const origin = baseUrl(env)
  if (!secret || secret.length < 16 || !origin) {
    return { kind: 'unavailable', detail: 'approval verification is not configured' }
  }
  const rawBody = JSON.stringify(req)
  const timestamp = String(Math.floor(nowMs / 1000))
  const nonce = randomNonce()
  const signature = await hmacSha256Hex(secret, approvalSigningString(timestamp, nonce, rawBody))

  let res: Response
  try {
    res = await fetch(origin + APPROVAL_VERIFY_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': secret,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(APPROVAL_VERIFY_TIMEOUT_MS),
    })
  } catch {
    return { kind: 'unavailable', detail: 'approval verification unreachable' }
  }
  if (res.status !== 200) {
    // 401 (signature/replay/window) and 5xx alike: never read as a refusal.
    return { kind: 'unavailable', detail: `approval verification status ${res.status}` }
  }
  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    return { kind: 'unavailable', detail: 'approval verification returned non-JSON' }
  }
  if (!body || typeof body !== 'object' || body.approval_id !== req.approval_id || typeof body.approved !== 'boolean') {
    return { kind: 'unavailable', detail: 'approval verification response does not match the request' }
  }
  const reason = typeof body.reason === 'string' && REASONS.has(body.reason) ? body.reason : 'unknown'
  if (!body.approved) {
    return { kind: 'refused', reason: `merchant_not_approved:${reason}` }
  }
  const validUntil = typeof body.valid_until === 'string' ? body.valid_until : null
  if (validUntil !== null) {
    const ms = Date.parse(validUntil)
    if (!Number.isFinite(ms)) {
      return { kind: 'unavailable', detail: 'approval valid_until is unparseable' }
    }
    if (ms <= nowMs) return { kind: 'refused', reason: 'merchant_not_approved:expired' }
  }
  return { kind: 'approved', approvalId: req.approval_id, validUntil }
}
