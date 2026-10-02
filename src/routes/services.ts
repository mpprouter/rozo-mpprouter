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
import { listThirdPartyDirectory } from '../services/third-party-directory'
import { getDegradedRoutes } from '../services/route-health'
import type { Env } from '../index'

/**
 * The `services[]` array of GET /v1/services/catalog: snapshot plus
 * self-serve overlay, with `live_status` merged on top. Shared with the
 * per-provider index below so the two can never disagree about a route.
 */
export async function buildCatalogServices(env: Env) {
  const degraded = await getDegradedRoutes(env)
  return (await listCatalogWithOverlay(env)).map(s => ({
    ...s,
    ...(degraded[s.id] ?? { live_status: 'ok' as const }),
  }))
}

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
  // Third-party providers who gave written permission to be listed and
  // whom a buyer pays at their OWN endpoint. Deliberately a separate array
  // rather than extra `services[]` rows: every existing client reads
  // `services[]` as "things this router will sell me", and that reading
  // must stay true.
  const thirdParty = listThirdPartyDirectory()

  // Snapshot catalog plus any self-serve providers published at runtime.
  // Provider entries carry `settlement: 'direct'` and an `operator` block
  // naming the addresses the buyer pays; snapshot entries are byte-identical
  // to what they have always been.
  const services = await buildCatalogServices(env)

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
    // Curated third-party services we list but do not sell. Counted apart
    // from `total` on purpose: they are not in `services[]`, are not
    // payable here, and folding them into the headline number would make
    // the catalog look bigger than what the router will actually charge
    // for. See src/services/third-party-directory.ts.
    third_party_directory: thirdParty.length,
  }

  return new Response(JSON.stringify({
    version: 1,
    base_url: 'https://apiserver.mpprouter.dev',
    generated_at: new Date().toISOString(),
    supported_payment_methods: supportedPaymentMethods,
    summary,
    services,
    third_party_providers: {
      note:
        'Provider-operated services listed with the operator\'s written permission. ' +
        'Settlement is direct to the operator and MPP Router does not proxy or sell these calls — ' +
        'pay the operator at resource_url.',
      services: thirdParty,
    },
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}

/** `/v1/services/<provider>` (optional trailing slash). Anything deeper is an operation path. */
const PROVIDER_INDEX_PATH = /^\/v1\/services\/([A-Za-z0-9._-]+)\/?$/

/** The provider segment of a catalog `public_path` (`/v1/services/<provider>/...`). */
function providerOf(publicPath: string): string | undefined {
  return publicPath.split('/')[3] || undefined
}

/**
 * GET /v1/services/<provider> — a read-only index of one provider's public
 * routes, so a client that types the provider URL gets a map instead of
 * "Unknown public service route".
 *
 * Every field is copied from (or counted over) the same `services[]` rows
 * GET /v1/services/catalog returns, so this endpoint cannot expose anything
 * the catalog does not. It is free and never issues a payment challenge.
 *
 * Called ONLY from the proxy's unknown-route fallback, i.e. after route
 * resolution found no paid route at this exact path and method: a paid
 * route with a single-segment public path always wins over this index.
 *
 * Returns null when the path is not a provider index or the provider is
 * unknown, so the caller keeps its existing 400.
 */
export async function handleProviderIndex(env: Env, pathname: string): Promise<Response | null> {
  const match = pathname.match(PROVIDER_INDEX_PATH)
  if (!match) return null
  const providerId = match[1]

  const entries = (await buildCatalogServices(env)).filter(
    s => providerOf(s.public_path) === providerId,
  )
  if (entries.length === 0) return null

  // Catalog names read "Exa – Search the web"; the provider name is the
  // part before the dash. Most common prefix wins, falling back to the id.
  const prefixCounts = new Map<string, number>()
  for (const e of entries) {
    const prefix = e.name.split(' – ')[0]?.trim()
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
  }
  const name = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? providerId

  // Upstream docs links: union of the per-route `docs` objects, first wins.
  const docs: Record<string, string> = {}
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.docs ?? {})) {
      if (typeof v === 'string' && v && !(k in docs)) docs[k] = v
    }
  }

  const description = entries.length === 1
    ? entries[0].description
    : `${name}: ${entries.length} public routes on MPP Router. Each route is called and paid separately; see routes[] below.`

  const routes = entries.map(e => ({
    id: e.id,
    name: e.name,
    method: e.method,
    public_path: e.public_path,
    price: e.price,
    payment_enabled: e.payment_enabled,
    status: e.status,
    payment_status: e.payment_status,
    live_status: e.live_status,
    docs_url: e.docs_url,
  }))

  return new Response(JSON.stringify({
    id: providerId,
    name,
    description,
    docs,
    catalog_url: 'https://apiserver.mpprouter.dev/v1/services/catalog',
    route_count: routes.length,
    routes,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
