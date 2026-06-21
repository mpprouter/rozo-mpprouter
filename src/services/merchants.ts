/**
 * Public service catalog for the MPP Router.
 *
 * History: this file used to contain a hand-typed list of 12
 * routes (PUBLIC_SERVICE_ROUTES). It drifted relative to the
 * upstream mpp.dev catalog, which now has 88 services and 832
 * endpoints. As of 2026-04-12 the route table is generated from
 * a frozen snapshot (`mpp-catalog-snapshot.json`) at module load
 * time via `buildRoutesFromMppSnapshot`. The 12 historical
 * route IDs and their `verifiedMode` operator-test results are
 * preserved via `OPERATOR_OVERLAY` so existing client URL
 * bookmarks (`/v1/services/parallel/search`) keep working
 * unchanged.
 *
 * To refresh the snapshot:
 *   npx tsx scripts/admin/refresh-mpp-snapshot.ts
 *   git add src/services/mpp-catalog-snapshot.json
 *   git commit -m "Refresh mpp.dev catalog snapshot YYYY-MM-DD"
 *
 * To add an operator-only override (verifiedMode, placeholder
 * defaults, session-channel pre-provisioning), edit
 * `OPERATOR_OVERLAY` below — keyed by `${serviceId}::${upstreamPath}`
 * where the upstream path uses `{name}` placeholder syntax.
 *
 * The router used to be 12 routes for ~6 months. The instinct to
 * read this file linearly to find a route is no longer practical
 * with 800+ entries — use the `getRouteByPublicPath` helper or
 * grep for `id:` if you really need to inspect a single entry.
 */

import mppSnapshot from './mpp-catalog-snapshot.json'
import { buildRoutesFromMppSnapshot } from './build-routes'
import type {
  PublicServiceRoute,
  PublicServiceRouteOverlay,
  PublicCatalogEntry,
} from './merchants-types'

// Re-export types from `merchants-types.ts` so existing imports
// like `import type { PublicServiceRoute } from './services/merchants'`
// continue to work.
export type {
  PublicServiceRoute,
  PublicServiceRouteOverlay,
  PublicCatalogEntry,
} from './merchants-types'

// ---------------------------------------------------------------------
// Operator overlay
// ---------------------------------------------------------------------

/**
 * Per-route operator-only overrides applied during route generation.
 * Keyed by `${serviceId}::${upstreamPath}` where upstreamPath uses
 * `{name}` placeholder syntax (the post-rewrite shape).
 *
 * Use this for:
 * - Stable historical IDs / publicPaths so old client bookmarks work
 * - verifiedMode flags from real end-to-end testing
 * - Session-channel mode flips (when the operator has opened a KV
 *   channel via `scripts/admin/open-tempo-channel.ts`)
 * - placeholderDefaults for path-templated upstreams
 *
 * Each entry's session-mode flag MUST match a key in
 * `scripts/admin/open-tempo-channel.ts MERCHANTS` so
 * `payMerchantSession` reads the right `tempoChannel:<id>` KV record.
 */
