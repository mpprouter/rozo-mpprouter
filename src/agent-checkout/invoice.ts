/**
 * Agent Checkout invoice normalization and trusted snapshot (PR-5).
 *
 * A spend request never trusts the amount, merchant or fee the caller sends
 * for a Coinbase invoice: the snapshot is built from this Worker's own quote
 * (handleQuoteInvoice, which reads Coinbase through agentapi and signs a quote
 * receipt). Bitrefill has no trusted read yet (PR-8 is deferred), so its
 * snapshot carries the caller's fields with merchantVerified and
 * beneficiaryVerified false, and no separate fee number (task pack R4).
 */

import type { Env } from '../index'
import {
  canonicalCoinbaseCheckoutUrl,
  extractCoinbaseCheckoutId,
  handleQuoteInvoice,
  isCoinbasePaymentSessionId,
  normalizeInvoiceUrl,
} from '../routes/pay-invoice-admin'
import { quoteIdentity, verifyQuoteReceipt } from '../routes/quote-receipt'
import { bitrefillReceiverRefusal } from '../routes/bitrefill-binding'
import { BITREFILL_MAX_REMAINING_MS, BITREFILL_MAX_USDC, BITREFILL_MIN_REMAINING_MS } from '../routes/bitrefill-invoice'

export type AcProvider = 'coinbase_payment_session' | 'coinbase_payment_link' | 'bitrefill_invoice'

export interface NormalizedAcInvoice {
  provider: AcProvider
  /** Normalized id, never the raw URL (stored in the database). */
  invoiceId: string
  /** Coinbase: canonical checkout URL handed to the quote. Never stored. */
  quoteUrl?: string
  /** Bitrefill: the caller's (unverified) payment fields. */
  bitrefill?: { address: string; amount: string; expiresAt: string }
}

export type NormalizeResult = { ok: true; invoice: NormalizedAcInvoice } | { ok: false; code: string; message: string }

const BITREFILL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/

/**
 * `invoice` is what the user pasted (URL or id). Bitrefill needs
 * `provider: "bitrefill"` plus `bitrefill: {invoiceId, address, amount, expiresAt}`,
 * the same fields create-invoice takes.
 */
export function normalizeAcInvoice(
  body: Record<string, unknown>,
  nowMs = Date.now(),
  // false on the idempotency path: a same-key retry of a request that already
  // exists must reach the replay, however little time the invoice has left.
  checkExpiry = true,
): NormalizeResult {
  if (body.provider === 'bitrefill') {
    const br = body.bitrefill
    if (!br || typeof br !== 'object' || Array.isArray(br)) {
      return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'bitrefill must be an object with invoiceId, address, amount and expiresAt.' }
    }
    const { invoiceId, address, amount, expiresAt } = br as Record<string, unknown>
    const id = typeof invoiceId === 'string' ? invoiceId.trim().toLowerCase() : ''
    if (!BITREFILL_UUID_RE.test(id)) {
      return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'bitrefill.invoiceId must be the Bitrefill invoice UUID.' }
    }
    if (typeof address !== 'string' || bitrefillReceiverRefusal(address) !== null) {
      return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'bitrefill.address is not an allowed Base address.' }
    }
    if (typeof amount !== 'string' || !AMOUNT_RE.test(amount) || Number(amount) <= 0 || Number(amount) > BITREFILL_MAX_USDC) {
      return { ok: false, code: 'INVOICE_UNSUPPORTED', message: `bitrefill.amount must be a positive USDC amount of at most ${BITREFILL_MAX_USDC}.` }
    }
    const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN
    if (!Number.isFinite(t)) {
      return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'bitrefill.expiresAt must be an ISO-8601 timestamp.' }
    }
    const remaining = t - nowMs
    if (checkExpiry && remaining < BITREFILL_MIN_REMAINING_MS) {
      return { ok: false, code: 'INVOICE_EXPIRING', message: 'The Bitrefill invoice expires in under 5 minutes.' }
    }
    if (remaining > BITREFILL_MAX_REMAINING_MS) {
      return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'bitrefill.expiresAt is more than 60 minutes away.' }
    }
    return {
      ok: true,
      invoice: {
        provider: 'bitrefill_invoice',
        invoiceId: id,
        bitrefill: { address: address.toLowerCase(), amount, expiresAt: new Date(t).toISOString() },
      },
    }
  }

  const raw = typeof body.invoice === 'string' ? body.invoice.trim() : ''
  if (!raw || raw.length > 2048) {
    return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'invoice must be a Coinbase checkout link or id.' }
  }
  const url = canonicalCoinbaseCheckoutUrl(raw) ?? normalizeInvoiceUrl(raw)
  const id = extractCoinbaseCheckoutId(url)
  if (!id) {
    return { ok: false, code: 'INVOICE_UNSUPPORTED', message: 'invoice must be a Coinbase checkout link or id.' }
  }
  return {
    ok: true,
    invoice: {
      provider: isCoinbasePaymentSessionId(id) ? 'coinbase_payment_session' : 'coinbase_payment_link',
      invoiceId: id,
      quoteUrl: id.startsWith('pl_')
        ? `https://payments.coinbase.com/payment-links/${id}`
        : `https://payments.coinbase.com/payment-sessions/${id}`,
    },
  }
}

