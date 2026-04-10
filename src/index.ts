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

  // Config
  OPTIMISTIC_THRESHOLD: string
  RATE_LIMIT_MAX: string
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
