/**
 * Stellar MPP Server — issues 402 challenges to agents and verifies their payments.
 *
 * Two Stellar addresses involved:
 *   - STELLAR_ROUTER_PUBLIC: Where agents send USDC. Secret managed offline.
 *   - STELLAR_GAS_SECRET/PUBLIC: Pays tx fees (fee sponsorship). Low-value, only XLM.
 */

import { charge } from '@stellar/mpp/charge/server'
import { Store } from 'mppx'
import type { Env } from '../index'

export function createStellarChargeServer(env: Env) {
  const store = Store.cloudflare(env.MPP_STORE)

  return charge({
    currency: 'USDC',
    recipient: env.STELLAR_ROUTER_PUBLIC,
    network: env.STELLAR_NETWORK as any,
    rpcUrl: env.STELLAR_RPC_URL,
    store,
    // Gas sponsor: pays Stellar tx fees so agents don't need XLM
    feePayer: {
      envelopeSigner: env.STELLAR_GAS_SECRET,
    },
  })
}

/**
 * Get the Router's Stellar public key (the address agents pay to).
 */
export function getRouterStellarAddress(env: Env): string {
  return env.STELLAR_ROUTER_PUBLIC
}

/**
 * Get the Gas Sponsor's public key.
 */
export function getGasSponsorAddress(env: Env): string {
  return env.STELLAR_GAS_PUBLIC
}
