export interface PublicServiceRoute {
  id: string
  service: string
  operation: string
  name: string
  category: string
  description: string
  method: string
  price: string
  /**
   * Which wallet type the AGENT uses to pay Router. Always 'stellar'
   * for the current catalog; this is the value exposed on the public
   * catalog JSON and is consumed by agent-side SDKs.
   */
  paymentMethod: 'stellar'
  /**
   * Which Tempo payment intent Router uses to pay the upstream
   * merchant. Fixed-price merchants (Firecrawl, Exa, Parallel) use
   * `tempo.charge` — a single-shot 402 settle per request. Dynamic-
   * price merchants (OpenRouter) use `tempo.session` — a long-lived
   * channel with streaming vouchers. This is an internal Router
   * concern; agents never see it.
   *
   * Default `tempo.charge` keeps backward compatibility. OpenRouter
   * is NOT flipped to `tempo.session` in the initial commit; the
   * operator flips it after running `scripts/open-channel.ts`
   * (see internaldocs/session-support-plan.md §6 step 11).
   */
  upstreamPaymentMethod: 'tempo.charge' | 'tempo.session'
  network: 'stellar-mainnet'
  asset: 'USDC'
  publicPath: string
  upstreamHost: string
  upstreamPath: string
}

export const PUBLIC_SERVICE_ROUTES: PublicServiceRoute[] = [
  {
    id: 'parallel_search',
    service: 'parallel',
    operation: 'search',
    name: 'Parallel Search',
    category: 'search',
    description: 'General web search routed through MPP Router.',
    method: 'POST',
    price: '$0.01/request',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.charge',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/parallel/search',
    upstreamHost: 'parallelmpp.dev',
    upstreamPath: '/api/search',
  },
  {
    id: 'exa_search',
    service: 'exa',
    operation: 'search',
    name: 'Exa Search',
    category: 'search',
    description: 'AI-powered web search routed through MPP Router.',
    method: 'POST',
    price: '$0.005/request',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.charge',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/exa/search',
    upstreamHost: 'exa.mpp.tempo.xyz',
    upstreamPath: '/search',
  },
  {
    id: 'firecrawl_scrape',
    service: 'firecrawl',
    operation: 'scrape',
    name: 'Firecrawl Scrape',
    category: 'web',
    description: 'Web page scraping routed through MPP Router.',
    method: 'POST',
    price: '$0.002/request',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.charge',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/firecrawl/scrape',
    upstreamHost: 'firecrawl.mpp.tempo.xyz',
    upstreamPath: '/v1/scrape',
  },
  {
    id: 'openrouter_chat',
    service: 'openrouter',
    operation: 'chat',
    name: 'OpenRouter Chat',
    category: 'ai',
    description: 'Chat completions routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    // Flipped to tempo.session on 2026-04-11 after
    // scripts/admin/open-tempo-channel.ts opened the $1 channel
    // 0x278bf3c7bb88da8d20de75a2cf0f8aec94c00fd399a1be5ae53911b1d83fac75
    // and persisted TempoChannelState to KV at
    // `tempoChannel:openrouter_chat`. See v2-full-session-design.md §B.
    // The router's payMerchantSession (src/mpp/tempo-client.ts)
    // reads that KV entry on every request and signs a voucher
    // off the stored cumulativeRaw high watermark.
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/openrouter/chat',
    upstreamHost: 'openrouter.mpp.tempo.xyz',
    upstreamPath: '/v1/chat/completions',
  },
]

/**
 * Public-catalog entry shape. The top-level fields match what
 * V1 agents have depended on since `/v1/services/catalog` first
 * shipped. The `methods` sub-object is a V2 addition that lets
 * channel-aware clients discover which Stellar intent(s) a route
 * accepts without probing the endpoint first. Its shape mirrors
 * what `https://mpp.dev/api/services` already publishes for its
 * upstream merchants (e.g. `methods.tempo.intents: ["session"]`).
 */
export interface PublicCatalogEntry {
  id: string
  name: string
  category: string
  description: string
  public_path: string
  method: string
  price: string
  /**
   * Legacy flat field. V1 agents read this to know they should
   * build a Stellar MPP client. V2 keeps it populated for
   * backward compatibility — do not remove.
   */
  payment_method: 'stellar'
  network: 'stellar-mainnet'
  asset: 'USDC'
  status: 'active'
  docs_url: string
  /**
   * V2 multi-intent discovery. Lists the Stellar MPP intents the
   * router is willing to accept for this route. Channel-aware
   * agents should prefer `"channel"` where available (lower
   * latency, no per-request Soroban simulate). Agents that only
   * know `"charge"` should keep using it — the router continues
   * to honor both on the same public_path.
   *
   * For routes whose upstream also happens to be session-mode
   * (`tempo.session` on the merchant side), this block also
   * advertises the upstream's intents as informational metadata
   * — it tells the operator (and curious agents) that the
   * router is performing a charge↔session bridge. Agents do NOT
   * need to care about the upstream half; router handles it.
   */
  methods: {
    stellar: {
      intents: Array<'charge' | 'channel'>
    }
    tempo?: {
      intents: Array<'charge' | 'session'>
      // upstream info only; agents never speak tempo directly
      role: 'upstream'
    }
  }
}

/**
 * Build the list of Stellar intents this route accepts. V2 default
 * is both `charge` and `channel` on every route so channel-aware
 * clients can discover the option. A future route-level override
 * could disable channel on a per-route basis (e.g. if a merchant
 * turns out to be too flaky under session-mode latency), but V2
 * initial rollout is uniform.
 */
function stellarIntentsFor(_route: PublicServiceRoute): Array<'charge' | 'channel'> {
  return ['charge', 'channel']
}

export function listPublicCatalog(): PublicCatalogEntry[] {
  return PUBLIC_SERVICE_ROUTES.map(route => ({
    id: route.id,
    name: route.name,
    category: route.category,
    description: route.description,
    public_path: route.publicPath,
    method: route.method,
    price: route.price,
    payment_method: route.paymentMethod,
    network: route.network,
    asset: route.asset,
    status: 'active',
    docs_url: `https://apiserver.mpprouter.dev/docs/integration#${route.id.replace(/_/g, '-')}`,
    methods: {
      stellar: {
        intents: stellarIntentsFor(route),
      },
      tempo: {
        intents: [route.upstreamPaymentMethod === 'tempo.session' ? 'session' : 'charge'],
        role: 'upstream' as const,
      },
    },
  }))
}

export function getRouteByPublicPath(pathname: string, method: string): PublicServiceRoute | undefined {
  return PUBLIC_SERVICE_ROUTES.find(route => route.publicPath === pathname && route.method === method.toUpperCase())
}
