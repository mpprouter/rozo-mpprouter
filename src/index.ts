/**
 * MPP Router — Cloudflare Worker
 *
 * Proxies HTTP requests from Stellar agents to Tempo merchants.
 * Translates Stellar USDC payments into Tempo USDC.e payments.
 *
 * Endpoints:
 *   POST     /v1/services/<service>/<operation> — Core proxy
 *   GET      /health                        — Pool status
 *   GET      /services                      — Public service catalog
 *   GET      /v1/services/catalog           — Versioned public service catalog
 */

import { handleProxy } from './routes/proxy'
import { handleHealth } from './routes/health'
import { handleServices } from './routes/services'
import { handleX402Supported } from './routes/x402-supported'

export interface Env {
  MPP_STORE: KVNamespace

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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
      if (url.pathname === '/health') {
        return handleHealth(env)
      }

      if (url.pathname === '/services' || url.pathname === '/v1/services/catalog') {
        return handleServices(env)
      }

      if (url.pathname === '/x402/supported') {
        return handleX402Supported(env)
      }

      if (url.pathname.startsWith('/v1/services/')) {
        return handleProxy(request, env, ctx)
      }

      return new Response(
        'MPP Router - Stellar + x402 Payment Proxy\n\n' +
        'Endpoints:\n' +
        '  GET /health              - Pool status (Stellar + Tempo)\n' +
        '  GET /services            - Public service catalog (all payment flavors)\n' +
        '  GET /v1/services/catalog - Versioned service catalog\n' +
        '  GET /x402/supported      - Native x402 discovery (SupportedResponse shape)\n' +
        '  POST /v1/services/<service>/<operation> - Call a public service route\n\n' +
        'Accepted auth schemes on the proxy routes:\n' +
        '  - Stellar MPP (official mppx client)\n' +
        '  - Stellar x402 (@x402/stellar/exact/client whose payTo = STELLAR_X402_PAY_TO)\n\n' +
        'Docs: https://apiserver.mpprouter.dev/docs/integration\n',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    } catch (error: any) {
      console.error('[error]', error.message, error.stack)
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  },
}
