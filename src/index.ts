/**
 * MPP Router — Cloudflare Worker
 *
 * Proxies HTTP requests from Stellar agents to Tempo merchants.
 * Translates Stellar USDC payments into Tempo USDC.e payments.
 *
 * Endpoints:
 *   POST     /v1/services/<service>/<operation> — Core proxy
 *   GET      /v1/services/<service>/jobs/<id> — Poll async job status
 *   GET      /health                        — Pool status
 *   GET      /services                      — Public service catalog
 *   GET      /v1/services/catalog           — Versioned public service catalog
 *   GET      /v1/services/search            — Search/filter catalog
 *   GET      /v1/ledger                     — Public settlement ledger
 *   GET      /llms.txt                      — LLM-readable router description
 *   GET      /openapi.json                  — OpenAPI 3.1 spec
 *   GET      /.well-known/ai-plugin.json    — AI plugin manifest
 */

import { handleProxy } from './routes/proxy'
import { handleJobStatus, handleJobChallenge, reconcileAsyncRefunds } from './routes/job-status'
import { handleHealth } from './routes/health'
import { handleServices } from './routes/services'
import { handleSearch } from './routes/search'
import { handleLedger } from './routes/ledger'
import { handleX402Supported } from './routes/x402-supported'
import { handleLlmsTxt } from './routes/llms-txt'
import { handleOpenApi } from './routes/openapi'
import { handleAiPlugin } from './routes/ai-plugin'
import { handleAdminPayInvoice, handleQuoteInvoice } from './routes/pay-invoice-admin'
import { handleAdminSeedStore } from './routes/admin-seed-store'
import { handleCreateInvoice } from './routes/create-invoice'
import {
  handleIssueCoupon,
  handleRedeemCoupon,
  handleResolveCoupon,
  handleAdminGetCoupon,
  handleReopenCircuit,
} from './routes/coupon'
import {
  handlePartnerLogin,
  handlePartnerAuthCallback,
  handleAdminPartnerApiKey,
  handleAdminPartnerLoginLink,
} from './routes/partner-auth'
import {
  handlePartnerMe,
  handlePartnerIssueCoupon,
  handleAdminPartnerTopup,
  handleAdminPartnerStatus,
} from './routes/partner-issue'
import {
  handlePartnerListCoupons,
  handlePartnerVoidCoupon,
} from './routes/partner-coupons'
import { renderPartnerExplainerPage, renderPartnerAppPage } from './partner-ui'
// P1-3: export DO class so wrangler can bind it via [[durable_objects.bindings]]
export { AtomicStoreDO } from './mpp/atomic-store-do'
// Playground prepaid credit ledger — same requirement, bound as PLAYGROUND_LEDGER.
export { PlaygroundLedger } from './playground/ledger-do'
import {
  handlePlaygroundAdminTotals,
  handlePlaygroundBlendActivity,
  handlePlaygroundChat,
  handlePlaygroundConfig,
  handlePlaygroundIntent,
  handlePlaygroundOpen,
  handlePlaygroundSession,
  handlePlaygroundTxDecode,
} from './routes/playground'
import {
  handleChannelBlendActivity,
  handleChannelChat,
  handleChannelRegister,
  handleChannelTxDecode,
} from './routes/playground-channel'
import { settlePlaygroundChannels } from './playground/channel-settle'
import { handleRozoWebhook, handleInvoiceStatus } from './routes/webhook'
import { handleInvoiceDetails } from './routes/invoice-details'
import { handlePreflight, withCors } from './utils/cors'
import { handleRefundAdmin, handleRefundStatus } from './routes/refunds'
import { checkGasSponsor } from './utils/stellar-gas-balance'
import { sendDingTalkAlert } from './utils/dingtalk'
import { redactForAlert } from './utils/alert-redaction'
import { handleChatCompletions, handleModels } from './routes/chat-completions'
import { handleUsageActivity, handleUsageLogs } from './routes/usage-dashboard'
import { handleUsageDashboard } from './routes/usage-dashboard-ui'

export interface Env {
  MPP_STORE: KVNamespace
  // P1-3: Durable Object namespace for the linearizable CAS store.
  // Replaces the non-atomic KV-based update() in the mppx Store adapter.
  // Bound via [[durable_objects.bindings]] in wrangler.toml.
  ATOMIC_STORE: DurableObjectNamespace

