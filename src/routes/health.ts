/**
 * GET /health — Pool addresses and KV store check.
 * Uses public keys from env (never touches secrets).
 */

import type { Env } from '../index'
import { receiptSignerAddress, retiredReceiptSignerAddresses } from '../refund/receipt-signer'

export async function handleHealth(env: Env): Promise<Response> {
  const results: Record<string, any> = {
    status: 'ok',
  }

  // Stellar addresses (public keys only, no secrets exposed)
  results.stellar = {
    router_pool: env.STELLAR_ROUTER_PUBLIC,    // receives agent USDC via mppx
    gas_sponsor: env.STELLAR_GAS_PUBLIC,       // pays tx fees
    network: env.STELLAR_NETWORK,
    // Public G... address whose Ed25519 key signs refund receipts. Published
    // so third parties can verify receipts against it; derived from the secret
    // rather than configured separately so it can never drift from the key
    // that actually signs. Undefined ⇒ receipt signing is not configured.
    receipt_signer: receiptSignerAddress(env.RECEIPT_SIGNING_SECRET),
    // Addresses of previously-used receipt signers. A rotation does not
    // invalidate receipts the old key signed, so its public address has to stay
    // published or those receipts become unverifiable. Public keys only.
    receipt_signer_retired: retiredReceiptSignerAddresses(env.RECEIPT_SIGNER_RETIRED_ADDRESSES),
  }

  // Tempo address
  results.tempo = {
    router_pool: env.TEMPO_ROUTER_ADDRESS,     // pays merchants in USDC.e
  }

  // Stellar x402 inbound. Advertises the recipient public key and the
  // feature flag state. Intentionally does NOT hit Soroban RPC here —
  // /health has to be fast and always 200, and there's no useful
  // balance query against a classic-account payTo that wouldn't also
  // need an explicit asset. Balance checks are operator-run, not
  // health-gated.
  results.stellar_x402 = {
    pay_to: env.STELLAR_X402_PAY_TO,
    network: env.STELLAR_NETWORK,
    enabled: env.X402_ENABLED === 'true',
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
