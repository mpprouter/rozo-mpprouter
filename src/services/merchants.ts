export interface PublicServiceRoute {
  id: string
  service: string
  operation: string
  name: string
  category: string
  description: string
  method: string
  price: string
  paymentMethod: 'stellar'
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
