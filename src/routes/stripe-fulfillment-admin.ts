// POST /admin/stripe-fulfillment/resolve — human resolution of a Stripe
// fulfillment record parked in `manual_review`.
//
// The reconciler (stripe-fulfillment.ts) parks a record in manual_review when
// the provider can no longer confirm it (e.g. Stripe stopped resuming the
// session while our settlement was in flight). A human then verifies the
// merchant credit out of band and records the outcome HERE, through the same
// DO CAS path every other transition uses — never by editing storage by hand.
//
// Constraints (all enforced):
//   - x-admin-secret (same gate as /admin/pay-invoice and /admin/seed-atomic-store)
//   - only `manual_review` records can be resolved (monotonic: `paid` is
//     terminal, and an in-flight record must go through the reconciler)
//   - resolution `paid` requires an evidence string and the on-chain tx hash
//     of the settlement; both are stored on the record with who/when
//   - resolution `failed_provider` requires evidence only
//   - idempotent: re-posting the same resolution to an already-resolved
//     record returns 200 with `changed:false`

import type { Env } from '../index'
import { resolveManualReview, maskInvoiceKey, invoiceKeyFromOrderId, isStripeOrderId } from './stripe-fulfillment'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const MIN_EVIDENCE_CHARS = 20
const MAX_EVIDENCE_CHARS = 1000

export async function handleStripeFulfillmentResolve(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })
  if (!env.PAYINVOICE_ADMIN_SECRET) return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  const callerSecret = request.headers.get('x-admin-secret')?.trim()
  if (!callerSecret || callerSecret !== env.PAYINVOICE_ADMIN_SECRET) return json(401, { error: 'Unauthorized' })

  let body: any
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid JSON body' })
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'expected a JSON object' })

  const rawKey = typeof body.invoiceKey === 'string' ? body.invoiceKey.trim() : ''
  const invoiceKey = isStripeOrderId(rawKey) ? invoiceKeyFromOrderId(rawKey) : rawKey
  if (!invoiceKey.startsWith('cpis_')) return json(400, { error: 'invoiceKey must be a cpis_* session id (or stripe_crypto_cpis_* orderId)' })

  const resolution = body.resolution
  if (resolution !== 'paid' && resolution !== 'failed_provider') {
    return json(400, { error: 'resolution must be "paid" or "failed_provider"' })
  }
  const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : ''
  if (evidence.length < MIN_EVIDENCE_CHARS || evidence.length > MAX_EVIDENCE_CHARS) {
    return json(400, { error: `evidence must be ${MIN_EVIDENCE_CHARS}-${MAX_EVIDENCE_CHARS} characters describing what was verified` })
  }
  const resolvedBy = typeof body.resolvedBy === 'string' ? body.resolvedBy.trim() : ''
  if (!resolvedBy || resolvedBy.length > 100) return json(400, { error: 'resolvedBy is required (who verified)' })
  const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : ''
  if (resolution === 'paid' && !TX_HASH_RE.test(txHash)) {
    return json(400, { error: 'resolution "paid" requires txHash (0x + 64 hex) of the settlement transaction' })
  }
  // Never let the evidence string smuggle a capability into the record.
  if (evidenceCarriesCapability(evidence)) {
    return json(400, { error: 'evidence must not contain a Stripe pay URL or client secret' })
  }

  const out = await resolveManualReview(env, invoiceKey, {
    resolution,
    evidence,
    txHash: resolution === 'paid' ? txHash : null,
    resolvedBy,
    now: new Date(),
  })
  if (out.kind === 'no_record') return json(404, { error: 'no Stripe fulfillment record', invoiceKey: maskInvoiceKey(invoiceKey) })
  if (out.kind === 'not_manual_review') {
    return json(409, {
      error: `record is "${out.status}", only manual_review can be resolved here`,
      invoiceKey: maskInvoiceKey(invoiceKey),
      status: out.status,
    })
  }
  return json(200, {
    ok: true,
    invoiceKey: maskInvoiceKey(invoiceKey),
    status: out.status,
    changed: out.kind === 'resolved',
    paidAt: out.paidAt,
  })
}

/**
 * True if `evidence` contains a Stripe pay/setup capability URL (any host
 * serialization: port, trailing dot, case, userinfo) or a client secret.
 * URLs are parsed and their hostname/path normalized rather than matched as
 * one literal spelling.
 */
export function evidenceCarriesCapability(evidence: string): boolean {
  if (/client_secret|\bcs_(live|test)_/i.test(evidence)) return true
  const urlish = evidence.match(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi) ?? []
  for (const raw of urlish) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      continue
    }
    const host = u.hostname.toLowerCase().replace(/\.+$/, '')
    if ((host === 'stripe.com' || host.endsWith('.stripe.com')) && /\/(pay|setup)\//i.test(u.pathname)) return true
  }
  // Schemeless spellings ("crypto.stripe.com/pay/…") are still a capability.
  return /stripe\.com\.?(:\d+)?\/(pay|setup)\//i.test(evidence)
}
