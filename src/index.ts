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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
      if (url.pathname === '/health') {
        return handleHealth(env)
      }

      if (url.pathname === '/services' || url.pathname === '/v1/services/catalog') {
        return handleServices()
      }

      if (url.pathname.startsWith('/v1/services/')) {
        return handleProxy(request, env, ctx)
      }

      return new Response(
        'MPP Router - Stellar to Tempo Payment Proxy\n\n' +
        'Endpoints:\n' +
        '  GET /health              - Pool status\n' +
        '  GET /services            - Public service catalog\n' +
        '  GET /v1/services/catalog - Versioned service catalog\n' +
        '  POST /v1/services/<service>/<operation> - Call a public service route\n\n' +
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