  // ---- Playground (self-serve prepaid demo sessions) --------------------
  // Durable Object holding every playground balance, deposit intent and call
  // record. One instance (idFromName('playground')) — the global credit cap
  // and the (tx_hash, op_index) replay guard are both global invariants and
  // cannot be sharded. See src/playground/ledger-do.ts.
  PLAYGROUND_LEDGER: DurableObjectNamespace
  // Kill switch. Every /v1/playground/* route 404s unless this is exactly
  // 'true'. Plain var, not a secret; flip + redeploy to pull the feature.
  PLAYGROUND_ENABLED?: string
  // HMAC key for playground session tokens. Deliberately NOT MPP_SECRET_KEY:
  // rotating that one invalidates every outstanding 402 challenge on the paid
  // proxy, so the playground must be rotatable on its own.
  // Set via: wrangler secret put PLAYGROUND_SESSION_SECRET
  PLAYGROUND_SESSION_SECRET?: string
  // Global outstanding-credit ceiling in USD. Deposit intents are refused
  // beyond it. Defaults to $200; an unparseable value falls back to the
  // default rather than to "unlimited".
  PLAYGROUND_GLOBAL_CAP_USD?: string
  // Horizon base URL for deposit verification. Defaults to the public
  // https://horizon.stellar.org; override only to point at a private Horizon.
  PLAYGROUND_HORIZON_URL?: string
  // Operator bearer token for GET /v1/playground/admin/totals, the solvency
  // read used by scripts/admin/playground-recon.ts. Unset ⇒ that endpoint
  // 404s, so it is absent rather than open by default.
  // Set via: wrangler secret put PLAYGROUND_RECON_TOKEN
  PLAYGROUND_RECON_TOKEN?: string
  // Cloudflare Turnstile secret for the deposit-intent gate. Unset ⇒ intent
  // creation fails closed (503) unless PLAYGROUND_TURNSTILE_DISABLED is
  // explicitly 'true'. Set via: wrangler secret put PLAYGROUND_TURNSTILE_SECRET
  PLAYGROUND_TURNSTILE_SECRET?: string
  // Public Turnstile SITE key, echoed by GET /v1/playground/config so the
  // frontend can render the widget. Not a secret; plain var.
  PLAYGROUND_TURNSTILE_SITE_KEY?: string
  // Explicit, auditable off switch for the intent Turnstile gate. Only the
  // exact string 'true' disables it — a missing/typo'd secret still fails
  // closed. For staged rollout before the frontend widget ships.
  PLAYGROUND_TURNSTILE_DISABLED?: string

  // ---- Non-custodial channel playground ---------------------------------
  // Kill switch for the entire /v1/playground/channel/* surface. Every route
  // there 404s unless this is exactly 'true'. Separate from PLAYGROUND_ENABLED
  // so the custodial and channel playgrounds roll out/pull independently.
  // Plain var, default OFF; flip + redeploy. See playground/channel-config.ts.
  PLAYGROUND_CHANNEL_ENABLED?: string
  // Emergency stop for PAID chat models only (tx-decode and the rest of the
  // channel surface stay up). Set to 'true' while an upstream LLM merchant is
  // accepting payment but failing calls (e.g. the 2026-08-13 Anthropic
  // merchant 403 outage) so no user is ever charged for a doomed call. The
  // chat handler rejects BEFORE any payment; /config marks models unavailable.
  PLAYGROUND_CHAT_MODELS_DISABLED?: string
  // Channel-factory contract address (C...) the frontend calls `open` against
  // to deploy a per-user channel in one Freighter-signed invoke. May be empty
  // until the founder deploys the factory on mainnet (an L3 on-chain action);
  // GET /v1/playground/config advertises it (null until set). Plain var.
  PLAYGROUND_CHANNEL_FACTORY?: string
  // Dedicated hot COLLECTOR account (G...) every playground channel pays TO
  // (Option A). Kept DISTINCT from STELLAR_ROUTER_PUBLIC (the treasury): it
  // holds only spent playground cents. Register verifies the channel's on-chain
  // `to` equals this. Plain var; register + settlement fail closed when unset.
  PLAYGROUND_CHANNEL_TO?: string
  // Our known channel-contract WASM hash (lowercase hex) — the provenance
  // anchor. register REJECTS any contract whose on-chain WASM hash differs, so
  // an attacker cannot register a look-alike contract that self-reports valid
  // params. May be set after the founder uploads the channel WASM; register
  // fails closed while unset. Plain var.
  PLAYGROUND_CHANNEL_WASM_HASH?: string
  // Secret key (S...) of the COLLECTOR account. Used ONLY as the envelope
  // signer for on-chain settle/close of playground channels (collecting spent
  // funds to the collector) — it never touches the treasury and can only move
  // funds out of a channel that already pays TO the collector. Unset ⇒ the
  // settlement cron skips (fail-safe, bounded loss).
  // Set via: wrangler secret put PLAYGROUND_CHANNEL_SIGNER_SECRET
  PLAYGROUND_CHANNEL_SIGNER_SECRET?: string

  // Stellar Router Pool (receives agent USDC payments)
  // Secret NOT in env — operator manages offline. Only public key needed.
  STELLAR_ROUTER_PUBLIC: string   // G... address where agents send USDC

  // Stellar Gas Sponsor (pays tx fees for broadcasting)
  // Low-value account, only holds XLM
  STELLAR_GAS_SECRET: string      // S... keypair for signing fee-sponsored txs
  STELLAR_GAS_PUBLIC: string      // G... address

  STELLAR_NETWORK: string
  STELLAR_RPC_URL: string

  // Tempo (merchant-facing)
  TEMPO_ROUTER_PRIVATE_KEY: string
  TEMPO_ROUTER_ADDRESS: string    // 0x... address
  TEMPO_RPC_URL: string

