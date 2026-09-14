/**
 * Env-bound direct settlement for catalog routes.
 *
 * The self-serve provider flow (`provider-registry.ts`) only ever attaches
 * an `operator` to runtime overlay routes, and the payout address there is
 * signature-verified at registration. A catalog route such as Mercury is
 * different: the router already holds the provider's credential
 * (`upstreamAuth`) and issues its own fixed-price 402, so what changes
 * when the provider hands us a payout address is only WHO the buyer's
 * transfer names. That address arrives out of band (Telegram, 2026-09-14)
 * and lives in a Worker binding, so it is resolved here at request time
 * and the route is handed to the existing hosted-paywall branch in
 * `proxy.ts` (`route.operator` + `route.hosted`), which settles the
 * buyer's x402 transfer to the provider only after the upstream's 2xx.
 *
 * Fail-closed on a bad value: a binding that is set but is not a Stellar
 * public key yields an operator with NO payouts, which the proxy answers
 * with 503 (`Provider route misconfigured`) instead of quietly falling
 * back to the pool. Unset binding = feature off = pooled path, byte for
 * byte what the route did before.
 */

import type { PublicCatalogEntry, PublicServiceRoute } from './merchants-types'

const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/

export function withEnvDirectSettlement(
  route: PublicServiceRoute,
  env: Record<string, unknown> | undefined,
): PublicServiceRoute {
  const spec = route.directSettlement
  if (!spec || route.operator) return route
  const raw = env?.[spec.payToBinding]
  if (raw === undefined || raw === null || raw === '') return route
  const payTo = String(raw).trim()
  const network = typeof env?.STELLAR_NETWORK === 'string' && env.STELLAR_NETWORK
    ? env.STELLAR_NETWORK
    : 'stellar:pubnet'
  const valid = STELLAR_PUBLIC_KEY.test(payTo)
  if (!valid) {
    console.error(`[direct-settlement] ${spec.payToBinding} is not a Stellar public key; route ${route.id} disabled`)
  }
  return {
    ...route,
    operator: {
      id: spec.providerId,
      name: spec.providerName,
      payouts: valid ? [{ network, payTo, asset: 'USDC' }] : [],
      ...(route.chargeVerifiedAt ? { verifiedAt: route.chargeVerifiedAt } : {}),
    },
    hosted: true,
  }
}

/**
 * The catalog fields every `operator`-bearing route publishes, whether it
 * came from the runtime registry or from an env-bound catalog route. One
 * renderer so the two cannot drift: a buyer reads `settlement`,
 * `operator.payouts` and `payment_hints.pay_to` to decide whom to pay.
 */
export function operatorCatalogFields(
  route: PublicServiceRoute,
  env: { STELLAR_NETWORK?: string } | undefined,
): Pick<PublicCatalogEntry, 'methods' | 'settlement' | 'settlement_mode' | 'capability' | 'operator' | 'payment_hints'> {
  const operator = route.operator!
  const stellarPayout = operator.payouts.find(p => p.network.startsWith('stellar:'))
  return {
    methods: {
      // The router relays the PROVIDER's own 402 for these routes (or, when
      // hosted, issues an x402-only challenge naming the provider); it
      // never advertises OUR facilitator address here. No `stellar_x402`
      // block: the per-chain addresses live in `operator.payouts` and in
      // the live 402.
      stellar: { intents: !route.hosted && route.upstreamDialect === 'mppx' ? ['charge'] : [] },
      tempo: { intents: [], role: 'upstream' },
    },
    settlement: 'direct',
    settlement_mode: route.hosted ? 'router_paywall' : 'relay',
    ...(route.capability ? { capability: route.capability } : {}),
    operator: {
      id: operator.id,
      name: operator.name,
      ...(operator.verifiedAt ? { verified_at: operator.verifiedAt } : {}),
      payouts: operator.payouts.map(p => ({
        network: p.network,
        pay_to: p.payTo,
        asset: p.asset,
      })),
    },
    payment_hints: {
      network: env?.STELLAR_NETWORK,
      intent: 'charge',
      // What the buyer must speak: hosted routes issue x402 only; relayed
      // routes speak whatever the provider's endpoint was observed to.
      dialect: route.hosted ? 'x402' : route.upstreamDialect === 'x402' ? 'x402' : 'mpp',
      relayed: !route.hosted,
      // The provider's Stellar address — NOT ours. Omitted rather than
      // defaulted when the provider settles only on other chains: a wrong
      // hint here is worse than a missing one.
      ...(stellarPayout ? { pay_to: stellarPayout.payTo } : {}),
      requires_classic_usdc_trustline: true,
    },
  }
}
