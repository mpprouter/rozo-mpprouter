/**
 * GET /.well-known/ai-plugin.json — Standard AI plugin manifest.
 *
 * Allows ChatGPT, agent platforms, and other OpenAI-compatible
 * systems to auto-discover the MPP Router as a plugin.
 */

const manifest = {
  schema_version: 'v1',
  name_for_human: 'MPP Router',
  name_for_model: 'mpprouter',
  description_for_human:
    'Pay-per-call API proxy — 489 endpoints across 88 AI and data services, ' +
    'payable with Stellar USDC. One wallet, one hostname.',
  description_for_model:
    'MPP Router proxies requests to 88 paid API services (OpenAI, Anthropic, ' +
    'OpenRouter, fal.ai, Exa, Firecrawl, Replicate, Stability AI, etc.) and ' +
    'handles payment via Stellar USDC. Use /v1/services/search to discover ' +
    'available services, then POST to /v1/services/{service}/{operation} with ' +
    'your request body. First call returns a 402 with payment details; sign ' +
    'and retry to get the result. Read /llms.txt for full usage instructions.',
  auth: { type: 'none' },
  api: {
    type: 'openapi',
    url: 'https://apiserver.mpprouter.dev/openapi.json',
  },
  logo_url: 'https://mpprouter.dev/favicon.svg',
  contact_email: 'support@rozo.ai',
  legal_info_url: 'https://mpprouter.dev',
}

export function handleAiPlugin(): Response {
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
