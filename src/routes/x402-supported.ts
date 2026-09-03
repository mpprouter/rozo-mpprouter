/**
 * GET /x402/supported — native x402 discovery endpoint.
 *
 * Returns a `SupportedResponse`-shaped JSON body matching the schema
 * from `@x402/core` (see `mechanisms-Djgn2ixv.d.mts` ~line 579).
 * This lets any spec-compliant x402 client discover what the router
 * accepts without parsing the Stellar-flavored `/services` catalog.
 *
 * Phase 1 advertises:
 *   - `exact` scheme on `stellar:pubnet` (or whatever env.STELLAR_NETWORK
 *     is set to). The router holds `STELLAR_X402_PAY_TO` as the
 *     recipient and runs its own in-process facilitator.
 *
 * Returns an empty `kinds` array when `X402_ENABLED=false`, so
 * operators can toggle the feature flag without introducing a 404
 * for existing x402 clients that might probe this endpoint.
 *
 * We deliberately do NOT implement `/x402/verify` or `/x402/settle` —
 * that would turn the router into a facilitator for OTHER servers,
 * which is out of Phase 1 scope.
 */

import { listPublishedProviders } from '../services/provider-registry'
import type { Env } from '../index'

export async function handleX402Supported(env: Env): Promise<Response> {
  if (env.X402_ENABLED !== 'true') {
    return new Response(
      JSON.stringify({ kinds: [], extensions: [], signers: {} }, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Third-party providers settle to their OWN addresses, on whichever
  // chains they registered. Each becomes its own `kinds` entry rather than
  // being folded into the router's: a client picking a kind is picking who
  // it pays, and collapsing "pays ROZO" and "pays Acme on Base" into one
  // row would make that choice invisible. `facilitator: 'none'` on the
  // non-Stellar rows is the honest label — we do not run one there and
  // cannot sponsor fees we do not pay.
  const providers = await listPublishedProviders(env)
  const providerKinds = providers.flatMap(provider =>
    provider.payouts.map(payout => ({
      x402Version: 2,
      scheme: 'exact',
      network: payout.network,
      extra: {
        pay_to: payout.payTo,
        asset: payout.asset,
        operator: provider.id,
        operator_name: provider.name,
        settlement: 'direct',
        facilitator: payout.network.startsWith('stellar:') ? 'self' : 'none',
        fees_sponsored: payout.network.startsWith('stellar:'),
      },
    })),
  )

  const signers: Record<string, string[]> = {
    [env.STELLAR_NETWORK]: [env.STELLAR_X402_PAY_TO],
  }
  for (const provider of providers) {
    for (const payout of provider.payouts) {
      const existing = signers[payout.network] ?? []
      if (!existing.includes(payout.payTo)) existing.push(payout.payTo)
      signers[payout.network] = existing
    }
  }

  const body = {
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: env.STELLAR_NETWORK,
        extra: {
          pay_to: env.STELLAR_X402_PAY_TO,
          asset: 'USDC',
          facilitator: 'self',
          settlement: 'pooled',
          // @x402/stellar's `areFeesSponsored: true` means the
          // router facilitator pays tx fees on behalf of the agent.
          // Clients don't need to attach XLM for gas.
          fees_sponsored: true,
        },
      },
      ...providerKinds,
    ],
    extensions: [],
    signers,
  }

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
