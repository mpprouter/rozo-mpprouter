/**
 * Stellar MPP Server — issues 402 challenges to agents and verifies their payments.
 *
 * Two Stellar addresses involved:
 *   - STELLAR_ROUTER_PUBLIC: Where agents send USDC. Secret managed offline.
 *   - STELLAR_GAS_SECRET/PUBLIC: Pays tx fees (fee sponsorship). Low-value, only XLM.
 *
 * Verification uses mppx's HMAC-bound challenge flow so that credentials
 * presented by agents must echo a challenge that was actually issued by
 * this router with matching amount/currency/recipient.
 */

import { stellar } from '@stellar/mpp/charge/server'
import { Mppx, Store } from 'mppx/server'
import type { Env } from '../index'

/**
 * Stellar USDC SAC contract addresses, keyed by network id.
 */
const USDC_SAC: Record<string, string> = {
  'stellar:pubnet': 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  'stellar:testnet': 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
}

export function getStellarUsdcSac(env: Env): string {
  const network = env.STELLAR_NETWORK || 'stellar:pubnet'
  return USDC_SAC[network] || USDC_SAC['stellar:pubnet']
}

/**
 * Build an Mppx handler wired to the Stellar charge method. The returned
 * handler takes a `{ amount }` for the specific route call and returns
 * either a 402 challenge (no/invalid credential) or a 200 receipt holder
 * (credential verified).
 */
export function createStellarPayment(env: Env) {
  const store = Store.cloudflare(env.MPP_STORE)

  const method = stellar({
    currency: getStellarUsdcSac(env),
    recipient: env.STELLAR_ROUTER_PUBLIC,
    network: env.STELLAR_NETWORK as any,
    rpcUrl: env.STELLAR_RPC_URL,
    store,
    // Gas sponsor: pays Stellar tx fees so agents don't need XLM
    feePayer: {
      envelopeSigner: env.STELLAR_GAS_SECRET,
    },
  })

  return Mppx.create({
    methods: [method],
    realm: 'apiserver.mpprouter.dev',
    secretKey: env.MPP_SECRET_KEY,
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
