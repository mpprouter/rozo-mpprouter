/**
 * `GET /.well-known/x402` — our own machine-readable discovery document.
 *
 * ## Why the router publishes one at all
 *
 * We read other people's manifests to find services worth listing; until
 * this handler grew past the provider registry, nobody could read ours.
 * `/services` has always carried the whole catalog, but it is our own
 * shape: a crawler that speaks x402 has to be taught it. This document is
 * the same information in the convention the ecosystem already crawls, so
 * the 674 routes we operate are discoverable without anyone writing an
 * MPP-specific parser.
 *
 * ## Prices and addresses come from the catalog, never from this file
 *
 * Every resource below is derived from `listCatalogWithOverlay` — the same
 * source `/services` renders — so this document cannot drift from what the
 * router will actually charge. A hand-maintained manifest is a second
 * price list, and the failure mode of a second price list is advertising a
 * number the 402 then contradicts.
 *
 * ## Three kinds of resource, labelled rather than blended
 *
 *   - **router-operated** (`settlement: 'pooled'`): the snapshot catalog.
 *     Buyer pays the router's Stellar address, we pay the upstream.
 *   - **provider-direct** (`settlement: 'direct'`): runtime-registry routes
 *     whose `operator` proved a settlement address. Buyer pays the
 *     provider's address at a router URL.
 *   - **directory** (`payable_through_router: false`): curated third-party
 *     services we do not proxy. `resource` is the provider's own URL, and
 *     the accepts are theirs. Listed so an agent can find them; explicitly
 *     not sold by us.
 *
 * Note what agent402's manifest does NOT do and this one does: theirs is a
 * bare list of URLs, so a crawler must probe every one to learn a price.
 * Ours carries the price and the payout address inline, which is the whole
 * reason to publish a manifest rather than a sitemap.
 */

import type { Env } from '../index'
import type { PublicCatalogEntry } from '../services/merchants-types'
import { listCatalogWithOverlay, getAllRoutes } from '../services/catalog-overlay'
import { listThirdPartyDirectory } from '../services/third-party-directory'

const BASE_URL = 'https://apiserver.mpprouter.dev'

/** Stellar's fixed 7-decimal minor unit. */
const STELLAR_DECIMALS = 7

const STELLAR_USDC_SAC_BY_NETWORK: Record<string, string> = {
  'stellar:pubnet': 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  'stellar:testnet': 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
}

interface WellKnownAccept {
  scheme: 'exact'
  network: string
  /** Integer minor units, as x402 `accepts[].amount` is defined. */
  amount: string
  decimals: number
  /**
   * The on-chain asset identifier — the Stellar SAC, not the ticker.
   * `accepts[].asset` is what a canonical x402 client matches its payment
   * requirements against, so putting `"USDC"` here would have every
   * standards-compliant wallet sign for the wrong asset and get rejected
   * by the very facilitator this manifest is advertising.
   */
  asset: string
  /** Human ticker, alongside rather than instead of the identifier. */
  asset_symbol?: string
  payTo: string
}

interface WellKnownResource {
  resource: string
  method: string
  name?: string
  description: string
  categories?: string[]
  /** Query parameters the caller MUST supply, or the call 400s before payment. */
  required_query_params?: string[]
  price: string
  price_usd?: string
  /**
   * True when `price_usd` is a catalog snapshot of an upstream merchant's
   * price rather than a number this router fixes. Such a route gets no
   * `accepts[]`: the live 402 is derived from the merchant's own current
   * price, and a client signing an amount from here would have its payment
   * rejected the day that merchant repriced.
   */
  price_indicative?: true
  settlement: 'pooled' | 'direct'
  payable_through_router: boolean
  operator?: { id: string; name: string; homepage?: string }
  accepts: WellKnownAccept[]
  evaluation_tx?: string
}

/** `"$0.005/request"` → `"0.005"`. Null for dynamically priced routes. */
export function fixedUsdFromPriceLabel(price: string): string | null {
  const match = /^\$([0-9]+(?:\.[0-9]+)?)\/request$/.exec(price.trim())
  return match ? match[1] : null
}

