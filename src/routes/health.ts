/**
 * GET /health — Pool addresses and KV store check.
 * Uses public keys from env (never touches secrets).
 */

import type { Env } from '../index'

export async function handleHealth(env: Env): Promise<Response> {
  const results: Record<string, any> = {
    status: 'ok',
  }

  // Stellar addresses (public keys only, no secrets exposed)
  results.stellar = {
    router_pool: env.STELLAR_ROUTER_PUBLIC,    // receives agent USDC
    gas_sponsor: env.STELLAR_GAS_PUBLIC,       // pays tx fees
    network: env.STELLAR_NETWORK,
  }

  // Tempo address
  results.tempo = {
    router_pool: env.TEMPO_ROUTER_ADDRESS,     // pays merchants in USDC.e
  }

  // KV store check
  try {
    await env.MPP_STORE.put('health:check', 'ok')
    const val = await env.MPP_STORE.get('health:check')
    await env.MPP_STORE.delete('health:check')
    results.kv_store = val === 'ok' ? 'ok' : 'mismatch'
  } catch (e: any) {
    results.kv_store = `error: ${e.message}`
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
