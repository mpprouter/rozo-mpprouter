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
/**
 * Service-level overlay — applied to EVERY route of a service before
 * the per-route `OPERATOR_OVERLAY` below (which still wins on any
 * field it sets).
 *
 * This exists for whole-provider outages. Marking 45 routes broken one
 * key at a time is error-prone and invites a half-disabled provider,
 * which is worse than either state: the catalog keeps advertising the
 * routes someone forgot, and agents keep paying into them.
 *
 * Only `verifiedMode` / `verifiedNote` are honoured here on purpose.
 * Identity fields (id, publicPath, placeholderDefaults) are per-route
 * by nature and must stay in OPERATOR_OVERLAY.
 */
export const SERVICE_OVERLAY: Record<string, PublicServiceRouteOverlay> = {
  // Nansen — 2026-07-31: every route is broken upstream.
  //
  // Probed 10/10 routes unpaid, all returned
  // `502 Merchant returned 402 without WWW-Authenticate header`
  // (see proxy.ts). The merchant answers 402 but omits the challenge
  // header, so an agent cannot construct a payment at all — the route
  // is unusable, not merely unverified.
  //
  // 45 of these were advertised as payable, ~9% of the payable
  // catalog. Advertising a route we know cannot settle spends the
  // caller's time and trust, so they are marked unpayable until the
  // upstream emits a valid challenge. Re-probe before re-enabling.
  nansen: {
    verifiedMode: false,
    verifiedNote:
      'Upstream returns 402 without a WWW-Authenticate challenge header on ' +
      'every probed route (10/10 on 2026-07-31), so no payment can be ' +
      'constructed. Disabled provider-wide until the merchant emits a valid ' +
      'challenge; re-probe before re-enabling.',
  },
}

// Founder-curated recommended services (2026-08-10) surfaced first by
// discovery UIs. Invariant: only paid-verified services may appear here —
// audit trail in docs/verified-runs.json.
const RECOMMENDED_SERVICE_IDS = new Set([
  // anthropic_chat_completions removed 2026-08-18 — delisted below after a
  // paid re-probe showed the merchant leg failing on every call. The
  // invariant above is that only paid-verified services appear here.
  'coingecko_simple_price',
  'deepseek_chat',
  'exa_search',
  'firecrawl_scrape',
  'groq_chat',
  'mistral_mistral_chat',
  'parallel_search',
  'perplexity_perplexity_chat',
  'tavily_tavily_search',
])

