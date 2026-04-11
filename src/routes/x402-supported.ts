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

import type { Env } from '../index'

export function handleX402Supported(env: Env): Response {
  if (env.X402_ENABLED !== 'true') {
    return new Response(
      JSON.stringify({ kinds: [], extensions: [], signers: {} }, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
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
          // @x402/stellar's `areFeesSponsored: true` means the
          // router facilitator pays tx fees on behalf of the agent.
          // Clients don't need to attach XLM for gas.
          fees_sponsored: true,
        },
      },
    ],
    extensions: [],
    signers: {
      [env.STELLAR_NETWORK]: [env.STELLAR_X402_PAY_TO],
    },
  }

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  })
}
