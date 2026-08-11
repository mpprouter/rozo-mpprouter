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
  /** Upstream service docs URLs from mpp.dev catalog */
  docs?: {
    homepage?: string
    llmsTxt?: string
    apiReference?: string
  }
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
  /**
   * Per-mode real-money verification, operator-maintained (carried in the
   * overlay). Independent of `verifiedMode` (which is a single legacy enum):
   * a route's downstream merchant may accept charge, session, or both, and
   * we may have verified one mode but not the other.
   *
   *   - `true`  — we ran a real-money test in this mode and it worked.
   *   - `false` — we tested this mode and it failed.
   *   - `null` / omitted — this mode is N/A for the route, or we have never
   *     tested it in this mode. (Distinct from `false`.)
   *
   * `*VerifiedAt` is the ISO timestamp of that verification (null/omitted
   * when not verified). Rendered to the catalog as `charge_rozo_verified` /
   * `charge_rozo_verified_at` / `session_rozo_verified` /
   * `session_rozo_verified_at`.
   */
  chargeVerified?: boolean | null
  chargeVerifiedAt?: string | null
  sessionVerified?: boolean | null
  sessionVerifiedAt?: string | null
  /**
   * Router-held upstream credential injection (Mercury MVP, 2026-08-12).
   *
   * Set ONLY for the small set of first-party-held-credential services
   * (currently: mercury). When present, `payMerchantAndGetBody` in
   * `proxy.ts` bypasses the Tempo merchant-payment dispatch entirely and
   * instead calls the upstream directly with `env[secretBinding]` injected
   * as the given header (never logged). Precedent: the hand-wired
   * `rozo-agent-api` admin bridge (`isRozoPayInvoiceRoute`) — this field
   * generalizes that pattern instead of adding a second hand-wired special
   * case per new router-held-credential provider.
   */
  upstreamAuth?: {
    /** Name of the `Env` field holding the credential. Never logged. */
    secretBinding: string
    /** Header name to set on the upstream request (e.g. `Authorization`). */
    header: string
    /** 'bearer' prefixes the value with `Bearer `; 'raw' sends it verbatim. Defaults to 'bearer'. */
    scheme?: 'bearer' | 'raw'
  }
  /**
   * Fixed-price mode (Mercury MVP). When present, the route has NO
   * merchant-side Tempo 402 to probe — the router sets its own price and
   * issues the 402 challenge to the agent itself (both mppx and
   * stellar.x402 dialects), skipping the unpaid merchant probe and the
   * Tempo pool balance preflight. Refund path is unchanged: an upstream
   * 5xx after settlement still triggers the existing auto-refund.
   */
  fixedPricing?: {
    /** Decimal USD string, e.g. "0.0005". */
    amountUsd: string
  }
  /**
   * Per-service daily rate cap, enforced in the proxy BEFORE payment via
   * the ATOMIC_STORE Durable Object CAS counter (see
   * `src/mpp/rate-limit-do.ts`). Protects a router-held upstream credential
   * from being exhausted by router-side traffic; independent of whatever
   * cap the upstream itself enforces on the credential.
   */
  rateLimit?: {
    perDay: number
  }
  /**
   * Launch gate (Mercury MVP, 2026-08-12 P1 fix). A route with
   * `verifiedMode: false` is normally 403'd by the SECURITY GATE in
   * `handleProxy` — but that means a brand-new router-held-credential
   * route can NEVER get its first real paid call verified, because
   * verifiedMode can only flip to a real value AFTER a successful paid
   * call. `launchGate` names an `Env` var; when `env[launchGate] ===
   * 'verify'` the route is allowed through the gate despite
   * `verifiedMode === false`, so the operator can make the one
   * first-paid-call test without advertising the route as verified or
   * opening it to the public ahead of that test. Unset (or any other
   * value) → still 403, same as today. Not carried to the public
   * catalog.
   */
  launchGate?: string
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
  /**
   * Override the snapshot-derived upstream path. Needed when the
   * snapshot publishes a literal wildcard (e.g. gemini's
   * `/{version}/models/*`) that `resolveUpstreamPath` cannot
   * substitute — the override supplies a fully-templated path
   * (`/{version}/models/{model}:generateContent`) whose `{name}`
   * placeholders resolve from query params / placeholderDefaults.
   * The overlay KEY still uses the snapshot-derived path.
   */
  upstreamPath?: string
  verifiedMode?: 'session' | 'charge' | false
  verifiedNote?: string
  placeholderDefaults?: Record<string, string>
  upstreamPaymentMethod?: 'tempo.charge' | 'tempo.session'
  /** Per-mode real-money verification flags + timestamps. See
   * PublicServiceRoute.chargeVerified for semantics. */
  chargeVerified?: boolean | null
  chargeVerifiedAt?: string | null
  sessionVerified?: boolean | null
  sessionVerifiedAt?: string | null
  /** See `PublicServiceRoute.upstreamAuth`. */
  upstreamAuth?: {
    secretBinding: string
    header: string
    scheme?: 'bearer' | 'raw'
  }
  /** See `PublicServiceRoute.fixedPricing`. */
  fixedPricing?: {
    amountUsd: string
  }
  /** See `PublicServiceRoute.rateLimit`. */
  rateLimit?: {
    perDay: number
  }
  /**
   * Launch gate (Mercury MVP, 2026-08-12 P1 fix). A route with
   * `verifiedMode: false` is normally 403'd by the SECURITY GATE in
   * `handleProxy` — but that means a brand-new router-held-credential
   * route can NEVER get its first real paid call verified, because
   * verifiedMode can only flip to a real value AFTER a successful paid
   * call. `launchGate` names an `Env` var; when `env[launchGate] ===
   * 'verify'` the route is allowed through the gate despite
   * `verifiedMode === false`, so the operator can make the one
   * first-paid-call test without advertising the route as verified or
   * opening it to the public ahead of that test. Unset (or any other
   * value) → still 403, same as today. Not carried to the public
   * catalog.
   */
  launchGate?: string
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
  /**
   * Names of the `{placeholder}` tokens in this route's upstream
   * path that the caller MUST supply, as query params on the router
   * URL (`?execution_id=01H…`) — not as path segments and not in the
   * body. Placeholders that have an operator-configured default are
   * omitted, since the caller does not have to supply them.
   *
   * Omitted entirely when the route has no required placeholders, so
   * v1 clients see no change. Added 2026-07-31 alongside GET route
   * support: the result-retrieval half of async APIs
   * (`/execution/{execution_id}/results`) is templated by nature, and
   * an agent cannot construct the call without knowing the names.
   */
  path_params?: string[]
  price: string
  /**
   * Legacy flat field. V1 agents read this to know they should
   * build a Stellar MPP client. V2 keeps it populated for
   * backward compatibility — do not remove.
   */
  payment_method: 'stellar'
  network: 'stellar-mainnet'
  asset: 'USDC'
  status: 'active' | 'limited'
  status_note?: string
  /**
   * Payment availability tier — orthogonal to `status` (which is about
   * docs availability, i.e. `llms_txt` present). Driven by the
   * operator's `verifiedMode` flag, NOT by mpp.dev. Updated 2026-06-23
   * (Option A): unverified routes are PAYABLE again; only confirmed-broken
   * routes are blocked.
   *
   *   - `'verified'`    — operator verified the full agent → router →
   *                       merchant chain with real money. Chargeable.
   *   - `'available'`   — route exists upstream and is chargeable, but we
   *                       have NOT verified it end-to-end. Payable; the
   *                       client decides its own risk via the
   *                       `*_rozo_verified` fields.
   *   - `'unavailable'` — known-broken (we real-money tested it and it
   *                       failed: merchant 5xx / bad path). NOT chargeable;
   *                       the proxy gate refuses it.
   */
  payment_status: 'verified' | 'available' | 'unavailable'
  /**
   * Convenience boolean: true iff the proxy will accept a charge for this
   * route (i.e. `payment_status !== 'unavailable'`). Both `verified` and
   * `available` routes are payable. Agents can gate on this without
   * string-matching `payment_status`.
   */
  payment_enabled: boolean
  /**
   * Human-readable explanation for `available` / `unavailable` routes so
   * a client (or operator) gets an actionable signal. Omitted for
   * `verified` routes.
   */
  payment_status_note?: string
  /**
   * Per-mode operator verification, surfaced so a paying agent can see
   * exactly what WE have vetted vs what is best-effort. See
   * PublicServiceRoute.chargeVerified for the true/false/null semantics
   * (null = N/A for this mode or never tested in it).
   */
  charge_rozo_verified: boolean | null
  charge_rozo_verified_at: string | null
  session_rozo_verified: boolean | null
  session_rozo_verified_at: string | null
  /**
   * Present (true) only for founder-curated recommended services.
   * Invariant: recommended implies paid-verified.
   */
  recommended?: true
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
      intents: Array<'charge'>
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
  /**
   * Optional wallet UX metadata. Hints only — never authoritative
   * over the live 402 challenge. Wallets must still validate live
   * challenge fields before signing.
   */
  payment_hints?: {
    network?: string
    intent?: 'charge' | 'channel'
    dialect?: 'mpp' | 'x402' | 'both'
    pay_to?: string
    amount_usdc?: string | null
    asset_sac?: string
    requires_classic_usdc_trustline?: boolean
    recommended_wallet_preflight?: Array<
      'account_exists' | 'classic_usdc_trustline' | 'usdc_balance_gte_amount' | 'xlm_reserve_ok'
    >
  }
  /** Upstream API documentation links. Clients should read these
   * (especially llms_txt) to learn the request body format — the
   * router forwards bodies as-is without transformation. */
  docs?: {
    homepage?: string
    llms_txt?: string
    api_reference?: string
  }
  verified_mode?: 'session' | 'charge' | false
  verified_note?: string
}