export const OPERATOR_OVERLAY: Record<string, PublicServiceRouteOverlay> = {
  // Parallel Search — first verified route, hand-tested 2026-04-11
  'parallel::/api/search': {
    id: 'parallel_search',
    publicPath: '/v1/services/parallel/search',
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-04-11T00:00:00Z',
  },
  // Exa AI Search
  'exa::/search': {
    id: 'exa_search',
    publicPath: '/v1/services/exa/search',
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-04-11T00:00:00Z',
  },
  // Firecrawl Scrape
  'firecrawl::/v1/scrape': {
    id: 'firecrawl_scrape',
    publicPath: '/v1/services/firecrawl/scrape',
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-04-11T00:00:00Z',
  },
  // OpenRouter Chat — flipped to tempo.session 2026-04-11 after
  // open-tempo-channel.ts opened the $1 channel
  // 0x278bf3c7bb88da8d20de75a2cf0f8aec94c00fd399a1be5ae53911b1d83fac75
  // and persisted TempoChannelState to KV at
  // `tempoChannel:openrouter_chat`. payMerchantSession reads that
  // KV entry on every request.
  // 2026-08-01: disabled. Real-money re-verification settles the payment
  // and then fails upstream. Reproduced by calling the merchant DIRECTLY
  // with mppx tempo.charge (router entirely out of the loop), from two
  // different client networks, with byte-identical output — so the fault
  // is in the merchant → OpenRouter leg, not ours:
  //   401 {"error":{"message":"User not found.","code":401}}
  // An invalid key against openrouter.ai returns the same body, and
  // OpenRouter documents 401 as key missing/invalid/revoked. Filed as
  // tempoxyz/mpp#852. NOT the NANOUSD regression (tempoxyz/mpp#840),
  // which the Tempo team fixed on 2026-07-30.
  'openrouter::/v1/chat/completions': {
    id: 'openrouter_chat',
    publicPath: '/v1/services/openrouter/chat',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      "Merchant's upstream OpenRouter authentication is missing, invalid or " +
      'revoked: 401 "User not found." after the payment settles. Reproduced ' +
      'bypassing the router (2026-08-01). Filed upstream as tempoxyz/mpp#852; ' +
      're-verify with a real paid call before re-enabling. Re-tested 2026-08-09: still 401 "User not found." — merchant key still bad.',
  },
  // Anthropic OpenAI-compatible chat completions — verified 2026-08-09.
  // The merchant only serves CURRENT-generation Claude models; the stale
  // 2024 ids we were testing with (claude-3-5-haiku-20241022,
  // claude-3-7-sonnet-latest, claude-3-haiku-20240307) all 404, which is
  // why this provider looked broken. Verified working with real paid
  // calls (202, completion returned) on: claude-sonnet-4-5,
  // claude-haiku-4-5, claude-opus-4-5, claude-opus-4-8, claude-sonnet-5,
  // claude-opus-5.
  //
  // upstreamPaymentMethod pinned to tempo.charge (2026-08-13). Without this
  // pin, `pickUpstreamPaymentMethod()` derives `tempo.session` from the
  // catalog snapshot, where the anthropic SERVICE advertises
  // `methods.tempo.intents = ["session"]`. That derivation is wrong for this
  // route, and three independent facts prove it:
  //
  //   1. The 2026-08-09 verification above made REAL PAID CALLS that returned
  //      202 with completions (commit 4810293).
  //   2. Production KV holds no `tempoChannel:anthropic_chat_completions`
  //      entry (operator read, 2026-08-13). Channels exist only for
  //      anthropic_messages, dune_execute, gemini_generate, openai_chat,
  //      openrouter_chat and tempo_rpc.
  //   3. `payMerchantSession()` throws ChannelNotInstalledError immediately
  //      when no channel is installed — it cannot pay without one.
  //
  // A session-mode call was therefore impossible, so those paid calls went
  // through charge. They succeeded because the proxy dispatches on the
  // merchant's LIVE 402 `parsed.intent` and only treats this field as a hint
  // (proxy.ts:645-655), auto-correcting the bad derivation at runtime and
  // logging a mismatch note each time.
  //
  // Pinning it changes no proxy behaviour: `upstreamPaymentMethod` is read
  // nowhere in proxy.ts except that log line, and the public catalog derives
  // `payment_hints` from `verifiedMode` via `stellarIntentsFor`, never from
  // this field. What it does fix is every consumer that reads the hint
  // STATICALLY rather than from a live challenge — the playground's upstream
  // dispatch does exactly that, and would otherwise send these models down
  // the session path and 503 on the missing channel.
  //
  // If the merchant ever starts advertising `charge` at the service level, or
  // an operator opens a channel for this route, revisit — but the proxy will
  // keep auto-correcting either way.
  // 2026-08-18: DELISTED. Same shape as openrouter and openai above — the
  // agent's payment settles, then the merchant's own call upstream is
  // refused, and the router auto-refunds ~25s later. Re-probed with real
  // paid calls on 2026-08-18: every attempt returned
  //   502 "Merchant payment failed" (merchant leg 403 forbidden)
  // followed by a confirmed on-chain refund. The refund machinery worked,
  // which is precisely why this stayed listed as charge-verified for days:
  // callers got their money back and the route looked healthy from the
  // catalog's point of view. Automatic refunds are not a substitute for a
  // route that delivers, so it is marked unpayable until a paid re-probe
  // returns a completion.
  //
  // Corroborating signal that predates this: wrangler.toml already carries
  // PLAYGROUND_CHAT_MODELS_DISABLED = "anthropic,..." (2026-08-13) for the
  // same post-payment 403. That killswitch only covered the playground; the
  // public catalog kept advertising the route.
  //
  // The sibling anthropic_messages route settles through an installed Tempo
  // channel (session dialect) and is a different upstream path, so it was not
  // delisted alongside this one — it was re-probed instead, later the same
  // day, and failed identically. It is now delisted too; see the evidence in
  // the comment on that entry below.
  'anthropic::/v1/chat/completions': {
    id: 'anthropic_chat_completions',
    publicPath: '/v1/services/anthropic/chat_completions',
    upstreamPaymentMethod: 'tempo.charge',
    // Founder decision 2026-08-20: keep this route payable as the LIVE
    // REFUND DEMO. The merchant leg 403s on every call (confirmed with
    // paid re-probes 2026-08-18 and 2026-08-19), so each paid call
    // settles and is then automatically refunded in full within 1-2
    // minutes — which is exactly the behaviour refund testing and the
    // SCF44 tranche-2 video need to demonstrate. Do NOT delist it again
    // for being undeliverable; that is the point. Delist only if the
    // refund path itself stops working.
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-24T02:44:14Z',
    verifiedNote:
      'Delivers completions. Re-verified 2026-08-24 with a real paid call ' +
      'through the router (claude-haiku-4-5, settled 0.001 USDC, 200 with a ' +
      'completion, no refund). The 403-after-payment recorded from ' +
      '2026-08-18 no longer reproduces.',
    // Facade: registered per founder decision 2026-08-24. A normal service
    // registration.
    //
    // Correcting the record, because two rounds of notes here were wrong and
    // the reasoning matters more than the conclusion:
    //
    // The 'REFUND DEMO' framing said this route never delivers a completion.
    // A paid call through the router on 2026-08-24 returned 200 with a real
    // completion and no refund, so that is simply not true any more --
    // whatever the merchant was refusing on 2026-08-18 has been fixed.
    //
    // Earlier the same day, two DIRECT paid probes (bypassing the router)
    // still returned 403 and were briefly read as the merchant blocking us.
    // They were run from a machine egressing in Hong Kong, which Anthropic
    // does not serve; bypassing the router means the probe carries the
    // operator's own IP rather than Cloudflare's. Direct-probe results are
    // therefore NOT evidence about the production path. Verify this provider
    // through the router.
    //
    // Model ids: the merchant answers the rolling alias with a pinned build
    // (claude-haiku-4-5 -> claude-haiku-4-5-20251001). Same model; the ledger
    // treats a version-pin suffix as not a substitution.
    facade: {
      models: [
        { id: 'claude-opus-5', available: true },
        { id: 'claude-sonnet-5', available: true },
        { id: 'claude-opus-4-8', available: true },
        { id: 'claude-haiku-4-5', available: true },
      ],
    },
  },
  // Anthropic Messages — the native /v1/messages endpoint.
  //
  // DELISTED 2026-08-18, same day and same failure as the chat_completions
  // sibling above. When that route was delisted, this one was kept listed on
  // the argument that it is a different upstream path settling through an
  // installed Tempo channel (session dialect), so the charge-path failure did
  // not necessarily apply to it. That argument was explicitly marked as
  // needing a paid re-probe, because its newest evidence was 2026-08-09.
  //
  // The re-probe was run the same day and the argument did not survive it.
  // Two real paid mainnet calls, both with current-generation model ids that
  // the merchant is known to serve:
  //
  //   claude-haiku-4-5   09:47:30Z  tx 832cd401...fc2152  → 502, merchant 403
  //   claude-sonnet-4-5  09:48:03Z  tx ef7984cd...da09b69  → 502, merchant 403
  //
  // Both settled on chain, both then failed the merchant leg with a byte
  // identical `{"error":{"type":"forbidden","message":"Request not allowed"}}`,
  // and both were ledgered with `upstream_status: 403` and handed to the
  // refund path (`GET /v1/ledger?tx=<hash>`). Two different model ids ruling
  // out a stale id, and an identical error to the charge route, mean the block
  // sits at the merchant/provider level rather than on either settlement
  // path — the session channel is irrelevant to it.
  //
  // As with the sibling, the refund path engaged rather than the money being
  // lost — the first of the two was confirmed `refunded` on chain, and working
  // refunds are exactly why this looked healthy from the catalog's point of
  // view. A route that takes payment and gives it back is still a route that
  // never delivers, so it is not advertised as payable. Re-verify with a paid
  // call that returns an actual completion before relisting.
  //
  // (That re-verification happened on 2026-08-24 and passed — see the entry
  // below. The history above is kept because it is the reasoning that made
  // the delisting right at the time, not a description of today.)
  //
  // (Refund timing on this session-dialect route ran slower than the ~25s
  // observed on the charge-dialect sibling; noted in docs/verified-services.md
  // as a separate question, and immaterial to this delisting either way.)
  'anthropic::/v1/messages': {
    id: 'anthropic_messages',
    publicPath: '/v1/services/anthropic/messages',
    upstreamPaymentMethod: 'tempo.session',
    // RELISTED 2026-08-24 on a real paid call through the router, which is
    // the only evidence that ever settles this route's status.
    //
    //   POST /v1/services/anthropic/messages  model=claude-haiku-4-5
    //   -> 200, Anthropic-native completion, no refund, signed receipt
    //   (served claude-haiku-4-5-20251001, the pinned build of that alias)
    //
    // The 2026-08-18 delisting was correct when written; the merchant has
    // since been fixed, and the sibling chat_completions route was
    // re-verified the same day. The launchGate added earlier today did its
    // job — a delisted route is 403'd before it can be paid, so it could
    // never earn the verification that relists it — and is removed again now
    // that the route is listed on its own merits.
    //
    // Note for the next re-probe: verify through the ROUTER. A direct probe
    // that bypasses it carries the operator's own IP, and Anthropic does not
    // serve every region; that is what produced a false 403 on 2026-08-24.
    verifiedMode: 'session',
    sessionVerified: true,
    sessionVerifiedAt: '2026-08-24T03:18:26Z',
    verifiedNote:
      'Delivers completions. Re-verified 2026-08-24 with a real paid call ' +
      'through the router (claude-haiku-4-5, 200 + native completion, no ' +
      'refund). The 403-after-payment recorded on 2026-08-18 no longer ' +
      'reproduces. Verify through the router, not a direct merchant probe.',
  },
  // 2026-08-01: disabled. Same shape as openrouter above — the payment
  // settles, then the merchant's own call to OpenAI is refused:
  //   403 {"error":{"code":"unsupported_country_region_territory", ...}}
  // Reproduced calling the merchant DIRECTLY with mppx tempo.charge from
  // two different client networks, byte-identical, so it is the
  // merchant → OpenAI leg. We cannot tell from outside whether the
  // restriction is on the gateway's egress, its OpenAI organization, or
  // the key — all three sit upstream of us. Filed as tempoxyz/mpp#852.
  // NOT the NANOUSD regression (#840), fixed 2026-07-30.
  'openai::/v1/chat/completions': {
    id: 'openai_chat',
    publicPath: '/v1/services/openai/chat',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: 'session',
    sessionVerified: true,
    sessionVerifiedAt: '2026-08-09T03:51:00Z',
    verifiedNote:
      'Verified with a real paid call on 2026-08-09: 202, chat completion ' +
      'returned. The earlier post-settlement 403 (2026-08-01, filed as ' +
      'tempoxyz/mpp#852) no longer reproduces.',
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
  // `/v1beta/models/gemini-2.0-flash:generateContent`. Fixed via the
  // `upstreamPath` overlay override below.
  // The PAYMENT path (session voucher + descriptor) is verified working.
  'gemini::/{version}/models/*': {
    id: 'gemini_generate',
    publicPath: '/v1/services/gemini/generate',
    upstreamPaymentMethod: 'tempo.session',
    // upstreamPath override replaces the snapshot's literal `*` wildcard
    // with a fully-templated path, unblocking the pay-then-404 documented
    // in the 2026-06-22 E2E (payment/session layer was already verified
    // working then). `{version}` and `{model}` resolve from query params
    // or placeholderDefaults below. verifiedMode stays false — the path
    // fix is a prerequisite for, not a substitute for, a fresh real-money
    // E2E. Flip to verifiedMode: 'session' + sessionVerified only after
    // that E2E passes post-deploy.
    upstreamPath: '/{version}/models/{model}:generateContent',
    verifiedMode: false,
    verifiedNote:
      'Session/payment layer verified 2026-06-22 (descriptor captured). ' +
      'Upstream 404 fixed via upstreamPath override — the snapshot wildcard ' +
      '`/{version}/models/*` is now templated as ' +
      '`/{version}/models/{model}:generateContent`. Re-tested with a real ' +
      'paid call 2026-08-09: the path fix works (the request now reaches ' +
      "Google), but the merchant's own Google API key is rejected — 400 " +
      '"API key not valid". Stays verifiedMode:false until the merchant ' +
      'fixes its key.',
    placeholderDefaults: { version: 'v1beta', model: 'gemini-2.0-flash' },
  },
  // Dune SQL Execute — delisted by founder decision 2026-09-02 (reason text
  // approved verbatim). Background, not shown publicly: the session channel
  // was underfunded ($4 probe charge vs $1 deposit) and the founder chose not
  // to top it up. Re-listing needs a real paid verification first.
  'dune::/api/v1/sql/execute': {
    id: 'dune_execute',
    publicPath: '/v1/services/dune/execute',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      'Not listed for now: this route is comparatively expensive ' +
      '($0.05–$4 per request) and has not been verified end-to-end by Rozo. ' +
      'If you need Dune SQL through the router, contact us and we will ' +
      'enable it on request.',
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
  // 2026-08-01: disabled. This is a PAY-THEN-FAIL, the failure mode this
  // catalog exists to prevent, so it is recorded plainly: the agent's
  // Stellar payment settled (0.0010000 USDC, tx
  // 05406b45ea6a3638...), then the merchant rejected the router's
  // Tempo-side payment because its own upstream refused it —
  //   402 verification-failed / "Status: 403
  //   URL: https://tempo-mainnet.g.alchemy.com/v2/..."
  // — and the agent got a 502 with no result. Detected by the
  // real-money verification round and delisted the same day.
  'alchemy::/{network}/v2': {
    id: 'alchemy_rpc',
    publicPath: '/v1/services/alchemy/rpc',
    upstreamPaymentMethod: 'tempo.charge',
    verifiedMode: false,
    verifiedNote:
      'Pay-then-fail on 2026-08-01: the Stellar payment settled, then the ' +
      "merchant's upstream (tempo-mainnet.g.alchemy.com) returned 403 and the " +
      'call failed with no result. Delisted until the merchant is fixed; ' +
      're-verify with a real paid call before re-enabling.',
    placeholderDefaults: { network: 'eth-mainnet' },
  },
  // ---------------------------------------------------------------
  // paywithlocus AI family — charge-verified 2026-08-01 with real
  // Stellar-USDC paid calls. Each entry cites the settling transaction
  // so the flag is auditable rather than asserted; verify any of them at
  // https://stellar.expert/explorer/public/tx/<hash>
  // ---------------------------------------------------------------
  // Tavily search — paid 0.0900000 USDC 2026-08-10, live search results
  // returned end-to-end.
  // tx 38eaecde40d6430654212bf59b32eb0e1275a6b5f8e3d958be8a56ec71649952
  'tavily::/tavily/search': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-10T07:56:49Z',
  },
  // Grok (xAI) chat — paid 0.0010000 USDC, live grok-3-mini completion.
  // tx bd4ff356ce96b095be1654209ef84cce7a53a62b0b606421b4b4c5b9d1121b96
  'grok::/grok/chat': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-01T16:10:11Z',
    // Facade: the advertised id is the one the merchant actually runs.
    //
    // 2026-08-24: a paid call through the facade asking for `grok-3-mini`
    // returned 200 with `"model":"grok-4.3"` in the body — the merchant
    // accepts the older id but silently substitutes a different model. A
    // direct paid probe confirmed `grok-4.3` is served under its own name.
    // Advertising `grok-3-mini` therefore told callers they were getting a
    // model they were not.
    //
    // `grok-3-mini` is kept listed-but-unavailable rather than deleted, so a
    // caller still using it gets a 400 BEFORE paying, naming the id to switch
    // to — deleting it would produce the same 400 with no hint of why.
    facade: {
      models: [
        { id: 'grok-4.3', available: true },
        {
          id: 'grok-3-mini',
          available: false,
          unavailableReason: 'The upstream silently serves grok-4.3 for this id (paid probes 2026-08-24). Use grok-4.3 so the model you request is the model you get.',
        },
      ],
    },
  },
  // Mistral chat — paid 0.0080000 USDC, live completion.
  // tx acd8d604c6af05ee47e91e88fcd59ba421fd3be3a2fad72fcadd698ea6868973
  'mistral::/mistral/chat': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-01T16:10:27Z',
    // Facade: id resolved 2026-08-24 rather than guessed. The paid
    // /mistral/models call (0.005 USDC) listed `mistral-medium-2505`
    // (capabilities.completion_chat true), and a follow-up paid /mistral/chat
    // (0.008 USDC) returned a real completion echoing that same id back.
    facade: { models: [{ id: 'mistral-medium-2505', available: true }] },
  },
  // Perplexity chat — paid 0.0092200 USDC, live sonar completion.
  // tx e17f10439d37aafd9594d6f1ef8173a7bdd9657632138bd83c39dad23c93359d
  // First attempt that round returned a transient upstream 502 with no
  // payment taken; the retry settled. Flagged charge-verified on the
  // successful paid call, not the probe.
  'perplexity::/perplexity/chat': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-01T16:26:16Z',
    // Facade: `sonar` confirmed 2026-08-24 by a paid /perplexity/chat call
    // (0.00922 USDC) that returned a real completion with citations. The
    // upstream publishes no list-models endpoint, so this id comes from the
    // paid call itself rather than a catalog listing.
    facade: { models: [{ id: 'sonar', available: true }] },
  },
  // Deepgram list-models — paid 0.0040000 USDC, model list returned.
  // tx 035adb0f16b269d59503b4eadbafc8cfb5a4c3deab187af914f1aeb44ec057d5
  'deepgram::/deepgram/list-models': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-01T16:11:11Z',
  },
  // Tempo L2 RPC — 2026-08-01: disabled, also a pay-then-fail.
  // The paid request returns 202 with an async job id, and every poll of
  // the job URL then answers 401 indefinitely (79 consecutive attempts
  // observed before we aborted). The agent paid 0.0010000 USDC
  // (tx 83c1ec857138b4f8...) and can never retrieve a result.
  'rpc::/': {
    id: 'tempo_rpc',
    publicPath: '/v1/services/tempo/rpc',
    upstreamPaymentMethod: 'tempo.session',
    verifiedMode: false,
    verifiedNote:
      'Pay-then-fail on 2026-08-01: payment settles and the merchant returns ' +
      'an async job id, but polling that job returns 401 forever, so the paid ' +
      'result is unobtainable. Delisted until the merchant is fixed. ' +
      'A 2026-08-09 re-test returned 202 again — that is the START of this ' +
      'failure, not proof of delivery, so it stays delisted until a test ' +
      'polls the job to completion.',
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
    chargeVerified: true,
    chargeVerifiedAt: '2026-06-22T00:00:00Z',
    // Facade: `deepseek-v4-flash` was echoed back verbatim by a real paid
    // call (2026-06-22 through the router; re-verified 2026-08-13 direct to
    // the merchant, see src/playground/models.ts).
    facade: { models: [{ id: 'deepseek-v4-flash', available: true }] },
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
    chargeVerified: true,
    chargeVerifiedAt: '2026-06-22T00:00:00Z',
    // Facade: kept listed-but-unavailable so the id is rejected at
    // validation time (400, before any payment) instead of vanishing.
    facade: {
      models: [{
        id: 'llama-3.1-8b-instant',
        available: false,
        unavailableReason: 'Paid re-probe on 2026-08-24 returned model_not_found after payment.',
      }],
    },
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
    chargeVerified: true,
    chargeVerifiedAt: '2026-06-22T00:00:00Z',
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
  // ---------------------------------------------------------------
  // SCF #44 Tranche 2 — "top 20 services verified payable"
  //
  // Six services charge-verified on 2026-08-18 with real mainnet USDC
  // through the production Router (payer masked `GD5R4H...BB4U`). Each
  // entry below is backed by a 200 + real response body from a single
  // paid call; the settling Stellar tx hash is in the verifiedNote and
  // is publicly auditable at
  // `https://stellar.expert/explorer/public/tx/<hash>`. Full run log,
  // including the routes that were probed and rejected, is in
  // `docs/verified-services.md`.
  //
  // Chosen for reviewer recognisability and category spread — image
  // generation, market data, weather, translation, maps, computational
  // knowledge — rather than depth on any one provider. Only `id`/
  // `publicPath` are deliberately omitted so the generated values from
  // `buildRoutesFromMppSnapshot` continue to apply; these entries set
  // verification state and nothing else.
  // ---------------------------------------------------------------
  'fal::/fal-ai/flux/schnell': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T03:22:45Z',
    verifiedNote:
      'charge-verified 2026-08-18T03:22:45Z, Stellar tx ' +
      '7ee4ce8c359bebe4a4c94f94d9f815ff65b2faafe67a555a88d36f787ab6f9a1 ' +
      '(see docs/verified-services.md). $0.003/request, returned a real ' +
      'generated image URL. Cheapest deterministic fal.ai model — the ' +
      'pricier flux-pro / video routes remain unprobed.',
  },
  'alphavantage::/alphavantage/company-overview': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T03:23:14Z',
    verifiedNote:
      'charge-verified 2026-08-18T03:23:14Z, Stellar tx ' +
      'fc0296e6991beb22aee5923784df1de1e7971fb0c3f89d9db9a93ef6df1698f6 ' +
      '(see docs/verified-services.md). $0.008/request, returned a full ' +
      'IBM fundamentals record. The other 25 Alpha Vantage routes share ' +
      'this price and upstream but are individually unprobed.',
  },
  'openweather::/openweather/current-weather': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T03:23:31Z',
    verifiedNote:
      'charge-verified 2026-08-18T03:23:31Z, Stellar tx ' +
      'f5dfdc09cae3c3923769ada23bcc41f811f9e574157a8f90b3cabbeb11d761d9 ' +
      '(see docs/verified-services.md). $0.006/request, returned live ' +
      'San Francisco conditions.',
  },
  'deepl::/deepl/languages': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T03:24:29Z',
    verifiedNote:
      'charge-verified 2026-08-18T03:24:29Z, Stellar tx ' +
      '1a47118ef2f625ef0571cbb1ce028aad867f0d278e34a51c0a949b0a93edafea ' +
      '(see docs/verified-services.md). $0.005/request, returned the full ' +
      'supported-language list. Picked over deepl/translate because ' +
      'translate is dynamically priced ($0.025+, scales with text length) ' +
      'and so is a poor fixed-cost verification target.',
  },
  'mapbox::/mapbox/geocode-forward': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T03:24:51Z',
    verifiedNote:
      'charge-verified 2026-08-18T03:24:51Z, Stellar tx ' +
      '9592b917d7d2e7ea90fccede90e873191ce16ba6a846a4a74b2338ad1f817e51 ' +
      '(see docs/verified-services.md). $0.00375/request, returned a real ' +
      'GeoJSON FeatureCollection for "San Francisco". Fills the maps slot ' +
      'because every googlemaps route 404s on the deployed Router (its ' +
      'build predates this snapshot) — see docs/verified-services.md.',
  },
  'wolframalpha::/wolframalpha/short-answer': {
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T03:25:29Z',
    verifiedNote:
      'charge-verified 2026-08-18T03:25:29Z, Stellar tx ' +
      'cffd0d499221037352a7db87aaf22e2f7449a6c09058ad4c80853e4dadc33722 ' +
      '(see docs/verified-services.md). $0.055/request — the most ' +
      'expensive of this round — returned "4" for input "2+2". Note the ' +
      'body key is `i`, not `input`; the merchant pre-validates and 400s ' +
      'before the 402 challenge is issued if it is missing.',
  },
  // ---------------------------------------------------------------
  // Mercury (Stellar indexer, xycloo Labs) — MVP router-held-credential
  // service (design: ainative todos/20260811-mercury-mpp-router-
  // integration-design.md). Mercury is NOT an mpp.dev merchant: the
  // router holds a scoped Mercury JWT (`MERCURYDATA_MAINNET_JWT`,
  // injected via upstreamAuth) and issues its own fixed-price 402
  // ($0.0005/call, matching Alchemy's data-API rate) instead of probing
  // a merchant 402. Capped at 1,000 calls/day (rateLimit) to protect
  // Federico's token — double wall on top of whatever cap he sets on the
  // token itself. verifiedMode stays false until the first real paid
  // call lands (see §2.5 of the design doc); flip to 'charge' + set
  // chargeVerified/chargeVerifiedAt with the settling tx hash then.
  // Token issued 2026-08-12, ~3-month validity — renew by ~2026-11-12 or
  // this SERVICE_OVERLAY-style disable kicks in (kill switch promised to
  // Federico: same-day delist via a verifiedMode:false flip here).
  //
  // Launch gate (P1 fix, codex review 2026-08-12): verifiedMode: false
  // makes handleProxy's SECURITY GATE 403 the route unconditionally —
  // but verifiedMode can only ever flip to a real value AFTER a
  // successful paid call, so without an escape hatch this route could
  // NEVER be verified. `launchGate: 'MERCURY_LAUNCH_MODE'` lets the
  // operator flip the `MERCURY_LAUNCH_MODE` Worker var to `'verify'` to
  // let exactly the operator's own first paid call through (route stays
  // 403 for everyone else / unset var), do the real-money test, then
  // unset the var again and flip verifiedMode to 'charge' — the route is
  // never advertised as verified or opened to the public before that
  // test happens. See proxy.ts SECURITY GATE.
  // ---------------------------------------------------------------
  'mercury::GET::/events/by-contract/{contract_id}': {
    upstreamPath: '/rest/events/by-contract/{contract_id}',
    id: 'mercury_events_by_contract',
    publicPath: '/v1/services/mercury/events/by-contract',
    upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' },
    fixedPricing: { amountUsd: '0.001' },
    rateLimit: { perDay: 1000 },
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-11T16:48:00Z',
    launchGate: 'MERCURY_LAUNCH_MODE',
    verifiedNote:
      'Mercury MVP (~3mo token, renew by ~2026-11-12). charge-verified 2026-08-11T16:48:00Z, ' +
      'Stellar tx 8b3a36f2b359328a37652b7f32e89e19b253487e9b28bc01a257161e1cf6b8c6 ' +
      '(see docs/verified-services.md). $0.001/call, 1,000/day cap, router-held credential.',
  },
  'mercury::GET::/events/by-ledger': {
    upstreamPath: '/rest/events/by-ledger',
    id: 'mercury_events_by_ledger',
    publicPath: '/v1/services/mercury/events/by-ledger',
    upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' },
    fixedPricing: { amountUsd: '0.001' },
    rateLimit: { perDay: 1000 },
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-18T02:35:01Z',
    verifiedNote:
      'Mercury MVP (~3mo token, renew by ~2026-11-12). charge-verified 2026-08-18T02:35:01Z, ' +
      'Stellar tx 5028a601460bc30228b51d62072722b07df8c29b5bdb6100c92fa26d74064f0d ' +
      '(see docs/verified-services.md). Previously delisted after the 2026-08-11 attempt saw ' +
      'slow (40s+) / 500 responses; provider diagnosed a query-plan issue on ledger ranges away ' +
      'from the chain tip and shipped a fix on 2026-08-15. Re-verified on a narrow range ' +
      '(start_ledger=50000000, end_ledger=50000010) returning real Soroban events. ' +
      'NOTE: very wide ledger ranges remain bounded by a server-side timeout by design. ' +
      '$0.001/call, 1,000/day cap, router-held credential.',
  },
  'mercury::GET::/txs/by-contract/{contract_id}': {
    upstreamPath: '/rest/txs/by-contract/{contract_id}',
    id: 'mercury_txs_by_contract',
    publicPath: '/v1/services/mercury/txs/by-contract',
    upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' },
    fixedPricing: { amountUsd: '0.001' },
    rateLimit: { perDay: 1000 },
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-11T16:48:00Z',
    launchGate: 'MERCURY_LAUNCH_MODE',
    verifiedNote:
      'Mercury MVP (~3mo token, renew by ~2026-11-12). charge-verified 2026-08-11T16:48:00Z, ' +
      'Stellar tx c82da0fc01501df246df43e5cbfb85d60bc5d9dd7df31a95addeb59af95f4b98 ' +
      '(see docs/verified-services.md). $0.001/call, 1,000/day cap, router-held credential.',
  },
  'mercury::GET::/txs/by-hash/{tx_hash}': {
    upstreamPath: '/rest/txs/by-hash/{tx_hash}',
    id: 'mercury_txs_by_hash',
    publicPath: '/v1/services/mercury/txs/by-hash',
    upstreamAuth: { secretBinding: 'MERCURYDATA_MAINNET_JWT', header: 'Authorization', scheme: 'bearer' },
    fixedPricing: { amountUsd: '0.001' },
    rateLimit: { perDay: 1000 },
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-08-11T16:48:00Z',
    launchGate: 'MERCURY_LAUNCH_MODE',
    verifiedNote:
      'Mercury MVP (~3mo token, renew by ~2026-11-12). charge-verified 2026-08-11T16:48:00Z, ' +
      'Stellar tx 871099bf7ed2f36605ed568aa927d811d43893afc70863fb8a3fdf4279c07cdb ' +
      '(see docs/verified-services.md). $0.001/call, 1,000/day cap, router-held credential.',
  },
  // Object Storage Upload — actually charge mode for multipart-init
  'storage::/{key}': {
    id: 'storage_upload',
    publicPath: '/v1/services/storage/upload',
    verifiedMode: 'charge',
    chargeVerified: true,
    chargeVerifiedAt: '2026-04-11T00:00:00Z',
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
 * Length drifts with the snapshot (88 services × a handful of paid POST
 * endpoints each, after filtering out free/non-POST routes). Do NOT
 * hardcode a count here — inspect `PUBLIC_SERVICE_ROUTES.length` at
 * runtime. Only a small operator-verified subset (those carrying
 * `verifiedMode: 'charge' | 'session'`) is actually chargeable; the rest
 * are listed as `payment_status: "untested"` and carry no stellar block.
 */
export const PUBLIC_SERVICE_ROUTES: PublicServiceRoute[] =
  buildRoutesFromMppSnapshot(
    mppSnapshot as any,
    OPERATOR_OVERLAY,
    SERVICE_OVERLAY,
  )

// ---------------------------------------------------------------------
// Catalog rendering
// ---------------------------------------------------------------------

/**
 * Build the list of Stellar intents this route accepts.
 *
 * Option A (2026-06-23): every route is payable EXCEPT ones we've
 * real-money tested and confirmed broken (`verifiedMode === false`).
 * Unverified routes (`verifiedMode === undefined`) are payable again —
 * the charge/x402 flows only settle the customer after the downstream
 * merchant responds, and the catalog now carries per-mode
 * `*_rozo_verified` flags so a paying agent can see exactly what we've
 * vetted vs what is best-effort. This replaces the 2026-06-22 opt-IN
 * model, which gated the ~485 unverified routes and broke services
 * customers actually use (the Argens report).
 *
 * - `verifiedMode === false`: known-broken → no intents (no stellar
 *   block), and the proxy gate refuses it. Don't send money to a black hole.
 * - everything else (verified OR untested): advertise `charge`.
 *
 * Kept in sync with the proxy gate in `src/routes/proxy.ts`, which
 * refuses ONLY `verifiedMode === false` routes.
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
    // Payment availability tier — orthogonal to docs `status`. Driven
    // by verifiedMode, kept in lockstep with stellarIntentsFor (which
    // only advertises `charge` for the verified tier) and the proxy
    // execution gate.
    // Option A (2026-06-23): payable unless confirmed-broken. 'verified'
    // = operator real-money tested; 'available' = payable but unverified
    // (client decides risk via *_rozo_verified); 'unavailable' = broken,
    // proxy gate refuses. Kept in sync with stellarIntentsFor + proxy gate.
    const paymentTier: Pick<
      PublicCatalogEntry,
      'payment_status' | 'payment_enabled' | 'payment_status_note'
    > =
      route.verifiedMode === false
        ? {
            payment_status: 'unavailable',
            payment_enabled: false,
            payment_status_note:
              route.verifiedNote ??
              'Route is known-broken (merchant error or bad upstream path) and is not chargeable.',
          }
        : route.verifiedMode === 'charge' || route.verifiedMode === 'session'
          ? { payment_status: 'verified', payment_enabled: true }
          : {
              payment_status: 'available',
              payment_enabled: true,
              payment_status_note:
                'Route is payable but has not been verified end-to-end by Rozo. ' +
                'Check charge_rozo_verified / session_rozo_verified before relying on it.',
            }
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
      ...(requiredPathParams(route).length > 0
        ? { path_params: requiredPathParams(route) }
        : {}),
      price: route.price,
      payment_method: route.paymentMethod,
      network: route.network,
      asset: route.asset,
      status: route.docs?.llmsTxt ? 'active' : 'limited',
      ...(route.docs?.llmsTxt ? {} : {
        status_note: 'llms_txt not available — use with caution; agents may not know how to construct request bodies.',
      }),
      ...paymentTier,
      // Per-mode verification flags. `?? null` so the catalog ALWAYS carries
      // the 4 keys (clients don't have to handle missing keys); null = N/A
      // for this mode or never tested in it.
      charge_rozo_verified: route.chargeVerified ?? null,
      charge_rozo_verified_at: route.chargeVerifiedAt ?? null,
      session_rozo_verified: route.sessionVerified ?? null,
      session_rozo_verified_at: route.sessionVerifiedAt ?? null,
      ...(RECOMMENDED_SERVICE_IDS.has(route.id) ? { recommended: true as const } : {}),
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

/**
 * Placeholder names in `route.upstreamPath` that the caller must
 * supply as query params, i.e. those without an operator default.
 * Deliberately shares its regex with `resolveUpstreamPath` below —
 * if the catalog and the resolver ever disagree about what is
 * required, agents get 400s they cannot act on.
 */
export function requiredPathParams(
  route: Pick<PublicServiceRoute, 'upstreamPath' | 'placeholderDefaults'>,
): string[] {
  const defaults = route.placeholderDefaults ?? {}
  const names = new Set<string>()
  for (const m of route.upstreamPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    const name = m[1]
    if (!Object.prototype.hasOwnProperty.call(defaults, name)) names.add(name)
  }
  return [...names]
}

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
        `Route ${route.id} requires {${name}} placeholder but no value was supplied. ` +
          `Path parameters are supplied as QUERY PARAMS on the router URL, not as path ` +
          `segments and not in the body: retry with ?${name}=<value>. The router ` +
          `substitutes it into the upstream path and strips it from the forwarded query. ` +
          `The full list for a route is the 'path_params' field in GET /v1/services/catalog.`,
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
