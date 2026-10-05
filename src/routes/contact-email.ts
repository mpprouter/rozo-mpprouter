/**
 * Optional payer contact email on create-invoice.
 *
 * The public create-invoice route is keyless, so an order created from the
 * CLI/skill has had no way to reach the payer when something goes wrong
 * (intents_payments.user_email stayed null). Callers may now send a top-level
 * `email`; we normalize it and forward it as the payment-api `email` field,
 * which payment-api stores as user_email (it re-validates with the same 254
 * cap). The field stays optional and backward compatible:
 *
 *   absent / null / ""  -> no email (old callers unchanged)
 *   valid string        -> trimmed, lowercased, forwarded
 *   anything else       -> 400 INVALID_EMAIL (never silently dropped, so a
 *                          user who typed a bad address learns about it)
 *
 * The address is PII: it is never logged and never echoed back in responses.
 * It is applied on CREATE only; an existing unpaid order reused for the same
 * invoice keeps whatever email it was created with (binding an email to an
 * existing order from a keyless route would let anyone holding the invoice
 * link attach their address to someone else's order).
 */

export const CONTACT_EMAIL_MAX_LENGTH = 254

// Deliberately simple: one @, non-empty local part, a dotted domain, no
// whitespace. Real deliverability is not checkable here.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

export type ContactEmailResult =
  | { ok: true; email: string | null }
  | { ok: false; message: string }

export function normalizeContactEmail(raw: unknown): ContactEmailResult {
  if (raw === undefined || raw === null) return { ok: true, email: null }
  if (typeof raw !== 'string') {
    return { ok: false, message: 'email must be a string when provided.' }
  }
  const email = raw.trim().toLowerCase()
  if (email.length === 0) return { ok: true, email: null }
  if (email.length > CONTACT_EMAIL_MAX_LENGTH) {
    return { ok: false, message: `email must be at most ${CONTACT_EMAIL_MAX_LENGTH} characters.` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(email) || !EMAIL_RE.test(email)) {
    return { ok: false, message: 'email is not a valid email address (expected name@example.com).' }
  }
  return { ok: true, email }
}