export const OPERATOR_OVERLAY: Record<string, PublicServiceRouteOverlay> = {
  // Parallel Search — first verified route, hand-tested 2026-04-11
  'parallel::/api/search': {
    id: 'parallel_search',
    publicPath: '/v1/services/parallel/search',
    verifiedMode: 'charge',
  },
  // Exa AI Search
  'exa::/search': {
    id: 'exa_search',
    publicPath: '/v1/services/exa/search',
    verifiedMode: 'charge',
  },
  // Firecrawl Scrape
  'firecrawl::/v1/scrape': {
    id: 'firecrawl_scrape',
    publicPath: '/v1/services/firecrawl/scrape',
    verifiedMode: 'charge',
  },
  // OpenRouter Chat — flipped to tempo.session 2026-04-11 after
  // open-tempo-channel.ts opened the $1 channel
  // 0x278bf3c7bb88da8d20de75a2cf0f8aec94c00fd399a1be5ae53911b1d83fac75
  // and persisted TempoChannelState to KV at
  // `tempoChannel:openrouter_chat`. payMerchantSession reads that
  // KV entry on every request.
  'openrouter::/v1/chat/completions': {
    id: 'openrouter_chat',
    publicPath: '/v1/services/openrouter/chat',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: 'session',
  },
  // Anthropic Messages — broken upstream
  'anthropic::/v1/messages': {
    id: 'anthropic_messages',
    publicPath: '/v1/services/anthropic/messages',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      'Merchant returns 500 on direct mppx call (verified bypassing router). ' +
      'Both /v1/messages and /v1/chat/completions endpoints fail upstream. ' +
      'Channel is open but unusable until anthropic merchant is fixed.',
  },
  // OpenAI Chat — verified session mode
  'openai::/v1/chat/completions': {
    id: 'openai_chat',
    publicPath: '/v1/services/openai/chat',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: 'session',
  },
  // Google Gemini — uses {model} placeholder, defaults to gemini-2.0-flash
  // The upstream path uses Google's `:generateContent` literal
  // colon convention; the build step rewrites `:version` →
  // `{version}` if mpp.dev publishes the templated form, but the
  // operator override here pins both the public id and the model
  // default for backward compat with old bookmarks.
  //
  // verifiedMode false — real-money E2E 2026-06-22: after re-opening the
  // session channel (descriptor now captured, payment layer OK — the old
  // `descriptor required for TIP-1034` error is GONE), the merchant
  // returns 502/status:404. Root cause: upstream path is
  // `/{version}/models/*` and `resolveUpstreamPath` does not substitute
  // the literal `*` wildcard, so we forward `/v1beta/models/*` instead of
  // `/v1beta/models/gemini-2.0-flash:generateContent`. Needs a proper
  // upstreamPath override (overlay can't override upstreamPath today).
  // The PAYMENT path (session voucher + descriptor) is verified working.
  'gemini::/{version}/models/*': {
    id: 'gemini_generate',
    publicPath: '/v1/services/gemini/generate',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      'Payment/session layer OK after channel re-open (descriptor captured). ' +
      'Blocked on upstream model path: `/{version}/models/*` wildcard is not ' +
      'substituted, so merchant 404s. Needs upstreamPath override support.',
    placeholderDefaults: { version: 'v1beta', model: 'gemini-2.0-flash' },
  },
  // Dune SQL Execute — channel underfunded
  'dune::/api/v1/sql/execute': {
    id: 'dune_execute',
    publicPath: '/v1/services/dune/execute',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      'Channel underfunded — Dune SQL execute charged $4 USDC initial probe ' +
      'charge but channel deposit was only $1. Cumulative > deposit, so the ' +
      'next voucher will be rejected. Needs a topup or a higher initial deposit.',
  },
  // Modal Sandbox — body shape issue
  'modal::/sandbox/exec': {
    id: 'modal_exec',
    publicPath: '/v1/services/modal/exec',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      'Merchant returns tempo.charge instead of session despite mpp.dev catalog. ' +
      'Router charge fallback fires correctly, but the modal forwarder rejects ' +
      'an empty {} body with 500. Need to find a body shape modal accepts.',
  },
  // Alchemy Ethereum RPC — actually charge mode despite catalog
  // (mpp.dev lists tempo.session, but the merchant accepts charge)
  'alchemy::/{network}/v2': {
    id: 'alchemy_rpc',
    publicPath: '/v1/services/alchemy/rpc',
    upstreamPaymentMethod: 'tempo.charge',
    verifiedMode: 'charge',
    placeholderDefaults: { network: 'eth-mainnet' },
  },
  // Tempo L2 RPC
  'rpc::/': {
    id: 'tempo_rpc',
    publicPath: '/v1/services/tempo/rpc',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: 'session',
  },
  // DeepSeek Chat — OpenAI-compatible chat completions, tempo.charge.
  // Stable publicPath so agents don't hit the auto-slugged
  // `/deepseek/deepseek_chat`. Price is dynamic (~$0.004–$0.025).
  // verifiedMode 'charge' — real-money E2E 2026-06-22 returned a live
  // LLM completion (model deepseek-v4-flash) through the full chain.
  'deepseek::/deepseek/chat': {
    id: 'deepseek_chat',
    publicPath: '/v1/services/deepseek/chat',
    upstreamPaymentMethod: 'tempo.charge',
    verifiedMode: 'charge',
  },
  // Groq Chat — OpenAI-compatible, very fast inference, tempo.charge.
  // Price dynamic ($0.005–$0.10 by model/tokens).
  // verifiedMode 'charge' — real-money E2E 2026-06-22 returned a live
  // llama-3.1-8b-instant completion through the full chain.
  'groq::/groq/chat': {
    id: 'groq_chat',
    publicPath: '/v1/services/groq/chat',
    upstreamPaymentMethod: 'tempo.charge',
    verifiedMode: 'charge',
  },
  // CoinGecko Simple Price — flat $0.06/request, tempo.charge. Cheapest
  // representative data endpoint; the other 15 coingecko routes keep
  // their auto-generated paths.
  // verifiedMode 'charge' — real-money E2E 2026-06-22 returned a live
  // price (bitcoin/usd) through the full chain.
  'coingecko::/coingecko/simple-price': {
    id: 'coingecko_simple_price',
    publicPath: '/v1/services/coingecko/simple-price',
    upstreamPaymentMethod: 'tempo.charge',
    verifiedMode: 'charge',
  },
  // QuickNode JSON-RPC — $0.001/request, tempo.charge. Upstream path is
  // `/{network}`; QuickNode uses `<chain>-mainnet` naming, so default to
  // `ethereum-mainnet` (NOT alchemy's `eth-mainnet`, which 404s
  // `unsupported_network`). Pass ?network=base-mainnet / solana-mainnet
  // / etc to target another QuickNode-supported network.
  // verifiedMode false — real-money E2E 2026-06-22: we paid OK but the
  // QuickNode merchant returned 502/5xx (merchant-side, like alchemy).
  'quicknode::/{network}': {
    id: 'quicknode_rpc',
    publicPath: '/v1/services/quicknode/rpc',
    upstreamPaymentMethod: 'tempo.charge',
    placeholderDefaults: { network: 'ethereum-mainnet' },
    verifiedMode: false,
    verifiedNote:
      'We paid OK (charge) but QuickNode merchant returned 502/5xx on ' +
      'ethereum-mainnet eth_blockNumber. Merchant-side, same pattern as alchemy. ' +
      'Re-verify when QuickNode upstream is fixed.',
  },
  // Object Storage Upload — actually charge mode for multipart-init
  'storage::/{key}': {
    id: 'storage_upload',
    publicPath: '/v1/services/storage/upload',
    verifiedMode: 'charge',
    placeholderDefaults: { key: 'upload' },
  },
}

