/**
 * Optional browser device id on order-creating calls.
 *
 * checkout.rozo.ai keeps a random UUID in localStorage (`rozo:deviceId`).
 * When a create call carries it as a top-level `deviceId`, we forward it to
 * the payment-api create body under the same name. payment-api strips it from
 * the stored order, hashes it and writes a payer_order_links row with
 * linked_via = 'create' (rozo-intents-api shared/payer-memory-link.ts). That
 * row is the proof that this browser created the order (duplicate-payment
 * phase 2, ainative docs/design/20261114-duplicate-payment-auto-handling-design.zh.md
 * section 3.2).
 *
 *   absent / not a string / not a UUID  -> {} (the create body is unchanged;
 *                                          a bad value never fails the order)
 *   well-formed UUID                    -> { deviceId: <lowercase UUID> }
 *
 * Only the raw UUID is accepted, never a precomputed 64-hex deviceKey: the
 * proof is "the browser that holds the id", not "anyone who knows the hash".
 * The format matches payment-api's deviceKeyFromId (trim, lowercase, then a
 * lowercase 8-4-4-4-12 hex UUID), so a value we forward is one it links.
 *
 * The id identifies a device: it is never logged, never stored in router KV,
 * never put in analytics, error messages or responses. It is sent on CREATE
 * only; a reused existing order is never re-linked from this keyless route.
 */

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A UUID is 36 characters; anything much longer is not one. Checked before
// trimming so an oversized string is never copied or scanned.
const DEVICE_ID_MAX_RAW_LENGTH = 64

/** The normalized device id from a parsed request body, or null. Never throws. */
export function readDeviceId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = (parsed as Record<string, unknown>).deviceId
  if (typeof raw !== 'string' || raw.length > DEVICE_ID_MAX_RAW_LENGTH) return null
  const id = raw.trim().toLowerCase()
  return DEVICE_ID_RE.test(id) ? id : null
}

/** Spread into a payment-api create body: `{ deviceId }` or `{}`. */
export function deviceIdField(deviceId: string | null | undefined): { deviceId?: string } {
  return deviceId ? { deviceId } : {}
}
