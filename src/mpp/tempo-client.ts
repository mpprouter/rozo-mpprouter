/**
 * Tempo MPP Client — pays merchants on Tempo L2.
 *
 * Uses mppx tempo.charge client with the Router's EVM wallet.
 * The client auto-handles 402 challenges from Tempo merchants:
 *   1. Receives 402 + Tempo challenge
 *   2. Signs TIP-20 transfer from Router's EVM wallet
 *   3. Retries with payment credential
 *   4. Returns merchant's 200 response
 */

import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import type { Env } from '../index'

export function createTempoClient(env: Env) {
  const account = privateKeyToAccount(env.TEMPO_ROUTER_PRIVATE_KEY as `0x${string}`)

  const mppx = Mppx.create({
    methods: [tempo.charge({ account })],
    polyfill: false,
  })

  return mppx
}

/**
 * Pay a Tempo merchant by fetching through the mppx client.
 * The client handles the full 402 dance automatically.
 */
export async function payMerchant(
  env: Env,
  merchantUrl: string,
  init?: RequestInit,
): Promise<Response> {
  const client = createTempoClient(env)
  return client.fetch(merchantUrl, init)
}