// ---------------------------------------------------------------------
// Route table (generated from snapshot at module load)
// ---------------------------------------------------------------------

/**
 * The full route table the router serves. Generated from
 * `mpp-catalog-snapshot.json` + `OPERATOR_OVERLAY` at module load.
 * Effectively immutable for the lifetime of the Worker isolate.
 *
 * Length is currently around 660 routes (88 services × ~7 paid POST
 * endpoints each, after filtering out free/non-POST routes). Inspect
 * counts at runtime via `PUBLIC_SERVICE_ROUTES.length` if you need
 * to check.
 */
export const PUBLIC_SERVICE_ROUTES: PublicServiceRoute[] =
  buildRoutesFromMppSnapshot(mppSnapshot as any, OPERATOR_OVERLAY)

// ---------------------------------------------------------------------
// Catalog rendering
// ---------------------------------------------------------------------

/**
 * Build the list of Stellar intents this route accepts.
 *
 * Simplified 2026-04-12: all routes advertise only `charge`.
 * Session/channel complexity is removed — the router handles
 * the upstream session dance internally when needed. Agents
 * always pay via single-shot charge.
 *
 * - `verifiedMode === false`: route is known-broken, don't advertise
 *   any stellar intents so agents won't send money into a black hole.
 * - All other routes: advertise `charge` only.
 */
function stellarIntentsFor(route: PublicServiceRoute): Array<'charge'> {
  if (route.verifiedMode === false) return []
  return ['charge']
}

/**
 * Minimal env shape `listPublicCatalog` needs to decide whether to
 * attach the `methods.stellar_x402` block. Typed as a subset rather
 * than importing the full `Env` from `src/index.ts` to avoid a
 * circular dependency (index.ts imports routes which eventually
 * import this file).
 */
export type CatalogEnvView = {
  X402_ENABLED?: string
  STELLAR_NETWORK?: string
  STELLAR_X402_PAY_TO?: string
  STELLAR_ROUTER_PUBLIC?: string
}

/**
 * USDC asset identifier for the Stellar x402 `asset` field in the
 * public catalog. @x402/stellar's default parser treats USDC
 * specially; this is advertised to clients so they know which
 * Stellar token we accept.
 */
