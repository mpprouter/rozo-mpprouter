/**
 * POST /admin/seed-atomic-store — one-time migration helper.
 *
 * Seeds absent keys into the AtomicStoreDO from production KV values
 * captured at cutover. This route exists solely to handle the
 * "DO is empty on first deploy" bootstrapping problem for the 3
 * existing Stellar channel cumulative watermarks.
 *
 * Safety contract (enforced by the DO /seed handler):
 *   • ONLY writes a key when it is absent in the DO.
 *   • If the live payment path already wrote the key, /seed returns
 *     { seeded: false, reason: 'exists' } and makes NO change.
 *   • Running this route multiple times is safe (idempotent).
 *
 * Auth: same x-admin-secret header check as /admin/pay-invoice
 * (see src/routes/pay-invoice-admin.ts lines 183-188 for the pattern).
 * 401 on wrong/missing secret. 500 if the secret env var is unset.
 *
 * Request body:
 *   { "entries": [{ "key": "stellar:channel:cumulative:C...", "value": "{\"amount\":\"56424\"}" }] }
 *
 * Response:
 *   200: { "results": [{ "key": "...", "seeded": true | false, "reason"?: "exists" }] }
 *   400: bad body
 *   401: wrong or missing x-admin-secret
 *   500: env misconfiguration or DO error
 */

import type { Env } from '../index'
import type { SeedResponse } from '../mpp/atomic-store-do'

/** Internal URL base for DO /seed calls. The hostname is irrelevant — CF routes
 *  stub.fetch() internally and never makes an outbound network request. */
const DO_ORIGIN = 'https://atomic-store.internal'

// ── JSON helper ───────────────────────────────────────────────────────────────

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Wire types ────────────────────────────────────────────────────────────────

type SeedEntry = { key: string; value: string }

type SeedStoreBody = { entries: SeedEntry[] }

type SeedResultEntry = { key: string; seeded: boolean; reason?: string }

function isSeedStoreBody(x: unknown): x is SeedStoreBody {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!Array.isArray(o.entries)) return false
  return o.entries.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as Record<string, unknown>).key === 'string' &&
      typeof (e as Record<string, unknown>).value === 'string',
  )
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleAdminSeedStore(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  // Auth check — mirrors pay-invoice-admin.ts:183-188 exactly.
  if (!env.PAYINVOICE_ADMIN_SECRET) {
    return json(500, { error: 'PAYINVOICE_ADMIN_SECRET is not configured' })
  }
  const callerSecret = request.headers.get('x-admin-secret')?.trim()
  if (!callerSecret || callerSecret !== env.PAYINVOICE_ADMIN_SECRET) {
    return json(401, { error: 'Unauthorized' })
  }

  // Parse body.
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  if (!isSeedStoreBody(parsed)) {
    return json(400, {
      error: 'Body must be { entries: Array<{ key: string, value: string }> }',
    })
  }

  // Obtain the single named DO stub ("mppx") — same as kv-atomic-store.ts.
  const stub = env.ATOMIC_STORE.get(env.ATOMIC_STORE.idFromName('mppx'))

  const results: SeedResultEntry[] = []

  for (const entry of parsed.entries) {
    let doResp: Response
    try {
      doResp = await stub.fetch(
        new Request(`${DO_ORIGIN}/seed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: entry.key, value: entry.value }),
        }),
      )
    } catch (err: any) {
      return json(500, {
        error: `DO /seed network error for key ${entry.key}: ${err?.message ?? 'unknown'}`,
      })
    }

    if (!doResp.ok) {
      const text = await doResp.text()
      return json(500, {
        error: `DO /seed returned ${doResp.status} for key ${entry.key}: ${text}`,
      })
    }

    const seedResult = (await doResp.json()) as SeedResponse
    const out: SeedResultEntry = { key: entry.key, seeded: seedResult.seeded }
    if (!seedResult.seeded) {
      out.reason = seedResult.reason
    }
    results.push(out)
  }

  return json(200, { results })
}
