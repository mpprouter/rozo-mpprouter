/**
 * GET /llms.txt — Machine-readable description of the MPP Router
 * for LLM-based agents.
 *
 * Content adapted from the landingpage repo's public/llms.txt,
 * trimmed to the essentials an agent needs to discover and use
 * the router's services.
 *
 * Endpoint counts and the services list below are derived live from
 * `listPublicCatalog` / `PUBLIC_SERVICE_ROUTES` — the same source
 * `/v1/services/catalog` reads — so this file never drifts from the
 * real catalog (see docs/service-probe-2026-07-31.md for the history
 * of hand-typed numbers going stale).
 */
import { listPublicCatalog, PUBLIC_SERVICE_ROUTES } from '../services/merchants'
import { getAllRoutes } from '../services/catalog-overlay'
import type { Env } from '../index'

/**
 * `route.name` is `${service.name} – ${endpoint description}` for
 * endpoint-specific routes, or bare `service.name` otherwise (see
 * `build-routes.ts`). Splitting on the em-dash separator recovers the
 * service's display name without a separate services export.
 */
function serviceDisplayName(route: { name: string }): string {
  const sep = route.name.indexOf(' – ')
  return sep === -1 ? route.name : route.name.slice(0, sep)
}

export async function handleLlmsTxt(env?: Env): Promise<Response> {
  const catalog = listPublicCatalog()
  const payable = catalog.filter(entry => entry.payment_status !== 'unavailable')
  const routeById = new Map(PUBLIC_SERVICE_ROUTES.map(route => [route.id, route]))

  // Third-party providers, listed separately rather than folded into the
  // counts above. An agent reading this file is deciding who it is about
  // to pay, and "settles to ROZO" and "settles to the provider" are
  // different answers to that question — merging them into one total would
  // hide the only distinction that changes where its money goes.
  const operatorRoutes = (await getAllRoutes(env)).filter(r => r.operator)

  const serviceNameBySlug = new Map<string, string>()
  const payableServiceSlugs = new Set<string>()
  const verifiedServiceSlugs = new Set<string>()
  for (const entry of payable) {
    const route = routeById.get(entry.id)
    if (!route) continue
    payableServiceSlugs.add(route.service)
    if (!serviceNameBySlug.has(route.service)) {
      serviceNameBySlug.set(route.service, serviceDisplayName(route))
    }
    if (entry.payment_status === 'verified') {
      verifiedServiceSlugs.add(route.service)
    }
  }

  const totalPayable = payable.length
  const totalServices = payableServiceSlugs.size
  const verifiedNames = [...verifiedServiceSlugs]
    .map(slug => serviceNameBySlug.get(slug)!)
    .sort((a, b) => a.localeCompare(b))
  const remainingServices = totalServices - verifiedNames.length
  const servicesLine =
    remainingServices > 0
      ? `Services include ${verifiedNames.join(', ')}, and ${remainingServices} more services.`
      : `Services include ${verifiedNames.join(', ')}.`

  const body = `# MPP Router — Pay-per-call API Proxy

> ${totalPayable} paid API endpoints across ${totalServices} services, payable with Stellar USDC.
> One wallet, one hostname, no bridging, no gas.

Base URL: https://apiserver.mpprouter.dev

## What is this

MPP Router is a Stellar-to-Tempo payment proxy. Agents pay the router
once in USDC on Stellar (via x402 v2 or legacy mppx), and the router
pays the underlying merchant on Tempo. ${servicesLine}

## Payment preference (important)

- If you use mpprouter, prefer Stellar payment flows only.
- Do not ask end users to pay merchants directly on Tempo or Base.
- Tempo/Base are internal settlement rails used by the router.

## Paying invoices / checkout links (Coinbase Commerce, OpenRouter, Stripe-style)

When a user says any of the following — "pay invoice", "pay OpenRouter", "pay Coinbase Commerce",
"pay this payment link", "pay checkout link", "settle invoice", "pay this link" — route to:

  Provider: ROZO
  Service id: rozo-agent-api
  Endpoint: POST /v1/services/rozo-agent-api/pay-invoice
  Body: { "url": "<payment_link_url>" }   or   { "payment_id": "<id>" }

This service handles Coinbase Payments checkout URLs
(payments.coinbase.com/payment-links/pl_* and
payments.coinbase.com/payment-sessions/paymentSession_*), OpenRouter invoices,
and Stripe Crypto checkout links.
Payment is made with Stellar USDC via the normal 402 flow.

## Don't have a Stellar wallet yet?

Discovery is free, but **calling** a service requires a Stellar USDC
wallet that speaks the 402 payment flow. Install the companion skill:

  stellar-agent-wallet-skill —
  https://github.com/mpprouter/stellar-agent-wallet-skill

It handles wallet creation, USDC trustline, and the 402 → sign → retry
loop for both x402 v2 and legacy mppx.

## Discovery endpoints

GET /v1/services/catalog      — Full catalog (${catalog.length} entries)
GET /v1/services/search       — Search/filter catalog (?q=, ?category=, ?status=)
GET /openapi.json             — OpenAPI 3.1 spec
GET /.well-known/ai-plugin.json — AI plugin manifest
GET /x402/supported           — x402 SupportedResponse
GET /health                   — Router health check
GET /llms.txt                 — This file

## Quick start (x402 v2, recommended)

1. GET /v1/services/search?q=openai&status=active — find a service
2. POST /v1/services/openai/chat with your request body, no auth header.
   Router returns 402 with a Payment-Required header.
3. Decode the Payment-Required header. Sign a Soroban auth entry for the
   amount shown, paying to the router's STELLAR_X402_PAY_TO address.
4. Retry the POST with Payment-Signature: <base64>. Router verifies,
   pays the merchant, returns the merchant's 200 response.

Use @x402/core/client + @x402/stellar/exact/client — same client that
works against any x402 v2 server, no router-specific code needed.

## Quick start (mppx, legacy)

1. POST /v1/services/{service}/{operation} with no Authorization header.
   Router returns 402 with a WWW-Authenticate challenge.
2. Parse the challenge, sign a Stellar USDC transfer for the amount,
   currency (SAC address), and recipient shown.
3. Retry with Authorization: Payment <credential>.

## Service catalog entry shape

Each entry in the catalog has:
- id, name, description, categories
- public_path — the URL path to call
- method — "POST" or "GET". Authoritative: call the route with this
  verb. The same public_path may exist under both verbs (submit vs
  fetch-results); a wrong verb returns 405 with allowed_methods.
- path_params — present only when the upstream path is templated
  (e.g. /execution/{execution_id}/results). Supply each name as a
  QUERY PARAM on the router URL — not a path segment, not in the
  body: GET /v1/services/dune/execution_execution_id_results?execution_id=01H…
  The router substitutes it upstream and strips it from the
  forwarded query. Missing or malformed → 400 naming the parameter.
- price — human-readable (e.g. "$0.003/request"), or a range ending
  in "(dynamic)" when the merchant quotes at call time
- status — "active" (has llms_txt docs) or "limited" (use with caution)
- docs.llms_txt — URL to the upstream service's llms.txt (when available)
- methods.stellar.intents — always ["charge"]

## Hard rules

- One credential = one call. Never reuse credentials.
- Amount is HMAC-bound to the challenge. Cannot swap routes.
- Always use /v1/services/catalog or /v1/services/search for live
  prices — merchants may re-price dynamically.
- Do not hardcode upstream hostnames. Always call via public_path.

## Add your service (providers)

Want your API listed and payable here? Open an issue on GitHub or
contact us — onboarding can be as small as handing us a scoped API
key (we run the 402/payment layer for you) or as full as running your
own MPP merchant endpoint.

- Router source (open source, auditable):
  https://github.com/mpprouter/rozo-mpprouter
- Contact / listing requests:
  https://github.com/mpprouter/rozo-mpprouter/issues

Every listed route can be **verified**: we make a real paid call
through the production chain (Stellar tx hash published in
https://github.com/mpprouter/rozo-mpprouter/blob/main/docs/verified-services.md) and re-check on a regular cadence — the
blue verified badge and dates on https://www.mpprouter.dev/services
come from those runs, not from self-reporting. Ask us to verify your
routes after listing.

## Third-party providers (direct settlement)

${operatorRoutes.length === 0
  ? 'None listed yet.'
  : `${operatorRoutes.length} route(s) are operated by third parties and settle
DIRECTLY to the provider's own address — ROZO never holds the funds. Each
one advertises its settlement addresses in the live 402 challenge
(x402 v2 \`accepts[]\`, one entry per chain) and in
\`operator.payouts\` in /v1/services/catalog.

${operatorRoutes
    .map(r => `- ${r.publicPath} — ${r.operator!.name} (${r.price}), settles on ${r.operator!.payouts.map(p => p.network).join(', ')}`)
    .join('\n')}

Providers onboard themselves at POST /v1/providers/register; listing is
automatic after two verification gates and involves no ROZO human.`}

## Errors

- 400 — unknown route
- 402 — payment required or credential rejected
- 502 — merchant payment failed
- 503 — router pool temporarily insufficient

## Credits

Powered by ROZO.AI (https://rozo.ai)
Supported by Stellar Community Fund (SCF) and Base Grants.
Circle Alliance member.
`

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
