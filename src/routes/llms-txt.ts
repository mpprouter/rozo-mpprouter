/**
 * GET /llms.txt — Machine-readable description of the MPP Router
 * for LLM-based agents.
 *
 * Content adapted from the landingpage repo's public/llms.txt,
 * trimmed to the essentials an agent needs to discover and use
 * the router's services.
 */

export function handleLlmsTxt(): Response {
  const body = `# MPP Router — Pay-per-call API Proxy

> 489 paid API endpoints across 88 services, payable with Stellar USDC.
> One wallet, one hostname, no bridging, no gas.

Base URL: https://apiserver.mpprouter.dev

## What is this

MPP Router is a Stellar-to-Tempo payment proxy. Agents pay the router
once in USDC on Stellar (via x402 v2 or legacy mppx), and the router
pays the underlying merchant on Tempo. Services include OpenAI,
OpenRouter, Anthropic, fal.ai, Replicate, Exa, Firecrawl, Perplexity,
Stability AI, Suno, Grok, Brave Search, Alchemy, and more.

## Don't have a Stellar wallet yet?

Discovery is free, but **calling** a service requires a Stellar USDC
wallet that speaks the 402 payment flow. Install the companion skill:

  stellar-agent-wallet-skill —
  https://github.com/mpprouter/stellar-agent-wallet-skill

It handles wallet creation, USDC trustline, and the 402 → sign → retry
loop for both x402 v2 and legacy mppx.

## Discovery endpoints

GET /v1/services/catalog      — Full catalog (489 entries)
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
- price — human-readable (e.g. "$0.003/request")
- status — "active" (has llms_txt docs) or "limited" (use with caution)
- docs.llms_txt — URL to the upstream service's llms.txt (when available)
- methods.stellar.intents — always ["charge"]

## Hard rules

- One credential = one call. Never reuse credentials.
- Amount is HMAC-bound to the challenge. Cannot swap routes.
- Always use /v1/services/catalog or /v1/services/search for live
  prices — merchants may re-price dynamically.
- Do not hardcode upstream hostnames. Always call via public_path.

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
