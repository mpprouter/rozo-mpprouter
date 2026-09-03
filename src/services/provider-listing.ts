/**
 * External discovery: register a published provider with MPPScan.
 *
 * Step 9 of the onboarding flow. A provider who passes both gates is
 * listed in our own catalog immediately — that part we control — but a
 * service nobody can discover is barely a service, and the ecosystem's
 * discovery surfaces are somebody else's. So we file the registration on
 * their behalf rather than leaving it as homework.
 *
 * ## Best-effort by construction
 *
 * This runs inside `ctx.waitUntil` after the provider is already
 * published, and every failure path here is swallowed. That ordering is
 * deliberate: the provider has, by this point, proven a real payment
 * settled to their own key, and no outcome at a third-party scanner should
 * be able to reverse that. A listing that fails is a listing we retry; a
 * publication that fails because a scanner was down is a broken promise.
 *
 * ## What we can and cannot promise
 *
 * MPPScan takes self-serve registrations, so this is a real automation.
 * `mpp.dev` is a curated pull request against `tempoxyz/mpp` — we can file
 * one, we cannot promise it is accepted, and pretending otherwise in the
 * provider-facing copy would be a lie with a two-week fuse. It is
 * therefore deliberately NOT automated here.
 */

import type { Env } from '../index'
import type { ProviderRecord } from './provider-registry'
import { publicPathFor } from './provider-registry'

const MPPSCAN_REGISTER_URL = 'https://mppscan.com/register'
const TIMEOUT_MS = 10_000

export interface ListingResult {
  ok: boolean
  status?: number
  detail: string
}

export async function registerWithMppScan(
  env: Env,
  record: ProviderRecord,
): Promise<ListingResult> {
  // Off unless explicitly enabled. An onboarding flow that posts to a
  // third party the first time it runs in a new environment is a surprise,
  // and the environment where that surprise lands is production.
  if (env.MPPSCAN_REGISTER_ENABLED !== 'true') {
    return { ok: false, detail: 'MPPScan registration disabled on this deployment.' }
  }

  const payload = {
    name: record.name,
    // The router URL, not the provider's origin. A buyer who discovers the
    // service through MPPScan should arrive at an endpoint that speaks the
    // 402 dialects we have verified, and the provider gets the traffic
    // either way because settlement is direct to them.
    endpoints: record.routes.map(r => ({
      url: `https://apiserver.mpprouter.dev${publicPathFor(record.id, r.operation)}`,
      method: r.method,
      price_usd: r.priceUsd,
      description: r.description ?? '',
    })),
    settlement: record.payouts.map(p => ({
      network: p.network,
      pay_to: p.payTo,
      asset: p.asset,
    })),
    operator: record.name,
    // Contact is the router, not the provider's inbox: we hold the record
    // and can answer for it, and republishing a registrant's email to a
    // third party is not ours to do.
    contact: 'https://apiserver.mpprouter.dev/v1/providers/' + record.id,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(MPPSCAN_REGISTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'mpprouter/1 (+https://apiserver.mpprouter.dev)',
        ...(env.MPPSCAN_API_KEY ? { Authorization: `Bearer ${env.MPPSCAN_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `MPPScan returned ${res.status}.` }
    }
    return { ok: true, status: res.status, detail: 'Registered with MPPScan.' }
  } catch (err: any) {
    return { ok: false, detail: `MPPScan registration failed: ${err?.message ?? 'unknown'}.` }
  } finally {
    clearTimeout(timer)
  }
}
