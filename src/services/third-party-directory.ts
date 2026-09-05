/**
 * Curated third-party provider directory — listing-only, not payable here.
 *
 * ## Why this exists separately from the runtime registry
 *
 * `provider-registry.ts` holds providers who completed self-serve
 * onboarding: they proved control of the settlement address, we made a
 * real paid call, and their routes became payable *through this router* on
 * the direct-settlement path. That machinery is gated behind
 * `PROVIDERS_ENDPOINT_ENABLED` and its sibling flags, all of which are off
 * by default and whose activation is a founder decision because it changes
 * the production payment path.
 *
 * This file is the other half of the same story and deliberately touches
 * none of that. It is a **directory**: providers who have given written
 * permission to be listed, whose live prices and payout addresses we read
 * out of their own 402 responses, and whom a buyer pays **at the
 * provider's own URL**. We route no money for them and take no fee. A
 * directory entry can therefore ship with every payment flag still off,
 * which is exactly why it is modelled as a separate array rather than as
 * more rows in the catalog:
 *
 *   - it never enters `services[]`, so `payment_enabled`, the proxy gate
 *     and the 402 builder are untouched by construction;
 *   - it carries `payable_through_router: false` in every public surface,
 *     so no crawler can read a listing as "MPP Router will sell me this";
 *   - it cannot collide with a snapshot route, because it has no
 *     `publicPath` on our origin at all.
 *
 * If and when a directory provider completes signed/attested self-serve
 * onboarding, their routes appear in the registry and become payable
 * through us. The directory entry is then redundant and should be removed
 * rather than left to disagree with the live record.
 *
 * ## Prices and addresses are read, never typed
 *
 * Every `priceUsd` and every `payTo` below was read from the provider's
 * live 402 response, not from an email or a screenshot. The verification
 * test in `tests/third-party-directory.test.ts` re-asserts the structural
 * invariants (valid Stellar address, price shape, no blacklisted address);
 * the values themselves must be re-probed before any edit. The rule from
 * the onboarding packet applies here too: rediscover the address from the
 * live 402 immediately before changing it, and stop on any mismatch.
 */

export interface ThirdPartyPayout {
  /** CAIP-2 network id, as the provider's own 402 advertises it. */
  network: string
  /** The provider's own receiving address. Money never passes through us. */
  payTo: string
  /** Settlement asset symbol. */
  asset: string
  /** On-chain asset identifier (Stellar SAC / ERC-20 address), when published. */
  assetId?: string
}

export interface ThirdPartyRoute {
  /** Slug, unique within the provider. */
  operation: string
  method: 'GET' | 'POST'
  /** Absolute URL on the provider's own server. We do not proxy this. */
  resourceUrl: string
  /** Decimal USD per call, as advertised by the provider's live 402. */
  priceUsd: string
  description: string
  categories: string[]
  /**
   * Stellar transaction hash of the ROZO-funded evaluation purchase of
   * this exact route. Evaluation spend, not organic provider revenue —
   * see the packet in ainative for the accounting rule.
   */
  evaluationTxHash?: string
}

export interface ThirdPartyProvider {
  id: string
  /** Operator name, exactly as the provider asked to be named. */
  name: string
  homepage: string
  /** Origin the routes live on. Present for readers; we never call it. */
  apiBaseUrl: string
  /** Provider-published machine-readable manifest, when they serve one. */
  manifestUrl?: string
  payouts: ThirdPartyPayout[]
  routes: ThirdPartyRoute[]
  /** Where the permission to list came from, in the provider's own terms. */
  approval: {
    source: string
    receivedAt: string
    exclusive: false
    terms: string
  }
  /** When we last read these prices and addresses off the live endpoint. */
  livePricesReadAt: string
}

/**
 * Agent402.Tools — first directory listing.
 *
 * Written approval reached us on 2026-09-05 (founder-forwarded email from
 * Mike Petrillo, Agent402). He verified our five evaluation transactions on
 * Horizon and approved listing these five routes non-exclusively at live
 * prices, settling straight to the `payTo` his 402 publishes, with
 * "Agent402" as the named operator. He explicitly declined to sign anything
 * with the Stellar payout key — it is their treasury key — which is the
 * decision that produced the non-signature ownership proofs in
 * `provider-ownership.ts`.
 *
 * Prices and `payTo` below were re-read from live 402 responses on
 * 2026-09-05 (all five HTTP 402, one identical Stellar address, amounts at
 * 7 decimals: 30000 / 200000 / 100000 / 200000 / 100000).
 */
