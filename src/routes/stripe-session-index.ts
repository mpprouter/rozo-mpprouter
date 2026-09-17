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
import { casScan } from './stripe-atomic'
import { decryptCapability } from './invoice-capability-crypto'

const PREFIX = 'stripe-session-index:'
const TTL_S = 60 * 60 * 24 * 90 // 90 days; a status lookup this old is not useful

async function blobHash(blob: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(blob))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Remember that `payUrl` resolved to `invoiceKey`. Best effort; never throws. */
export async function indexStripeSession(env: Env, payUrl: string, invoiceKey: string): Promise<void> {
  try {
    const blob = extractStripeSessionBlob(payUrl)
    if (!blob || !invoiceKey.startsWith('cpis_')) return
    await env.MPP_STORE.put(PREFIX + (await blobHash(blob)), invoiceKey, { expirationTtl: TTL_S })
  } catch {
    // index is an optimisation for the expired path; never block the caller
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

// Records written before this index existed are not in it. On a miss, walk
// the fulfillment records (a few dozen; bounded), decrypt each stored
// capability IN MEMORY and compare blob hashes. No Stripe call; the decrypted
// URL never leaves this function. A hit is indexed so the walk happens once.
const BACKFILL_MAX_RECORDS = 500

export async function lookupStripeSessionWithBackfill(env: Env, payUrl: string): Promise<string | null> {
  const hit = await lookupStripeSession(env, payUrl)
  if (hit) return hit
  try {
    const blob = extractStripeSessionBlob(payUrl)
    if (!blob) return null
    const values = (await casScan(env, 'invoice-fulfillment:v2:stripe_crypto:')).slice(0, BACKFILL_MAX_RECORDS)
    for (const raw of values) {
      let rec: { invoiceKey?: unknown; stripeUrlEncrypted?: unknown }
      try {
        rec = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof rec.invoiceKey !== 'string' || typeof rec.stripeUrlEncrypted !== 'string') continue
      let stored: string
      try {
        stored = await decryptCapability(rec.stripeUrlEncrypted, env)
      } catch {
        continue
      }
      if (extractStripeSessionBlob(stored) === blob) {
        await indexStripeSession(env, payUrl, rec.invoiceKey)
        return rec.invoiceKey
      }
    }
  } catch {
    // best effort
  }
  return null
}
