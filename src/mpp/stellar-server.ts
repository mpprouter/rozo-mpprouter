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
 *
 * V1 session support note (2026-04-10): the agent-side method list
 * stays at `stellar.charge` only. The original session-support-plan
 * assumed we could register `stellar.channel` alongside `stellar.charge`
 * with the same `recipient`/`network` boilerplate as a "free" upgrade,
 * but `@stellar/mpp/channel/server`'s `channel()` method actually
 * requires a per-channel contract address (`channel: string`) and a
 * per-channel `commitmentKey`, one instance per agent channel. That
 * pattern cannot be expressed in a single Mppx.create() call at cold
 * start — it would need a per-request factory, which is the
 * `KVStellarChannelManager` we explicitly scoped out. For V1 the
 * router stays single-shot stellar.charge on the agent side; the
 * real win from this branch is the Tempo-side tempo.session support
 * for OpenRouter. Agent-side streaming is V2 — see §9 wishlist.
 */

import { stellar } from '@stellar/mpp/charge/server'
import { Mppx, Store } from 'mppx/server'
import type { Env } from '../index'
import { doAtomicParams } from './kv-atomic-store'

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
export function createStellarPayment(env: Env, onSuccess?: (context: any) => void) {
  return createStellarPaymentForRecipient(env, env.STELLAR_ROUTER_PUBLIC, onSuccess)
}

/**
 * The same charge handler, but settling to an arbitrary recipient.
 *
 * This is the whole direct-settlement mechanism (provider self-serve
 * onboarding, 2026-09-03). `stellar.charge` already takes the recipient as
 * a parameter, so paying a third-party provider instead of our pool is a
 * different argument, not a different code path: the buyer signs a SEP-41
 * transfer straight to the provider's address and no ROZO account appears
 * anywhere in the transaction.
 *
 * `createStellarPayment` above is now a call to this with our own address,
 * which is what keeps the existing behaviour byte-identical rather than
 * merely equivalent — there is one implementation, and the 674 snapshot
 * routes pass the same value they always did.
 *
 * ## The one thing a caller must get right
 *
 * `recipient` MUST come from a signature-verified provider record
 * (`route.operator.payouts`), never from anything a request carried. It is
 * the destination of real money and there is no recovery: on this path the
 * funds never pass through us, so a wrong address here is not a
 * reconciliation problem, it is somebody else's money, permanently. The
 * only caller is the `route.operator` branch in `proxy.ts`.
 *
 * Fee sponsorship stays on: the buyer should not need XLM to pay a
 * provider any more than they need it to pay us, and the gas sponsor is
 * not part of the money path — it pays the transaction fee, not the
 * invoice.
 */
export function createStellarPaymentForRecipient(
  env: Env,
  recipient: string,
  onSuccess?: (context: any) => void,
) {
  // Store.cloudflare with AtomicParameters produces Store.AtomicStore,
  // which @stellar/mpp 0.7.0 requires for replay protection (update() CAS).
  // The DO-backed doAtomicParams provides TRUE linearizable CAS — see
  // src/mpp/kv-atomic-store.ts for the full race-safety proof.
  const store = Store.cloudflare(doAtomicParams(env.ATOMIC_STORE))

  const method = stellar({
    currency: getStellarUsdcSac(env),
    recipient,
    network: env.STELLAR_NETWORK as any,
    rpcUrl: env.STELLAR_RPC_URL,
    store,
    // Gas sponsor: pays Stellar tx fees so agents don't need XLM
    feePayer: {
      envelopeSigner: env.STELLAR_GAS_SECRET,
    },
  })

  const mppx = Mppx.create({
    methods: [method],
    realm: 'apiserver.mpprouter.dev',
    secretKey: env.MPP_SECRET_KEY,
  })
  if (onSuccess) mppx.onPaymentSuccess(onSuccess)
  return mppx
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