  // Preferred Tempo RPC pool, tried ahead of TEMPO_RPC_URL. Optional —
  // unset means "public pool only", which is the pre-2026-08-14 behaviour.
  //
  // This is a SECRET, not a wrangler.toml var, because a keyed endpoint
  // carries its API key in the URL path and wrangler.toml is committed.
  // It is also deliberately a DIFFERENT NAME from TEMPO_RPC_URL: a
  // plain-text var in wrangler.toml overrides a secret of the same name on
  // deploy, so reusing the name would silently discard the key.
  //
  // Set via: wrangler secret put TEMPO_RPC_URL_PRIMARY
  TEMPO_RPC_URL_PRIMARY?: string

  // HMAC key used by mppx to bind 402 challenges to their contents so
  // that credentials presented back to us can be verified statelessly.
  // Set via: wrangler secret put MPP_SECRET_KEY
  MPP_SECRET_KEY: string

  // Stellar S... seed whose Ed25519 key signs refund receipts. Deliberately a
  // DEDICATED key, not STELLAR_ROUTER_PUBLIC's (that secret is never in the
  // Worker) and not MPP_SECRET_KEY: a receipt signer holds no funds and grants
  // no 402 authority, so it can live in the request path.
  //
  // Its public address is published on /health as `receipt_signer`, which is
  // what lets anyone verify a receipt without trusting us. Unset ⇒ the signed
  // receipt endpoint fails closed with 503 rather than emitting an
  // unverifiable receipt.
  //
  // Set via: wrangler secret put RECEIPT_SIGNING_SECRET
  RECEIPT_SIGNING_SECRET?: string

  // Comma-separated G... addresses of PREVIOUS receipt signers. Public keys,
  // so this is a plain var, not a secret. Rotating the signing key does not
  // invalidate receipts the old key signed; verifiers are told to trust the
  // addresses /health publishes, so a retired address must stay published or
  // every receipt it signed silently becomes unverifiable.
  RECEIPT_SIGNER_RETIRED_ADDRESSES?: string

  // Config
  //
  // OPTIMISTIC_THRESHOLD (UNUSED, 2026-04-10): this env var is declared
  // here and in wrangler.toml but no code path reads it. It was intended
  // to skip on-chain Soroban simulation for small-value payments (below
  // $0.05) so the agent doesn't wait for RPC round-trips on trivial
  // charges. Never implemented. See notes.md → "OPTIMISTIC_THRESHOLD is
  // declared but unused". Do not rely on it; either wire it up in
  // createStellarPayment() or delete it before assuming any behavior.
  OPTIMISTIC_THRESHOLD: string
  RATE_LIMIT_MAX: string

  // Fixed XLM/USD rate used to convert merchant USDC amounts into XLM
  // for XLM-denominated Stellar channels. See wrangler.toml for the
  // operator update policy and internaldocs/v2-todo.md#c for context.
  // Stored as a string so wrangler.toml can carry it; parsed at use site.
  XLM_USD_RATE: string

  // ---------- x402 inbound over Stellar (Phase 1) ----------
  //
  // Router acts as an x402 resource server + in-process facilitator
  // on Stellar mainnet. Agents using any spec-compliant x402 client
  // (e.g. @x402/stellar/exact/client) can hit the same /v1/services/*
  // URLs; classifyAuth dispatches to the stellar.x402 branch only
  // when the credential's payTo matches STELLAR_X402_PAY_TO AND
  // X402_ENABLED is "true". See src/mpp/stellar-x402-server.ts.
  //
  // Runs parallel to the existing Stellar MPP (mppx) path — classifyAuth
  // tries mppx first, then x402; unrecognized credentials fall through
  // to the existing passthrough branch.
  X402_ENABLED: string                     // "true" | "false" (default "true")
  // G... recipient address — this is the account that actually
  // receives agent USDC. Public key only; no signing from this
  // account ever happens inside the router.
  STELLAR_X402_PAY_TO: string
  // S... facilitator signer. Builds + submits the on-chain Soroban
  // invoke for settle. Shared with STELLAR_GAS_SECRET in .dev.vars
  // by default (same "gas sponsor" account is used for both), but
  // kept as a distinct env var so operators can rotate them
  // independently if they want. Secret — set via `wrangler secret
  // put STELLAR_X402_FACILITATOR_SECRET`.
  STELLAR_X402_FACILITATOR_SECRET: string
  PAYINVOICE_ADMIN_SECRET: string

  // ---- Public ledger attribution ----------------------------------------
  // Comma-separated Stellar addresses that belong to US (probes, e2e wallets,
  // dogfood accounts). GET /v1/ledger marks matching rows internal:true and
  // everything else internal:false; when this is UNSET every row reports
  // internal:null ("unknown"), which is what production returned before this
  // var existed. Plain var, not a secret — these are public account IDs and
  // the whole point is that reviewers can audit the exclusion list.
  // Rows whose payer could not be decoded stay internal:null regardless.
  LEDGER_INTERNAL_PAYERS?: string
  // Comma-separated addresses that are Rozo-ADJACENT but cannot be evidenced
  // as ours: /v1/ledger reports attribution:'unresolved' for these. They are
  // excluded from the external count WITHOUT being claimed as internal.
  // Keeping this separate from LEDGER_INTERNAL_PAYERS is the whole point —
  // folding them into either bucket would misstate the external-payer number
  // that the grant floors are measured against.
  LEDGER_UNRESOLVED_PAYERS?: string
  ADMIN_ENDPOINT_ENABLED?: string

