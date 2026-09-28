/**
 * Stuck-order Intercom tickets (customer support automation layer 1, S3).
 *
 * When the cron sweep decides a checkout order is stuck (the customer paid,
 * the merchant invoice was not settled), it already sends one DingTalk alert
 * guarded by a one-shot flag on the record. This module opens one Intercom
 * back-office ticket next to that alert, under the SAME flag, so support sees
 * the order in Intercom with the status-page link already attached.
 *
 * Contract (all enforced here, callers do not need to guard):
 *   - Never throws. A ticket is a convenience; it must never break the sweep
 *     or the DingTalk alert it rides next to.
 *   - No retries. The caller sets its dedupe flag BEFORE calling, so a failed
 *     call is logged and dropped (the DingTalk alert still covers the order).
 *     This trades a possibly missing ticket for "never a ticket storm".
 *   - Skips (logs, no request) when INTERCOM_TICKET_TOKEN, the ticket type or
 *     the contact is not configured.
 *   - The token only ever goes into the Authorization header. It is never
 *     logged, and the Intercom response body is never logged either (only the
 *     HTTP status and Intercom's machine error code).
 *   - The ticket carries order data only: order id, status, payin time, amount,
 *     chain and the public status-page link. No payer email, wallet address or
 *     other personal data. The contact is a fixed internal Intercom contact
 *     because router records hold no customer email.
 */

import type { Env } from '../index'

const INTERCOM_TICKETS_URL = 'https://api.intercom.io/tickets'
const INTERCOM_VERSION = '2.11'
const STATUS_PAGE_BASE = 'https://checkout.rozo.ai/status?id='
const TIMEOUT_MS = 8_000

export interface StuckOrderTicket {
  /** Order id shown to the customer and used for the status-page link. */
  orderId: string
  /** Provider-side reference (Coinbase pl_/paymentSession_ id, Stripe order id). */
  providerRef: string | null
  provider: 'coinbase' | 'stripe_crypto'
  /** Router state and a short human reason, e.g. "payin_seen; Coinbase ACTIVE". */
  status: string
  reason: string
  /** ISO time the customer payment was received, if known. */
  paymentReceivedAt: string | null
  /** Invoice amount in USD(C), already formatted, e.g. "10.00". */
  amountUsd: string | null
  /** Payin chain, if known (e.g. "8453" or "base"). */
  chain: string | null
}

export type TicketOutcome =
  | { kind: 'created'; ticketId: string | null }
  | { kind: 'skipped'; reason: 'no_token' | 'no_ticket_type' | 'no_contact' }
  | { kind: 'failed'; status: number | null; code: string | null }

// Logs carry a shortened id only (same habit as the sweep's alerts).
function logRef(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

export function statusPageUrl(orderId: string): string {
  return STATUS_PAGE_BASE + encodeURIComponent(orderId)
}

export function buildTicketBody(env: Env, t: StuckOrderTicket): Record<string, unknown> {
  const lines = [
    `Order: ${t.orderId}`,
    `Provider: ${t.provider}${t.providerRef ? ` (${t.providerRef})` : ''}`,
    `Status: ${t.status}`,
    `Reason: ${t.reason}`,
    `Payment received: ${t.paymentReceivedAt ?? 'unknown'}`,
    `Amount: ${t.amountUsd ? `${t.amountUsd} USD` : 'unknown'}`,
    `Chain: ${t.chain ?? 'unknown'}`,
    `Status page: ${statusPageUrl(t.orderId)}`,
    '',
    'Opened automatically by the MPP Router sweep. A DingTalk alert was sent at the same time. No automatic payment is made.',
  ]
  return {
    ticket_type_id: String(env.INTERCOM_TICKET_TYPE_ID),
    contacts: [{ id: String(env.INTERCOM_TICKET_CONTACT_ID) }],
    // Back-office ticket on an internal contact: nobody outside should be
    // emailed about it.
    skip_notifications: true,
    ticket_attributes: {
      _default_title_: `Stuck order ${t.orderId}`,
      _default_description_: lines.join('\n'),
    },
  }
}

function errorCode(body: unknown): string | null {
  const errs = (body as { errors?: Array<{ code?: unknown }> } | null)?.errors
  const code = Array.isArray(errs) ? errs[0]?.code : null
  // Machine codes only ("unauthorized", "parameter_invalid"); cap the length so
  // an unexpected body can never smuggle free text into the log.
  return typeof code === 'string' ? code.slice(0, 64) : null
}

/** Open one stuck-order ticket. Never throws; never retries. */
export async function openStuckOrderTicket(env: Env, t: StuckOrderTicket): Promise<TicketOutcome> {
  const tag = `[intercom-ticket] ${t.provider} ${logRef(t.orderId)}`
  try {
    if (!env.INTERCOM_TICKET_TOKEN) {
      console.warn(`${tag} SKIPPED (INTERCOM_TICKET_TOKEN not set)`)
      return { kind: 'skipped', reason: 'no_token' }
    }
    if (!env.INTERCOM_TICKET_TYPE_ID) {
      console.warn(`${tag} SKIPPED (INTERCOM_TICKET_TYPE_ID not set)`)
      return { kind: 'skipped', reason: 'no_ticket_type' }
    }
    if (!env.INTERCOM_TICKET_CONTACT_ID) {
      console.warn(`${tag} SKIPPED (INTERCOM_TICKET_CONTACT_ID not set)`)
      return { kind: 'skipped', reason: 'no_contact' }
    }
    const res = await fetch(INTERCOM_TICKETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.INTERCOM_TICKET_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Intercom-Version': INTERCOM_VERSION,
      },
      body: JSON.stringify(buildTicketBody(env, t)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (!res.ok) {
      const code = errorCode(body)
      console.warn(`${tag} FAILED (HTTP ${res.status}${code ? `, ${code}` : ''}); not retried`)
      return { kind: 'failed', status: res.status, code }
    }
    const b = body as { id?: unknown; ticket_id?: unknown } | null
    const ticketId = b && (typeof b.id === 'string' || typeof b.id === 'number') ? String(b.id) : null
    console.log(`${tag} created ticket ${ticketId ?? '?'}`)
    return { kind: 'created', ticketId }
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error'
    console.warn(`${tag} FAILED (${name}); not retried`)
    return { kind: 'failed', status: null, code: null }
  }
}
