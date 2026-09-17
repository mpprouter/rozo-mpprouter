// Stripe pay-URL → session id index (read-only status recovery).
//
// Stripe stops resuming a Payin Session some time after it completes
// (resume_payin_session 410). A customer reopening a paid link then gets a bare
// "expired" from invoice-details and cannot reach invoice-status, because the
// only id they hold is the /pay/<blob> capability and the cpis_* id lived
// inside Stripe's answer. This index remembers sha256(blob) → cpis_* whenever
// a session DID resolve, so the expired path can still name the invoice and
// its router state. The blob itself (a replayable capability) is never
// stored; only its hash is the key.

import type { Env } from '../index'
import { extractStripeSessionBlob } from './pay-invoice-admin'

const PREFIX = 'stripe-session-index:'
const TTL_S = 60 * 60 * 24 * 90 // 90 days; a status lookup this old is not useful

async function blobHash(blob: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(blob))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Remember that `payUrl` resolved to `invoiceKey`. Never throws; returns true
 * only when the KV write was confirmed, so callers may set a "done" marker.
 */
export async function indexStripeSession(env: Env, payUrl: string, invoiceKey: string): Promise<boolean> {
  try {
    const blob = extractStripeSessionBlob(payUrl)
    if (!blob || !invoiceKey.startsWith('cpis_')) return false
    await env.MPP_STORE.put(PREFIX + (await blobHash(blob)), invoiceKey, { expirationTtl: TTL_S })
    return true
  } catch {
    // index is an optimisation for the expired path; never block the caller
    return false
  }
}

/** Recover the cpis_* id a pay URL resolved to earlier, or null. Never throws. */
export async function lookupStripeSession(env: Env, payUrl: string): Promise<string | null> {
  try {
    const blob = extractStripeSessionBlob(payUrl)
    if (!blob) return null
    const v = await env.MPP_STORE.get(PREFIX + (await blobHash(blob)))
    return typeof v === 'string' && v.startsWith('cpis_') ? v : null
  } catch {
    return null
  }
}

// Records written before this index existed are not in it. They are indexed
// OFFLINE by the 2-minute cron (see sweepStripeSessionIndex below): each
// record's stored capability is decrypted once, in memory, hashed, indexed,
// and the record is marked so it is never decrypted for this purpose again.
// The public invoice-details path only ever does the KV lookup above, so an
// unauthenticated caller can never trigger a store walk (codex P1, #185).
