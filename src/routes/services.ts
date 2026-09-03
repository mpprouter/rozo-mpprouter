/**
 * GET /services and GET /v1/services/catalog — Returns the public service catalog.
 *
 * Unified discovery: one catalog serves all inbound payment flavors.
 * Each entry's `methods` block advertises what the router will
 * accept. When `X402_ENABLED=true` each entry also carries a
 * `methods.stellar_x402` block (scheme=exact, network=stellar:pubnet,
 * payTo=STELLAR_X402_PAY_TO) so `@x402/stellar/exact/client` and any
 * spec-compliant x402-over-Stellar client can discover us from the
 * same catalog Stellar MPP agents already read. See `listPublicCatalog`
 * in src/services/merchants.ts for the exact shape.
 */

import { listCatalogWithOverlay } from '../services/catalog-overlay'
import { getDegradedRoutes } from '../services/route-health'
import type { Env } from '../index'

export async function handleServices(env: Env): Promise<Response> {
  // Top-level "what can this router accept from agents" — lets a
  // client tell at a glance which inbound flavor it can build,
  // without walking all 88 entries.
  const supportedPaymentMethods: Array<{ scheme: string; network: string }> = [
    { scheme: 'stellar.mpp', network: env.STELLAR_NETWORK },
  ]
  if (env.X402_ENABLED === 'true') {
    supportedPaymentMethods.push({
      scheme: 'stellar.x402',
      network: env.STELLAR_NETWORK,
    })
  }

  // `live_status` is deliberately merged ON TOP of the static catalog
  // rather than replacing any of it. The two answer different questions and
  // a client needs both: `payment_status`/`charge_rozo_verified` say "have
  // we ever proven this route works" (provenance, human-stamped, valid for
  // months), `live_status` says "is it working right now" (observed, resets
  // itself). Collapsing them would have hidden the very incident this
  // field was added for — see services/route-health.ts.
  const degraded = await getDegradedRoutes(env)

  // Snapshot catalog plus any self-serve providers published at runtime.
  // Provider entries carry `settlement: 'direct'` and an `operator` block
  // naming the addresses the buyer pays; snapshot entries are byte-identical
  // to what they have always been.
  const services = (await listCatalogWithOverlay(env)).map(s => ({
    ...s,
    ...(degraded[s.id] ?? { live_status: 'ok' as const }),
  }))

  // Top-level payment summary so a client (and operators) can see fleet
  // health at a glance without walking every entry: how many routes the
  // router will accept payment for, and how many of those we've actually
  // real-money verified vs are payable-but-unverified.
  const summary = {
    total: services.length,
    payable: services.filter(s => s.payment_enabled).length,
    verified: services.filter(s => s.payment_status === 'verified').length,
    available_unverified: services.filter(s => s.payment_status === 'available').length,
    unavailable: services.filter(s => s.payment_status === 'unavailable').length,
    degraded_now: services.filter(s => s.live_status === 'degraded').length,
    // How many routes settle straight to a third-party provider rather
    // than to the ROZO pool. Published because it is the headline claim of
    // the provider programme and a reader should not have to count.
    direct_settlement: services.filter(s => s.settlement === 'direct').length,
  }

  return new Response(JSON.stringify({
    version: 1,
    base_url: 'https://apiserver.mpprouter.dev',
    generated_at: new Date().toISOString(),
    supported_payment_methods: supportedPaymentMethods,
    summary,
    services,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