const AGENT402: ThirdPartyProvider = {
  id: 'agent402',
  name: 'Agent402',
  homepage: 'https://agent402.tools',
  apiBaseUrl: 'https://agent402.tools',
  manifestUrl: 'https://agent402.tools/.well-known/x402',
  payouts: [
    {
      network: 'stellar:pubnet',
      payTo: 'GDNJXCKW7ZM7GEEVP674TWPU26YJNBQ2FI4ZIPRKTPTNUEJMDHFJWWRL',
      asset: 'USDC',
      assetId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    },
  ],
  routes: [
    {
      operation: 'stablecoin-peg',
      method: 'GET',
      resourceUrl: 'https://agent402.tools/api/stablecoin-peg',
      priceUsd: '0.003',
      description: 'Live USD stablecoin peg deviation and stress status.',
      categories: ['crypto', 'data', 'monitoring'],
      evaluationTxHash: '4a0850f9567573904d04f9b211bbcd8d1c3afa2854092efd9021ed36cd1c1f4f',
    },
    {
      operation: 'web-search',
      method: 'GET',
      resourceUrl: 'https://agent402.tools/api/search',
      priceUsd: '0.020',
      description: 'Current web search results as structured JSON.',
      categories: ['search', 'web', 'data'],
      evaluationTxHash: '9a9cc601e30cd5fdba3523c84af8d35661119e88463bfa6598f1de98b34da790',
    },
    {
      operation: 'article-extract',
      method: 'POST',
      resourceUrl: 'https://agent402.tools/api/extract',
      priceUsd: '0.010',
      description: 'Extract a public webpage into clean Markdown.',
      categories: ['web', 'documents', 'extraction'],
      evaluationTxHash: '0b8a347b9fecc92e15237c248a2250e4d81276e720b8a88c00b11021677a3c6e',
    },
    {
      operation: 'browser-render',
      method: 'POST',
      resourceUrl: 'https://agent402.tools/api/render',
      priceUsd: '0.020',
      description: 'Render a JavaScript-heavy webpage and return Markdown.',
      categories: ['browser', 'web', 'extraction'],
      evaluationTxHash: 'f0ea77d9e7766ae87b5836ed8d3037b0cb7e9c221177686d48e2e488587b911e',
    },
    {
      operation: 'pdf-to-markdown',
      method: 'POST',
      resourceUrl: 'https://agent402.tools/api/pdf-to-markdown',
      priceUsd: '0.010',
      description: 'Convert a public PDF into Markdown.',
      categories: ['documents', 'pdf', 'extraction'],
      evaluationTxHash: '4193c7d547508d5d3fa486a93ce25c4120b97f2d2c3f73a8de6dd3a7df801bd1',
    },
  ],
  approval: {
    source: 'Written approval from Mike Petrillo (Agent402), founder-forwarded 2026-09-05.',
    receivedAt: '2026-09-05',
    exclusive: false,
    terms:
      'Non-exclusive listing of these five routes at the prices the live 402 advertises, ' +
      'settling directly to the payTo published by Agent402. Removable on request.',
  },
  livePricesReadAt: '2026-09-05',
}

export const THIRD_PARTY_DIRECTORY: readonly ThirdPartyProvider[] = [AGENT402]

/** One directory route, flattened for a public JSON surface. */
export interface ThirdPartyDirectoryEntry {
  id: string
  operator: { id: string; name: string; homepage: string }
  operation: string
  method: string
  description: string
  categories: string[]
  price: string
  price_usd: string
  /** The provider's own endpoint. Pay them there; we do not proxy it. */
  resource_url: string
  settlement: 'direct'
  /**
   * False for every entry in this file, and stated rather than implied:
   * the router does not sell these calls, issue a 402 for them, or take a
   * fee on them. A buyer pays the provider at `resource_url`.
   */
  payable_through_router: false
  payouts: Array<{ network: string; pay_to: string; asset: string; asset_id?: string }>
  evaluation_tx?: string
  listing_source: string
  listed_prices_read_at: string
}

export function listThirdPartyDirectory(): ThirdPartyDirectoryEntry[] {
  return THIRD_PARTY_DIRECTORY.flatMap(provider =>
    provider.routes.map(route => ({
      id: `${provider.id}_${route.operation.replace(/-/g, '_')}`,
      operator: { id: provider.id, name: provider.name, homepage: provider.homepage },
      operation: route.operation,
      method: route.method,
      description: route.description,
      categories: route.categories,
      price: `$${route.priceUsd}/request`,
      price_usd: route.priceUsd,
      resource_url: route.resourceUrl,
      settlement: 'direct' as const,
      payable_through_router: false as const,
      payouts: provider.payouts.map(p => ({
        network: p.network,
        pay_to: p.payTo,
        asset: p.asset,
        ...(p.assetId ? { asset_id: p.assetId } : {}),
      })),
      ...(route.evaluationTxHash ? { evaluation_tx: route.evaluationTxHash } : {}),
      listing_source: provider.approval.source,
      listed_prices_read_at: provider.livePricesReadAt,
    })),
  )
}