/**
 * Decimal USD → integer minor units at `decimals` places.
 *
 * Returns null rather than rounding when the value carries more precision
 * than the asset can express: quietly truncating a price is how a manifest
 * ends up advertising less than the 402 will demand.
 */
export function toMinorUnits(amountDecimal: string, decimals: number): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(amountDecimal)) return null
  const [whole, frac = ''] = amountDecimal.split('.')
  if (frac.length > decimals) return null
  const digits = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '')
  return digits
}

function stellarAssetId(network: string, hint?: string): string | undefined {
  if (hint) return hint
  if (!network.startsWith('stellar:')) return undefined
  return STELLAR_USDC_SAC_BY_NETWORK[network] ?? STELLAR_USDC_SAC_BY_NETWORK['stellar:pubnet']
}

/**
 * Build the accepts for one catalog entry.
 *
 * An entry with no advertisable payment option yields an empty array
 * rather than a guessed one. A crawler reading `accepts: []` must probe
 * the live 402, which is the correct outcome for a dynamically priced
 * route; a fabricated accept would be worse than silence.
 */
function acceptsForCatalogEntry(
  entry: PublicCatalogEntry,
  routerFixesPrice: boolean,
): WellKnownAccept[] {
  const priceUsd = fixedUsdFromPriceLabel(entry.price)
  if (!priceUsd) return []
  // Only advertise an exact amount for a route whose price THIS router
  // sets. For a snapshot route the amount comes from the upstream
  // merchant's live 402 at request time, so an inline exact amount is a
  // promise we do not control.
  if (!routerFixesPrice) return []

  // Provider-direct routes: one accept per proven payout address.
  if (entry.operator?.payouts?.length) {
    const out: WellKnownAccept[] = []
    for (const payout of entry.operator.payouts) {
      const decimals = payout.network.startsWith('stellar:') ? STELLAR_DECIMALS : 6
      const amount = toMinorUnits(priceUsd, decimals)
      if (!amount) continue
      const assetId = stellarAssetId(payout.network)
      out.push({
        scheme: 'exact',
        network: payout.network,
        amount,
        decimals,
        asset: assetId ?? payout.asset,
        ...(assetId ? { asset_symbol: payout.asset } : {}),
        payTo: payout.pay_to,
      })
    }
    return out
  }

  // Router-operated routes: the pooled x402 recipient, present only when
  // X402_ENABLED is on. With the flag off we advertise no x402 accept,
  // because there would be nothing on the other end to honour it.
  const x402 = entry.methods.stellar_x402
  if (!x402) return []
  const amount = toMinorUnits(priceUsd, STELLAR_DECIMALS)
  if (!amount) return []
  const assetId = stellarAssetId(x402.network, entry.payment_hints?.asset_sac)
  return [{
    scheme: 'exact',
    network: x402.network,
    amount,
    decimals: STELLAR_DECIMALS,
    asset: assetId ?? x402.asset,
    ...(assetId ? { asset_symbol: x402.asset } : {}),
    payTo: x402.pay_to,
  }]
}

function catalogResource(entry: PublicCatalogEntry, routerFixesPrice: boolean): WellKnownResource {
  const priceUsd = fixedUsdFromPriceLabel(entry.price)
  return {
    resource: `${BASE_URL}${entry.public_path}`,
    method: entry.method,
    name: entry.name,
    description: entry.description,
    categories: entry.categories,
    // Carried through because a route templated on a path parameter 400s
    // before payment without it, and a manifest that omits the requirement
    // reads as "callable as printed".
    ...(entry.path_params?.length ? { required_query_params: entry.path_params } : {}),
    price: entry.price,
    ...(priceUsd ? { price_usd: priceUsd } : {}),
    ...(priceUsd && !routerFixesPrice ? { price_indicative: true as const } : {}),
    settlement: entry.operator ? 'direct' : 'pooled',
    payable_through_router: true,
    ...(entry.operator
      ? { operator: { id: entry.operator.id, name: entry.operator.name } }
      : {}),
    accepts: acceptsForCatalogEntry(entry, routerFixesPrice),
  }
}