  // Coupon issuance secret (routes/coupon.ts). Deliberately separate from
  // PAYINVOICE_ADMIN_SECRET: leaking the coupon-issuance key must not grant
  // direct pay-invoice access, and vice versa.
  // Set via: wrangler secret put ADMIN_TOKEN
  ADMIN_TOKEN: string
  // Read-only credential for /v1/usage/* and the /usage operator dashboard.
  // It deliberately grants none of ADMIN_TOKEN's mutation authority.
  // Set via: wrangler secret put USAGE_READ_TOKEN
  USAGE_READ_TOKEN?: string
  // Dedicated least-authority token for the pull-only refund executor.
  REFUND_EXECUTOR_TOKEN?: string
  // Kill switch for the coupon admin endpoints (issue/resolve/get). Separate
  // from ADMIN_ENDPOINT_ENABLED (which gates /admin/pay-invoice and stays OFF
  // in production) so enabling coupon issuance does not change the
  // pay-invoice posture. "true" in wrangler.toml [vars]; flip + redeploy to
  // stop issuance instantly without touching secrets.
  COUPON_ENDPOINT_ENABLED?: string

  // Rozo Intents API key for creating discounted payment intents from
  // Coinbase Payment Links via POST /v1/services/rozo-agent-api/create-invoice.
  // Set via: wrangler secret put ROZO_INTENTS_API_KEY
  ROZO_INTENTS_API_KEY: string

  // Rozo webhook signing secret. Used to verify HMAC-SHA256 on
  // POST /v1/services/rozo-agent-api/webhook.
  // Set via: wrangler secret put ROZO_WEBHOOK_SECRET
  ROZO_WEBHOOK_SECRET: string

  // Mercury (Stellar indexer, xycloo Labs) — router-held scoped JWT
  // injected as `Authorization: Bearer <token>` on the 4 mercury::GET
  // routes via `route.upstreamAuth` (see src/routes/proxy.ts). Never
  // logged. Mainnet is REQUIRED in production for the mercury routes to
  // work (payment still succeeds without it — the credential injection
  // just no-ops and the upstream call 401s, same fail-open-on-agent-
  // payment risk as any other pay-then-fail merchant). Set via:
  // wrangler secret put MERCURYDATA_MAINNET_JWT
  MERCURYDATA_MAINNET_JWT?: string
  // Dev-only counterpart against testnet.mercurydata.app. Not read by any
  // production code path — used only by local smoke scripts.
  MERCURYDATA_TESTNET_JWT?: string
  // Launch gate for the Mercury MVP routes (P1 fix, codex review
  // 2026-08-12). verifiedMode: false 403s these routes unconditionally —
  // set this var to 'verify' to let the operator's own first real paid
  // call through despite that, without advertising the route as verified.
  // See `PublicServiceRoute.launchGate` / proxy.ts SECURITY GATE. Unset
  // (default) → still 403 for everyone. Not a secret; plain var is fine.
  MERCURY_LAUNCH_MODE?: string

  // Optional paid Base RPC (Alchemy / QuickNode / Infura) used as the
  // primary endpoint for funder balance checks. Falls back to public
  // Base RPCs on failure. CF Workers can't reach mainnet.base.org
  // reliably, so this is effectively required in production.
  // Set via: wrangler secret put BASE_RPC_URL
  BASE_RPC_URL?: string

  // DingTalk webhook token for operational alerts (low balance, etc.)
  // Set via: wrangler secret put DINGTALK_ACCESS_TOKEN
  DINGTALK_ACCESS_TOKEN?: string

  // Stripe Crypto fulfillment: URL of the pay-invoice edge function that owns
  // the (fail-closed, disabled-by-default) Stripe Permit signing branch.
  // Defaults to the same agentapi/pay-invoice endpoint the Coinbase path uses;
  // override to the direct Supabase function URL at deploy time without a code
  // change. Set via: wrangler secret put STRIPE_PAY_INVOICE_URL
  STRIPE_PAY_INVOICE_URL?: string

  // Invoice capability encryption (design §6). AES-256-GCM key (base64 of 32
  // bytes) used to encrypt the replayable Stripe pay URL at rest in the
  // fulfillment record. REQUIRED for Stripe fulfillment: seeding fails closed
  // (refuses to store a plaintext fallback) when this is unset.
  // Set via: wrangler secret put INVOICE_CAPABILITY_ENCRYPTION_KEY
  INVOICE_CAPABILITY_ENCRYPTION_KEY?: string
  // Optional key rotation: a previous key kept available for DECRYPT only, so
  // records sealed before a rotation stay readable. New records always use the
  // current key. Set both the material and its id together.
  INVOICE_CAPABILITY_ENCRYPTION_KEY_PREVIOUS?: string
  INVOICE_CAPABILITY_KEY_ID_PREVIOUS?: string
  // Key id stamped into new capability blobs (default "v1"). Bump on rotation.
  INVOICE_CAPABILITY_KEY_ID?: string

