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

export interface PublicCatalogEntry {
  id: string
  name: string
  category: string
  description: string
  public_path: string
  method: string
  price: string
  payment_method: 'stellar'
  network: 'stellar-mainnet'
  asset: 'USDC'
  status: 'active'
  docs_url: string
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
  }))
}

export function getRouteByPublicPath(pathname: string, method: string): PublicServiceRoute | undefined {
  return PUBLIC_SERVICE_ROUTES.find(route => route.publicPath === pathname && route.method === method.toUpperCase())
}