export interface AcSnapshot {
  merchant_display: string
  merchant_verified: boolean
  beneficiary_ref: string | null
  beneficiary_verified: boolean
  invoice_amount: string
  invoice_currency: string
  fee_atomic: string | null
  total_debit_atomic: string | null
  quote_id: string | null
  quote_expires_at: string | null
  invoice_expires_at: string | null
  funding_mode: 'balance' | 'per_payment'
  line_items: unknown
  snapshot_hash: string
}

/** Why a trusted read did not produce a snapshot. */
export type SnapshotFailure =
  | { kind: 'reject'; reason: 'invoice_rejected' | 'invoice_not_payable'; code: string }
  | { kind: 'transient'; code: string }

export type SnapshotResult = { ok: true; snapshot: AcSnapshot } | { ok: false; failure: SnapshotFailure }

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Stable JSON: object keys sorted at every level. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

async function withHash(fields: Omit<AcSnapshot, 'snapshot_hash'>, provider: AcProvider, invoiceId: string): Promise<AcSnapshot> {
  return { ...fields, snapshot_hash: await sha256Hex(canonicalJson({ provider, invoice_id: invoiceId, ...fields })) }
}

/** Quote errors that mean "this invoice cannot be paid", not "try again". */
const REJECT_CODES: Record<string, 'invoice_rejected' | 'invoice_not_payable'> = {
  LINK_USED_OR_EXPIRED: 'invoice_not_payable',
  LINK_NOT_PAYABLE: 'invoice_not_payable',
  LINK_NOT_FOUND: 'invoice_rejected',
  INVALID_INPUT: 'invoice_rejected',
}

/**
 * Build the request snapshot. `fundingMode` is the caller's preference after
 * the capability gate: Bitrefill is always per_payment (task pack R5); the
 * database downgrades balance again while balance sends are off.
 */
export async function buildSnapshot(
  env: Env,
  invoice: NormalizedAcInvoice,
  fundingMode: 'balance' | 'per_payment',
  lineItems: unknown,
  quoteFn: (request: Request, env: Env) => Promise<Response> = handleQuoteInvoice,
): Promise<SnapshotResult> {
  if (invoice.provider === 'bitrefill_invoice') {
    const br = invoice.bitrefill!
    return {
      ok: true,
      snapshot: await withHash(
        {
          merchant_display: 'Bitrefill',
          merchant_verified: false,
          beneficiary_ref: br.address,
          beneficiary_verified: false,
          invoice_amount: br.amount,
          invoice_currency: 'USDC',
          fee_atomic: null,
          total_debit_atomic: null,
          quote_id: null,
          quote_expires_at: null,
          invoice_expires_at: br.expiresAt,
          funding_mode: 'per_payment',
          line_items: lineItems ?? null,
        },
        invoice.provider,
        invoice.invoiceId,
      ),
    }
  }

  const secret = env.PAYINVOICE_ADMIN_SECRET
  if (!secret) return { ok: false, failure: { kind: 'transient', code: 'QUOTE_UNAVAILABLE' } }
  let res: Response
  try {
    res = await quoteFn(
      new Request('https://internal.agent-checkout/v1/services/rozo-agent-api/quote-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: invoice.quoteUrl }),
      }),
      env,
    )
  } catch {
    return { ok: false, failure: { kind: 'transient', code: 'QUOTE_UNAVAILABLE' } }
  }
  const q = (await res.json().catch(() => null)) as any
  if (!res.ok) {
    const code = typeof q?.code === 'string' ? q.code : typeof q?.error?.code === 'string' ? q.error.code : 'QUOTE_UNAVAILABLE'
    const reason = res.status < 500 ? REJECT_CODES[code] : undefined
    return reason
      ? { ok: false, failure: { kind: 'reject', reason, code } }
      : { ok: false, failure: { kind: 'transient', code: 'QUOTE_UNAVAILABLE' } }
  }
  const receipt = typeof q?.quoteReceipt === 'string' ? q.quoteReceipt : null
  const payload = receipt ? await verifyQuoteReceipt(receipt, invoice.invoiceId, secret) : null
  const original = q?.quote?.originalAtomicUsdc
  const fee = q?.quote?.serviceFeeAtomicUsdc
  const total = q?.quote?.callerPaysAtomicUsdc
  if (
    !payload ||
    q?.linkId !== invoice.invoiceId ||
    typeof q?.original !== 'string' ||
    typeof q?.merchant !== 'string' ||
    ![original, fee, total].every((x) => typeof x === 'string' && /^[0-9]{1,18}$/.test(x)) ||
    BigInt(original) + BigInt(fee) !== BigInt(total)
  ) {
    return { ok: false, failure: { kind: 'transient', code: 'QUOTE_UNAVAILABLE' } }
  }
  const identity = await quoteIdentity(receipt!)
  if (!identity) return { ok: false, failure: { kind: 'transient', code: 'QUOTE_UNAVAILABLE' } }
  return {
    ok: true,
    snapshot: await withHash(
      {
        merchant_display: q.merchant.slice(0, 120),
        merchant_verified: true,
        beneficiary_ref: null,
        beneficiary_verified: true,
        invoice_amount: q.original,
        invoice_currency: 'USD',
        fee_atomic: fee,
        total_debit_atomic: total,
        quote_id: identity.quoteId,
        quote_expires_at: identity.quoteExpiresAt,
        invoice_expires_at: null,
        funding_mode: fundingMode,
        line_items: lineItems ?? null,
      },
      invoice.provider,
      invoice.invoiceId,
    ),
  }
}