const STELLAR_X402_ASSET = 'USDC'
const STELLAR_USDC_SAC_BY_NETWORK: Record<string, string> = {
  'stellar:pubnet': 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  'stellar:testnet': 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
}

const RECOMMENDED_WALLET_PREFLIGHT: Array<
  'account_exists' | 'classic_usdc_trustline' | 'usdc_balance_gte_amount' | 'xlm_reserve_ok'
> = [
  'account_exists',
  'classic_usdc_trustline',
  'usdc_balance_gte_amount',
  'xlm_reserve_ok',
]

function parseFixedUsdPrice(price: string): string | null {
  const m = /^\$([0-9]+(?:\.[0-9]+)?)\/request$/.exec(price.trim())
  if (!m) return null
  return m[1]
}

function toStellarUsdc7(amountDecimal: string): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(amountDecimal)) return null
  const [whole, fracRaw = ''] = amountDecimal.split('.')
  if (fracRaw.length > 7) return null
  return `${whole}.${fracRaw.padEnd(7, '0')}`
}

function getUsdcSacForNetwork(network?: string): string | undefined {
  if (!network) return undefined
  return STELLAR_USDC_SAC_BY_NETWORK[network] ?? STELLAR_USDC_SAC_BY_NETWORK['stellar:pubnet']
}

export function listPublicCatalog(env?: CatalogEnvView): PublicCatalogEntry[] {
  // Single place to decide stellar.x402 inclusion — don't scatter
  // the check across every entry.
  const stellarX402Block =
    env?.X402_ENABLED === 'true' &&
    env.STELLAR_NETWORK &&
    env.STELLAR_X402_PAY_TO
      ? {
          scheme: 'exact' as const,
          network: env.STELLAR_NETWORK,
          pay_to: env.STELLAR_X402_PAY_TO,
          asset: STELLAR_X402_ASSET,
        }
      : null

  return PUBLIC_SERVICE_ROUTES.map(route => {
    const stellarIntents = stellarIntentsFor(route)
    const entry: PublicCatalogEntry = {
      id: route.id,
      name: route.name,
      // Backward-compat: keep `category` (singular) populated
      // with the first category for v1 clients that don't know
      // about the array.
      category: route.categories[0] ?? 'misc',
      categories: route.categories,
      description: route.description,
      public_path: route.publicPath,
      method: route.method,
      price: route.price,
      payment_method: route.paymentMethod,
      network: route.network,
      asset: route.asset,
      status: route.docs?.llmsTxt ? 'active' : 'limited',
      ...(route.docs?.llmsTxt ? {} : {
        status_note: 'llms_txt not available — use with caution; agents may not know how to construct request bodies.',
      }),
      docs_url: `https://apiserver.mpprouter.dev/docs/integration#${route.id.replace(/_/g, '-')}`,
      methods: {
        // Only include `stellar` when the route has usable intents —
        // broken routes (verifiedMode === false) get no stellar block.
        ...(stellarIntents.length > 0 ? { stellar: { intents: stellarIntents } } : {}),
        // Only include `stellar_x402` when the feature flag is on AND
        // the route has stellar intents — don't advertise x402 payment
        // for a route where stellar is disabled.
        ...(stellarIntents.length > 0 && stellarX402Block ? { stellar_x402: stellarX402Block } : {}),
        tempo: {
          intents: ['charge'] as Array<'charge' | 'session'>,
          role: 'upstream' as const,
        },
      },
    }
    if (stellarIntents.length > 0) {
      const dialect: 'mpp' | 'both' =
        stellarX402Block ? 'both' : 'mpp'
      const mppPayTo = env?.STELLAR_ROUTER_PUBLIC
      const x402PayTo = env?.STELLAR_X402_PAY_TO
      let payTo: string | undefined
      if (dialect === 'mpp') {
        payTo = mppPayTo
      } else if (mppPayTo && x402PayTo && mppPayTo === x402PayTo) {
        // Only expose a single pay_to for "both" when they are
        // actually the same address. Otherwise omit to avoid guessing.
        payTo = mppPayTo
      }

      const fixedUsd = parseFixedUsdPrice(route.price)
      const amountUsdc = fixedUsd ? toStellarUsdc7(fixedUsd) : null
      const paymentHints: NonNullable<PublicCatalogEntry['payment_hints']> = {
        network: env?.STELLAR_NETWORK,
        intent: stellarIntents[0] === 'charge' ? 'charge' : 'channel',
        dialect,
        ...(payTo ? { pay_to: payTo } : {}),
        ...(amountUsdc ? { amount_usdc: amountUsdc } : {}),
        ...(env?.STELLAR_NETWORK ? { asset_sac: getUsdcSacForNetwork(env.STELLAR_NETWORK) } : {}),
        requires_classic_usdc_trustline: true,
        recommended_wallet_preflight: RECOMMENDED_WALLET_PREFLIGHT,
      }
      entry.payment_hints = paymentHints
    }
    if (route.docs) {
      entry.docs = {
        ...(route.docs.homepage ? { homepage: route.docs.homepage } : {}),
        ...(route.docs.llmsTxt ? { llms_txt: route.docs.llmsTxt } : {}),
        ...(route.docs.apiReference ? { api_reference: route.docs.apiReference } : {}),
      }
    }
    if (route.verifiedMode !== undefined) {
      entry.verified_mode = route.verifiedMode
    }
    if (route.verifiedNote !== undefined) {
      entry.verified_note = route.verifiedNote
    }
    return entry
  })
}