function directoryResources(): WellKnownResource[] {
  return listThirdPartyDirectory().map(entry => ({
    // The provider's own URL on purpose: we are telling a crawler where to
    // buy this, and it is not from us.
    resource: entry.resource_url,
    method: entry.method,
    name: `${entry.operator.name} — ${entry.operation}`,
    description: entry.description,
    categories: entry.categories,
    price: entry.price,
    price_usd: entry.price_usd,
    settlement: 'direct' as const,
    payable_through_router: false,
    operator: {
      id: entry.operator.id,
      name: entry.operator.name,
      homepage: entry.operator.homepage,
    },
    accepts: entry.payouts.flatMap(payout => {
      const decimals = payout.network.startsWith('stellar:') ? STELLAR_DECIMALS : 6
      const amount = toMinorUnits(entry.price_usd, decimals)
      if (!amount) return []
      return [{
        scheme: 'exact' as const,
        network: payout.network,
        amount,
        decimals,
        // The operator's own 402 advertises the contract id here, and this
        // entry is a mirror of that challenge.
        asset: payout.asset_id ?? payout.asset,
        ...(payout.asset_id ? { asset_symbol: payout.asset } : {}),
        payTo: payout.pay_to,
      }]
    }),
    ...(entry.evaluation_tx ? { evaluation_tx: entry.evaluation_tx } : {}),
  }))
}

/** Assemble the document. Exported for tests; the handler wraps it. */
export async function buildX402WellKnown(env: Env): Promise<{
  spec: string
  name: string
  description: string
  generated_at: string
  discovery: string
  counts: Record<string, number>
  notes: string[]
  resources: WellKnownResource[]
}> {
  const catalog = await listCatalogWithOverlay(env)
  // Which routes does the ROUTER price, rather than relay a merchant's
  // price for? Only those can carry an exact inline amount — see
  // `price_indicative`. `fixedPricing` is the router-set case and
  // `operator` is the provider-direct case (priced from the registration).
  const routes = await getAllRoutes(env)
  const routerPriced = new Set(
    routes.filter(route => route.fixedPricing || route.operator).map(route => route.id),
  )
  // Routes we know are broken are excluded: publishing an endpoint the
  // proxy will refuse wastes a crawler's paid probe.
  const payable = catalog.filter(entry => entry.payment_enabled)
  const routerResources = payable.map(entry => catalogResource(entry, routerPriced.has(entry.id)))
  const directory = directoryResources()

  return {
    spec: 'https://x402.org/specs/x402-v2',
    name: 'MPP Router',
    description:
      'AI, data and API services payable per call with Stellar USDC through MPP Router, ' +
      'plus curated third-party services that settle directly to their own operators.',
    generated_at: new Date().toISOString(),
    discovery: `${BASE_URL}/services`,
    counts: {
      total: routerResources.length + directory.length,
      router_operated: routerResources.filter(r => r.settlement === 'pooled').length,
      provider_direct: routerResources.filter(r => r.settlement === 'direct').length,
      third_party_directory: directory.length,
      with_inline_price: [...routerResources, ...directory].filter(r => r.accepts.length > 0).length,
    },
    notes: [
      'An empty accepts[] means the price is determined at request time; probe the resource for a live 402.',
      'price_indicative: true means price_usd is a catalog snapshot of an upstream price, not an amount this router fixes.',
      'accepts[].asset is the on-chain asset identifier (Stellar SAC); accepts[].asset_symbol is the ticker.',
      'payable_through_router: false means MPP Router does not sell this call — pay the operator at the resource URL.',
      'settlement: "direct" means the buyer pays the operator address, not a ROZO pool.',
    ],
    resources: [...routerResources, ...directory],
  }
}

export async function handleX402WellKnown(env: Env): Promise<Response> {
  const document = await buildX402WellKnown(env)
  return new Response(JSON.stringify(document, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  })
}
