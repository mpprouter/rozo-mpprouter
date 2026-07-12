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
 *   GET      /llms.txt                      — LLM-readable router description
 *   GET      /openapi.json                  — OpenAPI 3.1 spec
 *   GET      /.well-known/ai-plugin.json    — AI plugin manifest
 */

import { handleProxy } from './routes/proxy'
import { handleJobStatus, handleJobChallenge } from './routes/job-status'
import { handleHealth } from './routes/health'
import { handleServices } from './routes/services'
import { handleSearch } from './routes/search'
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
  handleCouponStatus,
  handleResolveCoupon,
  handleAdminGetCoupon,
} from './routes/coupon'
// P1-3: export DO class so wrangler can bind it via [[durable_objects.bindings]]
export { AtomicStoreDO } from './mpp/atomic-store-do'
import { handleRozoWebhook, handleInvoiceStatus } from './routes/webhook'
import { handleInvoiceDetails } from './routes/invoice-details'
import { handlePreflight, withCors } from './utils/cors'

export interface Env {
  MPP_STORE: KVNamespace
  // P1-3: Durable Object namespace for the linearizable CAS store.
  // Replaces the non-atomic KV-based update() in the mppx Store adapter.
  // Bound via [[durable_objects.bindings]] in wrangler.toml.
  ATOMIC_STORE: DurableObjectNamespace

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

  // HMAC key used by mppx to bind 402 challenges to their contents so
  // that credentials presented back to us can be verified statelessly.
  // Set via: wrangler secret put MPP_SECRET_KEY
  MPP_SECRET_KEY: string

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
  ADMIN_ENDPOINT_ENABLED?: string

  // Coupon issuance secret (routes/coupon.ts). Deliberately separate from
  // PAYINVOICE_ADMIN_SECRET: leaking the coupon-issuance key must not grant
  // direct pay-invoice access, and vice versa.
  // Set via: wrangler secret put ADMIN_TOKEN
  ADMIN_TOKEN: string
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return handlePreflight(request)
    const response = await route(request, env, ctx)
    return withCors(request, response)
  },
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
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

      if (url.pathname === '/x402/supported') {
        return handleX402Supported(env)
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

      // Coupon redemption layer (routes/coupon.ts). Public redeem/status
      // are brute-force-hardened (uniform errors + DO-backed rate limits);
      // admin issue/resolve/get sit behind their own COUPON_ENDPOINT_ENABLED
      // gate (NOT ADMIN_ENDPOINT_ENABLED, which stays off in production)
      // plus the ADMIN_TOKEN secret.
      if (url.pathname === '/coupon/redeem') {
        return handleRedeemCoupon(request, env)
      }
      if (url.pathname === '/coupon/status') {
        return handleCouponStatus(request, env)
      }
      if (
        url.pathname === '/admin/coupon/issue' ||
        url.pathname === '/admin/coupon/resolve' ||
        url.pathname === '/admin/coupon/get'
      ) {
        if (env.COUPON_ENDPOINT_ENABLED !== 'true') {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.pathname === '/admin/coupon/issue') return handleIssueCoupon(request, env)
        if (url.pathname === '/admin/coupon/resolve') return handleResolveCoupon(request, env)
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
        '  GET /x402/supported                  - x402 discovery\n' +
        '  GET /llms.txt                        - LLM-readable description\n' +
        '  GET /openapi.json                    - OpenAPI 3.1 spec\n' +
        '  GET /.well-known/ai-plugin.json      - AI plugin manifest\n' +
        '  POST /v1/services/<service>/<op>     - Call a paid service\n' +
        '  GET  /v1/services/<svc>/jobs/<id>/challenge - Get ownership nonce\n' +
        '  GET  /v1/services/<svc>/jobs/<id>   - Poll async job (signed)\n\n' +
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
