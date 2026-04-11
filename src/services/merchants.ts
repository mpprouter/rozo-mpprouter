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
  /**
   * Path on the upstream merchant. May contain `{placeholder}`
   * tokens which the router substitutes from URL query params at
   * request time. Currently only used by the gemini route to let
   * clients pick a model: `/v1beta/models/{model}:generateContent`
   * + query `?model=gemini-2.0-flash` → `/v1beta/models/gemini-2.0-flash:generateContent`.
   *
   * Why `{name}` syntax instead of `:name`: Gemini's literal
   * upstream path contains `:generateContent` (a Google API
   * convention), so a `:name` placeholder syntax would collide
   * with literal colons. `{name}` is unambiguous and matches the
   * OpenAPI/RFC 6570 conventions agents are familiar with.
   *
   * If a placeholder is referenced but missing from both the
   * query and `placeholderDefaults`, the router emits 400. The
   * substitution is whitelist-based — only values matching
   * `[A-Za-z0-9._-]+` are allowed, so a malicious client cannot
   * inject path traversal or query strings.
   */
  upstreamPath: string
  /**
   * Default values for `:placeholder` tokens in upstreamPath.
   * Looked up by placeholder name when the request URL doesn't
   * carry the corresponding query param.
   */
  placeholderDefaults?: Record<string, string>
  /**
   * Verified end-to-end status. Operator-maintained flag set
   * after a real client call (agent → router → merchant → 200)
   * succeeded against this route on mainnet. The public catalog
   * exposes this so agents can filter to only-working routes,
   * and so the operator has a single place to track which
   * merchants need attention.
   *
   * Values:
   *   - `'session'`: route works end-to-end via tempo.session
   *     (router uses payMerchantSession + KV channel state)
   *   - `'charge'`: route works end-to-end via tempo.charge
   *     (router uses payMerchant, no KV channel needed)
   *   - `false`: route is registered (clients can hit it) but
   *     a recent client test failed for a reason that ISN'T the
   *     router's fault (merchant 5xx, deprecated upstream model,
   *     unfunded session channel, etc.)
   *   - omitted: untested / unknown. Treat as "best effort".
   *
   * Why a tristate instead of a boolean: we want clients to know
   * the difference between "router-side session channel is open
   * and works" vs "router-side charge fallback is the actual
   * dispatch path", because the per-request latency profile is
   * very different (charge = ~25s due to per-request settle,
   * session = ~8s with off-chain voucher). Agents that care
   * about latency budget choose accordingly.
   */
  verifiedMode?: 'session' | 'charge' | false
  /**
   * Optional human-readable status note shown alongside
   * `verifiedMode` in the public catalog. Use this to explain
   * WHY a route is `verifiedMode: false` so an agent operator
   * doesn't have to read the source.
   */
  verifiedNote?: string
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
    verifiedMode: 'charge',
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
    verifiedMode: 'charge',
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
    verifiedMode: 'charge',
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
    verifiedMode: 'session',
  },
  // ─── 2026-04-11 Task A: 8 additional Tempo session merchants ──────
  // All routes added in one batch. Each merchant id MUST exactly
  // match the key in scripts/admin/open-tempo-channel.ts MERCHANTS
  // so that payMerchantSession reads the right tempoChannel:<id>
  // KV record. See v2-todo.md#A and REMIND.md §3.
  {
    id: 'anthropic_messages',
    service: 'anthropic',
    operation: 'messages',
    name: 'Anthropic Messages',
    category: 'ai',
    description: 'Anthropic Claude chat completions routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/anthropic/messages',
    upstreamHost: 'anthropic.mpp.tempo.xyz',
    upstreamPath: '/v1/messages',
    verifiedMode: false,
    verifiedNote: 'Merchant returns 500 on direct mppx call (verified bypassing router). Both /v1/messages and /v1/chat/completions endpoints fail upstream. Channel is open but unusable until anthropic merchant is fixed.',
  },
  {
    id: 'openai_chat',
    service: 'openai',
    operation: 'chat',
    name: 'OpenAI Chat',
    category: 'ai',
    description: 'OpenAI chat completions routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/openai/chat',
    upstreamHost: 'openai.mpp.tempo.xyz',
    upstreamPath: '/v1/chat/completions',
    verifiedMode: 'session',
  },
  {
    id: 'gemini_generate',
    service: 'gemini',
    operation: 'generate',
    name: 'Google Gemini',
    category: 'ai',
    description: 'Google Gemini text generation routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/gemini/generate',
    upstreamHost: 'gemini.mpp.tempo.xyz',
    // 2026-04-11: clients pick the model via ?model=<name> query
    // param. The router substitutes {model} in the upstream path.
    // gemini-1.5-flash is deprecated upstream and returns 500;
    // gemini-2.0-flash is the current default. Other valid values
    // include gemini-1.5-pro, gemini-2.0-flash-exp, etc.
    upstreamPath: '/v1beta/models/{model}:generateContent',
    placeholderDefaults: { model: 'gemini-2.0-flash' },
    verifiedMode: 'session',
  },
  {
    id: 'dune_execute',
    service: 'dune',
    operation: 'execute',
    name: 'Dune SQL Execute',
    category: 'data',
    description: 'Dune Analytics SQL queries routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/dune/execute',
    // 2026-04-11: Dune lives at the actual api.dune.com domain per
    // mpp.dev/api/services. Earlier draft of v2-todo.md was wrong.
    upstreamHost: 'api.dune.com',
    upstreamPath: '/api/v1/sql/execute',
    verifiedMode: false,
    verifiedNote: 'Channel underfunded — Dune SQL execute charged $4 USDC initial probe charge but channel deposit was only $1. Cumulative > deposit, so the next voucher will be rejected. Needs a topup or a higher initial deposit.',
  },
  {
    id: 'modal_exec',
    service: 'modal',
    operation: 'exec',
    name: 'Modal Sandbox',
    category: 'compute',
    description: 'Modal sandbox code execution routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/modal/exec',
    upstreamHost: 'modal.mpp.tempo.xyz',
    upstreamPath: '/sandbox/exec',
    verifiedMode: false,
    verifiedNote: 'Merchant returns tempo.charge instead of session despite mpp.dev catalog. Router charge fallback fires correctly, but the modal forwarder rejects an empty {} body with 500. Need to find a body shape modal accepts.',
  },
  {
    id: 'alchemy_rpc',
    service: 'alchemy',
    operation: 'rpc',
    name: 'Alchemy ETH RPC',
    category: 'rpc',
    description: 'Alchemy Ethereum mainnet JSON-RPC routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/alchemy/rpc',
    // 2026-04-11: Alchemy lives at mpp.alchemy.com per mpp.dev catalog,
    // not alchemy.mpp.tempo.xyz. Earlier draft was wrong.
    upstreamHost: 'mpp.alchemy.com',
    upstreamPath: '/eth-mainnet/v2',
    // Alchemy actually serves tempo.charge despite mpp.dev claiming
    // session. Router charge fallback handles this transparently.
    verifiedMode: 'charge',
  },
  {
    id: 'tempo_rpc',
    service: 'tempo',
    operation: 'rpc',
    name: 'Tempo L2 RPC',
    category: 'rpc',
    description: 'Tempo L2 JSON-RPC routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/tempo/rpc',
    upstreamHost: 'rpc.mpp.tempo.xyz',
    upstreamPath: '/',
    verifiedMode: 'session',
  },
  {
    id: 'storage_upload',
    service: 'storage',
    operation: 'upload',
    name: 'Object Storage Upload',
    category: 'storage',
    description: 'Object Storage upload routed through MPP Router.',
    method: 'POST',
    price: 'dynamic',
    paymentMethod: 'stellar',
    upstreamPaymentMethod: 'tempo.session',
    network: 'stellar-mainnet',
    asset: 'USDC',
    publicPath: '/v1/services/storage/upload',
    upstreamHost: 'storage.mpp.tempo.xyz',
    upstreamPath: '/upload',
    // Storage serves tempo.charge for the multipart-init POST
    // endpoint. Router charge fallback handles dispatch.
    verifiedMode: 'charge',
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
  /**
   * Operator-verified end-to-end status. Indicates whether a real
   * client call (agent → router → merchant → 200) has been observed
   * for this route on mainnet, and which dispatch path the router
   * takes when forwarding.
   *
   * Values:
   *   - `'session'`: route works end-to-end via tempo.session.
   *     Lower latency (~8s), uses an open KV channel.
   *   - `'charge'`: route works end-to-end via tempo.charge.
   *     Higher latency (~25s), per-request settle, no KV channel
   *     needed.
   *   - `false`: route is registered but a recent client test
   *     failed for a reason that isn't the router's fault. See
   *     `verified_note`. Agents that need a working route should
   *     filter these out.
   *   - omitted: untested or status unknown. Treat as best-effort.
   *
   * Why this is in the catalog: agents that care about latency
   * budget can pre-filter to `verified_mode === 'session'`. Agents
   * that just want anything that works can pre-filter to
   * `verified_mode !== false`.
   */
  verified_mode?: 'session' | 'charge' | false
  /**
   * Operator note explaining a `verified_mode === false` status.
   * Tells the agent operator WHY a route is broken so they don't
   * have to read the source.
   */
  verified_note?: string
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
  return PUBLIC_SERVICE_ROUTES.map(route => {
    const entry: PublicCatalogEntry = {
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

export function getRouteByPublicPath(pathname: string, method: string): PublicServiceRoute | undefined {
  return PUBLIC_SERVICE_ROUTES.find(route => route.publicPath === pathname && route.method === method.toUpperCase())
}

/**
 * Whitelist for `:placeholder` substitution values. Restricts to
 * model-name-style identifiers so a client cannot inject path
 * traversal (`../`), query strings (`?`), or anchors (`#`).
 *
 * If you need to widen this for a future placeholder type (e.g.
 * an arbitrary network id with `/` in it), do it per-placeholder
 * with a route-specific override, NOT by relaxing this regex.
 */
const PLACEHOLDER_VALUE_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Substitute `{placeholder}` tokens in `route.upstreamPath` from a
 * URLSearchParams (request URL query). Falls back to per-route
 * defaults; throws when neither has a value, or when a value fails
 * validation. Returns the path with substitutions applied AND the
 * set of consumed param names so the proxy can strip them from the
 * forwarded query string.
 *
 * Substitution rule: `{name}` is replaced by the value of the
 * `name` query param, falling back to placeholderDefaults[name].
 * Curly-brace syntax is unambiguous — it does NOT collide with
 * literal colons in upstream paths like Google's
 * `/v1beta/models/{model}:generateContent`.
 *
 * Examples:
 *   resolveUpstreamPath('/v1beta/models/{model}:generateContent',
 *     route, new URLSearchParams('model=gemini-2.0-flash'))
 *     === { path: '/v1beta/models/gemini-2.0-flash:generateContent',
 *           consumed: new Set(['model']) }
 *
 *   resolveUpstreamPath('/v1beta/models/{model}:generateContent',
 *     route, new URLSearchParams())  // uses placeholderDefaults
 *     === { path: '/v1beta/models/gemini-2.0-flash:generateContent',
 *           consumed: new Set() }
 */
export class UpstreamPathPlaceholderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamPathPlaceholderError'
  }
}

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
        `Route ${route.id} requires :${name} placeholder but no value was supplied ` +
          `(no ?${name}= query param and no default in placeholderDefaults).`,
      )
    }
    if (!PLACEHOLDER_VALUE_PATTERN.test(value)) {
      throw new UpstreamPathPlaceholderError(
        `Route ${route.id} :${name} placeholder value ${JSON.stringify(value)} ` +
          `must match ${PLACEHOLDER_VALUE_PATTERN}`,
      )
    }
    return value
  })
  return { path, consumed }
}