  // Caller-side daily-spend cap for Stripe fulfillment, in whole USD (e.g.
  // "200"). The webhook reserves against this ledger BEFORE calling pay-invoice
  // (defence in depth — pay-invoice enforces its own fail-closed cap too).
  // Defaults to $200 when unset. Set via: wrangler secret put
  // STRIPE_FULFILLMENT_DAILY_CAP_USD
  STRIPE_FULFILLMENT_DAILY_CAP_USD?: string

  // ── Coupon abuse protection (design: ainative 20260722-mpprouter-coupon-
  //    claim-security.md) ──
  //
  // MPPRouter-specific D1 database holding the historical, redacted security
  // audit of every /coupon/redeem outcome. Bound via [[d1_databases]] in
  // wrangler.toml. NOT the Rozo Intents Supabase. Optional so a staged rollout
  // can deploy the code before provisioning the DB (audit becomes a no-op).
  COUPON_SECURITY_DB?: D1Database

  // HMAC-SHA-256 key for the coupon audit digests (code_hash / payment_id_hash
  // / pair_hash / ip_prefix_hash). The 8-digit code space is enumerable, so a
  // plain hash would be reversible offline — this keyed digest is not. REQUIRED
  // for /coupon/redeem (fails closed when unset). Rotating it severs
  // correlation to older audit rows. Set via: wrangler secret put COUPON_HASH_SECRET
  COUPON_HASH_SECRET?: string

  // ── Partner platform (routes/partner-*.ts, partner-ui/) ──────────────────
  //
  // HMAC key for the partner session cookie. Auth FAILS CLOSED when unset, so
  // the partner backend is inert until this secret exists — which is the
  // behaviour we want if it is ever lost or not yet provisioned.
  // Set via: wrangler secret put PARTNER_SESSION_SECRET
  PARTNER_SESSION_SECRET?: string

  // Contact handle shown to partners on the explainer page ("需要充值？联系我们").
  // Plain config, not a secret; safe in wrangler.toml [vars].
  PARTNER_CONTACT?: string

  // Kill switch for the whole partner surface, mirroring COUPON_ENDPOINT_ENABLED.
  // Anything other than "true" makes every /partner* path 404, so the feature
  // can be pulled without a rollback deploy.
  PARTNER_ENDPOINT_ENABLED?: string

  // Cloudflare Turnstile secret key for server-side siteverify on /coupon/redeem.
  // When unset, Turnstile is skipped (staged rollout before the widget is wired
  // on the frontend). Set via: wrangler secret put TURNSTILE_SECRET
  TURNSTILE_SECRET?: string
  // Optional expected hostname to pin verified tokens to (e.g. "open.rozo.ai").
  // Set via: wrangler secret put TURNSTILE_HOSTNAME
  TURNSTILE_HOSTNAME?: string
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return handlePreflight(request)
    const response = await route(request, env, ctx)
    return withCors(request, response)
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileAsyncRefunds(env))
    // Option A online settlement: collect spent channel funds to the collector
    // before users can unilaterally refund. No-op unless the channel playground
    // is enabled AND the collector signer secret is set.
    ctx.waitUntil(settlePlaygroundChannels(env))
    // Gas sponsor low-balance watch (threat DoS.3.R.1, Stellar side). Alerts on
    // state TRANSITION only — this cron runs every 2 minutes, so a level-based
    // check would re-send the same warning 720 times a day.
    ctx.waitUntil(watchGasSponsor(env))
  },
}

/**
 * Gas sponsor low-balance watch.
 *
 * Deliberately on the cron rather than the request path, unlike the Tempo pool
 * check: the Tempo balance is consulted per request because it decides whether
 * that request can be served, whereas the gas sponsor funds no user-facing
 * quote and would only add a Horizon round-trip to every proxied call.
 *
 * Swallows its own errors. A monitor that can break the cron it rides on takes
 * down refund reconciliation and channel settlement with it — strictly worse
 * than the gap it was added to close.
 */