// ---------------------------------------------------------------------
// Route lookup + path placeholder resolution
// ---------------------------------------------------------------------

export function getRouteByPublicPath(
  pathname: string,
  method: string,
): PublicServiceRoute | undefined {
  return PUBLIC_SERVICE_ROUTES.find(
    route => route.publicPath === pathname && route.method === method.toUpperCase(),
  )
}

/**
 * Return every method registered for `pathname`, regardless of HTTP
 * method. Used by the proxy to distinguish "path doesn't exist" (→ 400)
 * from "path exists but wrong method" (→ 405 with allowed_methods),
 * so agents that default to GET get an actionable hint instead of a
 * misleading 'Unknown public service route' error.
 */
export function getAllowedMethodsForPath(pathname: string): string[] {
  const methods = new Set<string>()
  for (const route of PUBLIC_SERVICE_ROUTES) {
    if (route.publicPath === pathname) methods.add(route.method)
  }
  return [...methods]
}

/**
 * Whitelist for `{placeholder}` substitution values. Restricts to
 * model-name-style identifiers so a client cannot inject path
 * traversal (`../`), query strings (`?`), or anchors (`#`).
 *
 * If you need to widen this for a future placeholder type (e.g.
 * an arbitrary network id with `/` in it), do it per-placeholder
 * with a route-specific override, NOT by relaxing this regex.
 */
const PLACEHOLDER_VALUE_PATTERN = /^[A-Za-z0-9._-]+$/

export class UpstreamPathPlaceholderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamPathPlaceholderError'
  }
}

/**
 * Substitute `{placeholder}` tokens in `route.upstreamPath` from a
 * URLSearchParams (request URL query). Falls back to per-route
 * defaults; throws when neither has a value, or when a value fails
 * validation. Returns the path with substitutions applied AND the
 * set of consumed param names so the proxy can strip them from the
 * forwarded query string.
 */
export function resolveUpstreamPath(
  route: Pick<PublicServiceRoute, 'upstreamPath' | 'placeholderDefaults' | 'id'>,
  searchParams: URLSearchParams,
): { path: string; consumed: Set<string> } {
  const consumed = new Set<string>()
  const defaults = route.placeholderDefaults ?? {}
  const path = route.upstreamPath.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const fromQuery = searchParams.get(name)
    let value: string | undefined
    if (fromQuery !== null) {
      value = fromQuery
      consumed.add(name)
    } else if (Object.prototype.hasOwnProperty.call(defaults, name)) {
      value = defaults[name]
    } else {
      throw new UpstreamPathPlaceholderError(
        `Route ${route.id} requires {${name}} placeholder but no value was supplied ` +
          `(no ?${name}= query param and no default in placeholderDefaults).`,
      )
    }
    if (!PLACEHOLDER_VALUE_PATTERN.test(value)) {
      throw new UpstreamPathPlaceholderError(
        `Route ${route.id} {${name}} placeholder value ${JSON.stringify(value)} ` +
          `must match ${PLACEHOLDER_VALUE_PATTERN}`,
      )
    }
    return value
  })
  return { path, consumed }
}
