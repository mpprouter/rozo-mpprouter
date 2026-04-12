/**
 * Type definitions for the public service catalog. Lives in its
 * own file so `build-routes.ts` can import these without pulling
 * in the catalog body (which would create a circular import via
 * `merchants.ts`).
 */

/**
 * A single proxied merchant route. Most fields come from the
 * mpp.dev catalog snapshot at build time; the verifiedMode /
 * verifiedNote / placeholderDefaults fields can be overridden per
 * route via the operator overlay (see
 * `merchants.ts → OPERATOR_OVERLAY`).
 */
export interface PublicServiceRoute {
  id: string
  service: string
  operation: string
  name: string
  /**
   * One or more category tags. mpp.dev publishes a string array per
   * service (e.g. `["ai", "media"]`). The router used to flatten
   * this to a single string; v2 (2026-04-12) keeps the array. The
   * legacy `category` field on `PublicCatalogEntry` is still
   * populated with `categories[0]` for backward compatibility with
   * old clients.
   */
  categories: string[]
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
   * merchant. Fixed-price merchants use `tempo.charge` (single-shot
   * 402 settle per request); dynamic merchants use `tempo.session`
   * (long-lived channel with streaming vouchers, requires the
   * operator to pre-open the channel via
   * `scripts/admin/open-tempo-channel.ts`).
   *
   * Important: this is a HINT for the dispatch helper. The router's
   * runtime payMerchantAndGetBody dispatches on the merchant's
   * actual `parsed.intent` value, so a wrong hint here doesn't
   * silently break a route — the router auto-corrects. The hint
   * matters for documentation and for KV channel pre-provisioning.
   */
  upstreamPaymentMethod: 'tempo.charge' | 'tempo.session'
  network: 'stellar-mainnet'
  asset: 'USDC'
  publicPath: string
  upstreamHost: string
  /**
   * Path on the upstream merchant. May contain `{placeholder}`
   * tokens which the router substitutes from URL query params at
   * request time. mpp.dev paths use `:placeholder` syntax; the
   * build step rewrites them to `{placeholder}` because that's
   * what `resolveUpstreamPath` in this file knows how to expand.
   *
   * If a placeholder is referenced but missing from both the
   * query and `placeholderDefaults`, the router emits 400. The
   * substitution is whitelist-based — only values matching
   * `[A-Za-z0-9._-]+` are allowed, so a malicious client cannot
   * inject path traversal or query strings.
   */
  upstreamPath: string
  /**
   * Default values for `{placeholder}` tokens in upstreamPath.
   * Looked up by placeholder name when the request URL doesn't
   * carry the corresponding query param.
   */
  placeholderDefaults?: Record<string, string>
  /**
   * Verified end-to-end status. Operator-maintained flag set
   * after a real client call (agent → router → merchant → 200)
   * succeeded against this route on mainnet. Carried in the
   * operator overlay (NOT generated from the snapshot — mpp.dev
   * doesn't know which routes a particular operator has tested).
   *
   * Values:
   *   - `'session'`: route works end-to-end via tempo.session.
   *     Lower latency (~8s), uses an open KV channel.
   *   - `'charge'`: route works end-to-end via tempo.charge.
   *     Higher latency (~25s), per-request settle, no KV channel.
   *   - `false`: route is registered but a recent client test
   *     failed for a reason that isn't the router's fault. See
   *     `verifiedNote`.
   *   - omitted: untested or status unknown. Treat as best-effort.
   */
  verifiedMode?: 'session' | 'charge' | false
  /**
   * Operator note explaining a `verifiedMode === false` status.
   * Tells the agent operator WHY a route is broken so they don't
   * have to read the source.
   */
  verifiedNote?: string
}

/**
 * Operator-controlled overrides applied to generated routes during
 * build. Keyed by `${serviceId}::${upstreamPath}` (the upstream
 * path AFTER `:name` → `{name}` rewriting, so it matches what the
 * generator emits). Allows operators to:
 *
 * - Override the auto-generated route id with a stable historical
 *   id (e.g. `parallel_search`) so existing client URL bookmarks
 *   keep working after the bulk import.
 * - Override the auto-generated publicPath the same way.
 * - Set verifiedMode / verifiedNote based on real testing — this
 *   info is operator-only, mpp.dev doesn't know it.
 * - Provide placeholderDefaults for routes with `{placeholder}`
 *   tokens (mpp.dev doesn't ship defaults).
 * - Override upstreamPaymentMethod when the operator has opened a
 *   session channel for a route the snapshot lists as charge.
 */
export interface PublicServiceRouteOverlay {
  id?: string
  publicPath?: string
  verifiedMode?: 'session' | 'charge' | false
  verifiedNote?: string
  placeholderDefaults?: Record<string, string>
  upstreamPaymentMethod?: 'tempo.charge' | 'tempo.session'
}

/**
 * Public-catalog entry shape. The top-level fields match what
 * V1 agents have depended on since `/v1/services/catalog` first
 * shipped. The `methods` sub-object is a V2 addition that lets
 * channel-aware clients discover which Stellar intent(s) a route
 * accepts without probing the endpoint first.
 */
export interface PublicCatalogEntry {
  id: string
  name: string
  /**
   * Legacy single-string category, populated as `categories[0]`
   * for backward compatibility with v1 clients that don't know
   * about the multi-category array.
   */
  category: string
  /**
   * v2 multi-category. Mirrors mpp.dev's array shape.
   */
  categories: string[]
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
   * router is willing to accept for this route, plus the upstream
   * tempo intents for informational purposes.
   *
   * The optional `stellar_x402` block is the x402-over-Stellar
   * recipient + asset, present only when `X402_ENABLED=true`.
   */
  methods: {
    stellar?: {
      intents: Array<'charge' | 'channel'>
    }
    stellar_x402?: {
      scheme: 'exact'
      network: string
      pay_to: string
      asset: string
    }
    tempo?: {
      intents: Array<'charge' | 'session'>
      role: 'upstream'
    }
  }
  verified_mode?: 'session' | 'charge' | false
  verified_note?: string
}