async function watchGasSponsor(env: Env): Promise<void> {
  try {
    if (!env.DINGTALK_ACCESS_TOKEN) {
      // No alert channel means this monitor cannot do its job. Say so in the
      // log rather than returning silently: a monitor that is quiet because it
      // is disabled looks identical to a monitor that is quiet because all is
      // well, and that is the failure this whole change exists to remove.
      console.warn('[gas-sponsor-watch] DINGTALK_ACCESS_TOKEN unset — gas sponsor is NOT being monitored')
      return
    }

    const result = await checkGasSponsor({
      kv: env.MPP_STORE,
      horizonUrl: env.PLAYGROUND_HORIZON_URL ?? 'https://horizon.stellar.org',
      address: env.STELLAR_GAS_PUBLIC,
    })
    if (!result) return

    await sendDingTalkAlert(env.DINGTALK_ACCESS_TOKEN, redactForAlert(result.message))

    // Commit only after the alert has gone out. If the send throws we fall to
    // the catch below WITHOUT recording the new state, so the next tick sees
    // the same transition and tries again. Recording first would have deduped
    // every later attempt and left the monitor permanently silent.
    await result.commit()
  } catch (err) {
    console.warn(`[gas-sponsor-watch] skipped: ${(err as Error).message}`)
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
      // Force HTTPS on the partner hostname, before anything else runs.
      //
      // Typing a bare hostname into a browser goes to http:// first, and this
      // Worker was happily answering: the full login page, password field and
      // all, in plaintext. Three problems at once — the browser says "not
      // secure", a submitted password crosses the network in the clear, and the
      // session cookie is `Secure` so it is never set, meaning the login
      // silently fails anyway.
      //
      // 301 rather than 302: this one really is permanent, and the permanent
      // form is what browsers remember so the insecure hop stops happening.
      //
      // The durable fix is "Always Use HTTPS" at the zone level, which stops
      // the plaintext request before it reaches a Worker at all. This is the
      // belt that does not depend on that setting staying on.
      //
      // Deliberately NOT applied to apiserver.mpprouter.dev: a 301 turns a POST
      // into a GET in some clients, and that hostname has existing integrators
      // whose requests must not be silently mangled.
      if (url.hostname === 'coupon.rozo.ai' && url.protocol === 'http:') {
        const secure = new URL(url.toString())
        secure.protocol = 'https:'
        return Response.redirect(secure.toString(), 301)
      }

      // coupon.rozo.ai is the partner-facing hostname, not an API endpoint.
      // Landing on its root should not show the router's index page — the
      // people who type this domain are partners looking for the backend.
      //
      // 302, not 301: a permanent redirect gets cached hard by browsers and
      // is painful to walk back if this hostname ever fronts something else.
      // Scoped to the bare root so every /partner* path (and anything else
      // reached on this hostname) keeps behaving exactly as before.
      if (url.hostname === 'coupon.rozo.ai' && (url.pathname === '/' || url.pathname === '')) {
        return Response.redirect(new URL('/partner', url).toString(), 302)
      }

      if (url.pathname === '/health') {
        return handleHealth(env)
      }

      if (url.pathname === '/llms.txt') {
        return handleLlmsTxt()
      }

      if (url.pathname === '/openapi.json') {
        return handleOpenApi()
      }

      if (url.pathname === '/.well-known/ai-plugin.json') {
        return handleAiPlugin()
      }

      if (url.pathname === '/services' || url.pathname === '/v1/services/catalog') {
        return handleServices(env)
      }

      if (url.pathname === '/v1/services/search') {
        return handleSearch(url, env)
      }

      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return handleModels()
      }
      if (url.pathname === '/v1/chat/completions') {
        return handleChatCompletions(request, env, ctx)
      }
      if (url.pathname === '/v1/usage/logs' && request.method === 'GET') {
        return handleUsageLogs(request, env)
      }
      if (url.pathname === '/v1/usage/activity' && request.method === 'GET') {
        return handleUsageActivity(request, env)
      }
      if (url.pathname === '/usage' && request.method === 'GET') {
        return handleUsageDashboard()
      }

      // Public settlement ledger. Unauthenticated and read-only by design —
      // it is the evidence behind the "all visible on the ledger" claim, so
      // requiring a key would defeat its purpose. Rate limited to 1 req/s
      // per IP inside the handler.
      if (url.pathname === '/v1/ledger' && request.method === 'GET') {
        return handleLedger(request, env)
      }

      if (url.pathname === '/x402/supported') {
        return handleX402Supported(env)
      }

      // ---- Playground: self-serve prepaid demo sessions ------------------
      // Purpose-built endpoints, deliberately NOT part of the paid proxy —
      // see the header of src/routes/playground.ts. Every one of these is
      // gated on PLAYGROUND_ENABLED === 'true' inside the handler and 404s
      // otherwise, so the whole family can be pulled with one var flip.
      // `/v1/playground/*` does not collide with the `/v1/services/`
      // catch-all further down.
      if (url.pathname === '/v1/playground/config' && request.method === 'GET') {
        return handlePlaygroundConfig(env)
      }
      if (url.pathname === '/v1/playground/session/intent' && request.method === 'POST') {
        return handlePlaygroundIntent(request, env)
      }
      if (url.pathname === '/v1/playground/session/open' && request.method === 'POST') {
        return handlePlaygroundOpen(request, env)
      }
      if (url.pathname === '/v1/playground/session' && request.method === 'GET') {
        return handlePlaygroundSession(request, env)
      }
      if (url.pathname === '/v1/playground/chat' && request.method === 'POST') {
        return handlePlaygroundChat(request, env)
      }
      if (url.pathname === '/v1/playground/blend-activity' && request.method === 'POST') {
        return handlePlaygroundBlendActivity(request, env)
      }
      if (url.pathname === '/v1/playground/tx-decode' && request.method === 'POST') {
        return handlePlaygroundTxDecode(request, env)
      }
      // Operator-only solvency read for scripts/admin/playground-recon.ts.
      // 404s unless PLAYGROUND_RECON_TOKEN is configured AND presented.
      if (url.pathname === '/v1/playground/admin/totals' && request.method === 'GET') {
        return handlePlaygroundAdminTotals(request, env)
      }

      // ---- Non-custodial channel playground (Stellar payment channel) ----
      // Built ALONGSIDE the custodial routes above; every one 404s unless
      // PLAYGROUND_CHANNEL_ENABLED === 'true'. Cutover + removal of the
      // custodial path happens in a later step. See routes/playground-channel.ts.
      if (url.pathname === '/v1/playground/channel/register' && request.method === 'POST') {
        return handleChannelRegister(request, env)
      }
      if (url.pathname === '/v1/playground/channel/chat' && request.method === 'POST') {
        return handleChannelChat(request, env)
      }
      if (url.pathname === '/v1/playground/channel/blend-activity' && request.method === 'POST') {
        return handleChannelBlendActivity(request, env)
      }
      if (url.pathname === '/v1/playground/channel/tx-decode' && request.method === 'POST') {
        return handleChannelTxDecode(request, env)
      }

      const refundStatusMatch = url.pathname.match(/^\/v1\/refunds\/([0-9a-f-]{36})$/)
      if (refundStatusMatch && request.method === 'GET') {
        return handleRefundStatus(env, refundStatusMatch[1])
      }

      if (url.pathname.startsWith('/admin/refunds/')) {
        return handleRefundAdmin(request, env, url)
      }

      if (url.pathname === '/admin/pay-invoice') {
        if (env.ADMIN_ENDPOINT_ENABLED === 'true') {
          return handleAdminPayInvoice(request, env)
        }
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // One-time migration: seed absent DO keys from KV-captured values.
      // Non-destructive — DO /seed never overwrites an existing key.
      // Gated by x-admin-secret (same as /admin/pay-invoice).
      if (url.pathname === '/admin/seed-atomic-store') {
        return handleAdminSeedStore(request, env)
      }

      // ── Partner platform ──────────────────────────────────────────────
      //
      // Pages and API are served from THIS worker on purpose: same-origin, so
      // the session cookie works without a proxy or third-party-cookie games.
      //
      // One gate covers pages and API together. A half-open surface (pages up,
      // API down, or vice versa) is worse than none — it looks usable and
      // fails at the point where money moves.
      if (url.pathname === '/partner' || url.pathname.startsWith('/partner/')) {
        // Build the response first, then stamp HSTS on whatever comes out.
        // Wrapping each `return` individually would work until someone adds a
        // branch and forgets — and the forgotten one is a page served without
        // the header, which is exactly the case that matters.
        const resp = await (async (): Promise<Response> => {
          if (env.PARTNER_ENDPOINT_ENABLED !== 'true') {
            return new Response(JSON.stringify({ error: 'Not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          const uiOpts = {}

          // Pages
          if (url.pathname === '/partner' && request.method === 'GET') {
            return renderPartnerExplainerPage(uiOpts)
          }
          if (url.pathname === '/partner/app' && request.method === 'GET') {
            return renderPartnerAppPage(uiOpts)
          }

          // Auth
          if (url.pathname === '/partner/auth/login') return handlePartnerLogin(request, env)
          if (url.pathname === '/partner/auth/callback') {
            return handlePartnerAuthCallback(request, env)
          }

          // Session-scoped API. Every one of these resolves the partner from
          // the signed cookie; a partnerId is NEVER taken from the client.
          if (url.pathname === '/partner/me') return handlePartnerMe(request, env)
          if (url.pathname === '/partner/coupon/issue') {
            return handlePartnerIssueCoupon(request, env)
          }
          if (url.pathname === '/partner/coupons') return handlePartnerListCoupons(request, env)
          const voidMatch = url.pathname.match(/^\/partner\/coupon\/(\d{8}|\d{10})\/void$/)
          if (voidMatch) return handlePartnerVoidCoupon(request, env, voidMatch[1])

          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        })()

        // HSTS so a browser that has been here once never tries plaintext
        // again. No includeSubDomains: committing every rozo.ai subdomain to
        // HTTPS-only is not this feature's call to make.
        const out = new Response(resp.body, resp)
        out.headers.set('Strict-Transport-Security', 'max-age=31536000')
        return out
      }

      // Partner admin. Behind the same COUPON_ENDPOINT_ENABLED gate + ADMIN_TOKEN
      // as coupon issuance, because it is the same authority: minting a login
      // link or crediting a balance both create redeemable value.
      if (
        url.pathname === '/admin/partner/login-link' ||
        url.pathname === '/admin/partner/topup' ||
        url.pathname === '/admin/partner/status' ||
        url.pathname === '/admin/partner/api-key'
      ) {
        if (env.COUPON_ENDPOINT_ENABLED !== 'true') {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.pathname === '/admin/partner/login-link') {
          return handleAdminPartnerLoginLink(request, env)
        }
        if (url.pathname === '/admin/partner/status') {
          return handleAdminPartnerStatus(request, env)
        }
        if (url.pathname === '/admin/partner/api-key') {
          return handleAdminPartnerApiKey(request, env)
        }
        return handleAdminPartnerTopup(request, env)
      }

      // Coupon redemption layer (routes/coupon.ts). Public redeem/status
      // are brute-force-hardened (uniform errors + DO-backed rate limits);
      // admin issue/resolve/get sit behind their own COUPON_ENDPOINT_ENABLED
      // gate (NOT ADMIN_ENDPOINT_ENABLED, which stays off in production)
      // plus the ADMIN_TOKEN secret.
      if (url.pathname === '/coupon/redeem') {
        return handleRedeemCoupon(request, env)
      }
      // NOTE: the public GET /coupon/status endpoint was REMOVED (design
      // 20260722): a status-by-code probe is a brute-force oracle for the
      // 8-digit space (it leaked amount/existence/expiry/used). The redeem POST
      // now returns terminal status inline, and operators use /admin/coupon/get.
      if (
        url.pathname === '/admin/coupon/issue' ||
        url.pathname === '/admin/coupon/resolve' ||
        url.pathname === '/admin/coupon/get' ||
        url.pathname === '/admin/coupon/circuit/reopen'
      ) {
        if (env.COUPON_ENDPOINT_ENABLED !== 'true') {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.pathname === '/admin/coupon/issue') return handleIssueCoupon(request, env)
        if (url.pathname === '/admin/coupon/resolve') return handleResolveCoupon(request, env)
        if (url.pathname === '/admin/coupon/circuit/reopen') return handleReopenCircuit(request, env)
        return handleAdminGetCoupon(request, env)
      }

      // Public quote-invoice endpoint — mirrors pay-invoice input contract but
      // returns the amount quote without charging. Exposed alongside pay-invoice
      // so clients can self-quote before committing to payment.
      if (url.pathname === '/v1/services/rozo-agent-api/quote-invoice') {
        return handleQuoteInvoice(request, env)
      }

      // Public create-invoice endpoint — quotes a Coinbase Payment Link,
      // applies the router's discount (max $5 off, capped at ~4.76%), and
      // creates a Rozo intent so the caller can pay the discounted amount.
      if (url.pathname === '/v1/services/rozo-agent-api/create-invoice') {
        return handleCreateInvoice(request, env)
      }

      // Rozo webhook receiver — verifies HMAC, dedupes by event_id,
      // checks funder balance, triggers agentapi/pay-invoice to settle
      // the underlying Coinbase Payment Link.
      if (url.pathname === '/v1/services/rozo-agent-api/webhook') {
        return handleRozoWebhook(request, env)
      }

      // Public invoice status — accepts pl_* or Rozo paymentId, returns
      // caller-safe state (router KV + Rozo reconciliation).
      if (url.pathname === '/v1/services/rozo-agent-api/invoice-status') {
        return handleInvoiceStatus(request, env)
      }

      // Public read-only invoice detail — resolves a Coinbase or Stripe
      // invoice URL to normalized, non-secret merchant/amount/state data.
      // Moves no money; rate-limited per-IP and per-session.
      if (url.pathname === '/v1/services/rozo-agent-api/invoice-details') {
        return handleInvoiceDetails(request, env)
      }

      // Async job polling — must match before the catch-all proxy route.
      // Challenge endpoint MUST come first (it's a longer suffix than the
      // base job-status path). Both are GET-only.
      const jobChallengeMatch = url.pathname.match(
        /^\/v1\/services\/([^/]+)\/jobs\/([^/]+)\/challenge$/,
      )
      if (jobChallengeMatch && request.method === 'GET') {
        return handleJobChallenge(request, env, jobChallengeMatch[1], jobChallengeMatch[2])
      }
      const jobMatch = url.pathname.match(/^\/v1\/services\/([^/]+)\/jobs\/([^/]+)$/)
      if (jobMatch && request.method === 'GET') {
        return handleJobStatus(request, env, jobMatch[1], jobMatch[2])
      }

      if (url.pathname.startsWith('/v1/services/')) {
        return handleProxy(request, env, ctx)
      }

      // Unknown path — return a real 404 (not a soft-404 with status 200) so
      // search engines do not treat stray URLs like /sitemap.xml as valid
      // pages. Body stays machine/human-readable and lists the real entry
      // points for discovery.
      return new Response(
        'MPP Router - Stellar + x402 Payment Proxy\n\n' +
        'Not found: ' + url.pathname + '\n\n' +
        'Endpoints:\n' +
        '  GET /health                          - Pool status\n' +
        '  GET /services                        - Public service catalog\n' +
        '  GET /v1/services/catalog             - Versioned service catalog\n' +
        '  GET /v1/services/search              - Search/filter catalog\n' +
        '  GET /v1/ledger                       - Public settlement ledger\n' +
        '  GET /x402/supported                  - x402 discovery\n' +
        '  GET /llms.txt                        - LLM-readable description\n' +
        '  GET /openapi.json                    - OpenAPI 3.1 spec\n' +
        '  GET /.well-known/ai-plugin.json      - AI plugin manifest\n' +
        '  POST /v1/services/<service>/<op>     - Call a paid service\n' +
        '  GET  /v1/services/<svc>/jobs/<id>/challenge - Get ownership nonce\n' +
        '  GET  /v1/services/<svc>/jobs/<id>   - Poll async job (signed)\n' +
        '  GET  /v1/playground/config           - Playground models/chips/deposits\n\n' +
        'Docs: https://mpprouter.dev\n',
        { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    } catch (error: any) {
      console.error('[error]', error.message, error.stack)
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
}
