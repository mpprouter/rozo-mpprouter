/**
 * GET /openapi.json — OpenAPI 3.1 specification for the MPP Router.
 *
 * Static spec served directly from the Worker. Describes all public
 * endpoints including the pay-per-call proxy, catalog, search, and
 * discovery endpoints.
 */

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'MPP Router',
    version: '1.0.0',
    description:
      'Pay-per-call API proxy. 489 endpoints across 88 services, ' +
      'payable with Stellar USDC via x402 v2 or legacy mppx. ' +
      'One wallet, one hostname, no bridging, no gas.',
    contact: { url: 'https://mpprouter.dev' },
  },
  servers: [{ url: 'https://apiserver.mpprouter.dev' }],
  paths: {
    '/v1/services/catalog': {
      get: {
        operationId: 'listCatalog',
        summary: 'Full service catalog',
        description:
          'Returns all ~489 paid service endpoints with pricing, ' +
          'payment methods, docs links, and status.',
        responses: {
          '200': {
            description: 'Service catalog',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CatalogResponse' },
              },
            },
          },
        },
      },
    },
    '/v1/ledger': {
      get: {
        operationId: 'getLedger',
        summary: 'Public settlement ledger',
        description:
          'Append-only, unauthenticated record of settled paid calls: service, ' +
          'payer address, amount, Stellar settlement transaction, and outcome. ' +
          'Oldest first; page with `cursor`. Rate limited to 1 request per second per IP.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Rows per page, 1-100 (default 25).',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
          {
            name: 'cursor',
            in: 'query',
            description: 'Opaque cursor from the previous response `next_cursor`.',
            schema: { type: 'string' },
          },
          {
            name: 'tx',
            in: 'query',
            description:
              'Look up the single entry settled by this 64-hex Stellar transaction hash. ' +
              'Mutually exclusive with pagination.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'A page of ledger entries, or a single entry when `tx` is given.' },
          '400': { description: 'Malformed limit or tx hash.' },
          '404': { description: 'No ledger entry for that transaction hash.' },
          '429': { description: 'Rate limit exceeded (1 request per second per IP).' },
        },
      },
    },
    '/v1/services/search': {
      get: {
        operationId: 'searchServices',
        summary: 'Search and filter the service catalog',
        parameters: [
          {
            name: 'q',
            in: 'query',
            description: 'Keyword search across id, name, and description',
            schema: { type: 'string' },
          },
          {
            name: 'category',
            in: 'query',
            description: 'Filter by category (e.g. "ai", "media", "search")',
            schema: { type: 'string' },
          },
          {
            name: 'status',
            in: 'query',
            description: 'Filter by status: "active" (has llms_txt) or "limited"',
            schema: { type: 'string', enum: ['active', 'limited'] },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Max results to return (default 20, max 100)',
            schema: { type: 'integer', default: 20, maximum: 100 },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of results to skip (for pagination)',
            schema: { type: 'integer', default: 0 },
          },
        ],
        responses: {
          '200': {
            description: 'Filtered service list',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SearchResponse' },
              },
            },
          },
        },
      },
    },
    '/v1/services/{service}/{operation}': {
      post: {
        operationId: 'callService',
        summary: 'Call a paid service endpoint',
        description:
          'Universal pay-per-call proxy. Send your request body; ' +
          'without auth you get a 402 challenge. Sign and retry with ' +
          'Payment-Signature (x402) or Authorization: Payment (mppx).',
        parameters: [
          {
            name: 'service',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Service id (e.g. "openai", "exa", "firecrawl")',
          },
          {
            name: 'operation',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Operation slug (e.g. "chat", "search", "scrape")',
          },
        ],
        requestBody: {
          description: 'Request body forwarded to the upstream merchant as-is',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': { description: 'Merchant response (after successful payment)' },
          '402': {
            description:
              'Payment required. Includes WWW-Authenticate (mppx) and ' +
              'Payment-Required (x402) headers with the quote.',
          },
          '502': { description: 'Merchant payment failed' },
          '503': { description: 'Router pool temporarily insufficient' },
        },
      },
    },
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Router health check',
        responses: {
          '200': { description: 'Health status with pool addresses' },
        },
      },
    },
    '/x402/supported': {
      get: {
        operationId: 'x402Supported',
        summary: 'x402 protocol discovery',
        description: 'Returns x402 SupportedResponse with accepted schemes and networks.',
        responses: {
          '200': { description: 'x402 SupportedResponse' },
        },
      },
    },
    '/llms.txt': {
      get: {
        operationId: 'llmsTxt',
        summary: 'Machine-readable router description for LLM agents',
        responses: {
          '200': {
            description: 'Plain text llms.txt',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      CatalogResponse: {
        type: 'object',
        properties: {
          version: { type: 'integer' },
          base_url: { type: 'string' },
          generated_at: { type: 'string', format: 'date-time' },
          supported_payment_methods: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                scheme: { type: 'string' },
                network: { type: 'string' },
              },
            },
          },
          services: {
            type: 'array',
            items: { $ref: '#/components/schemas/ServiceEntry' },
          },
        },
      },
      SearchResponse: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Total matching results' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          services: {
            type: 'array',
            items: { $ref: '#/components/schemas/ServiceEntry' },
          },
        },
      },
      ServiceEntry: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          public_path: { type: 'string' },
          method: { type: 'string' },
          price: { type: 'string' },
          status: { type: 'string', enum: ['active', 'limited'] },
          status_note: { type: 'string' },
          payment_status: {
            type: 'string',
            enum: ['verified', 'available', 'unavailable'],
            description:
              'Payment availability tier (orthogonal to status): "verified" = operator real-money tested and chargeable; ' +
              '"available" = chargeable but NOT verified by Rozo (check charge_rozo_verified / session_rozo_verified before relying on it); ' +
              '"unavailable" = known-broken (real-money tested and failed), not chargeable.',
          },
          payment_enabled: {
            type: 'boolean',
            description: 'True iff the route is chargeable (payment_status is "verified" or "available"; i.e. not "unavailable").',
          },
          payment_status_note: {
            type: 'string',
            description: 'Explanation for "available"/"unavailable" routes. Omitted when verified.',
          },
          live_status: {
            type: 'string',
            enum: ['ok', 'degraded'],
            description:
              'Observed health RIGHT NOW, as opposed to payment_status/charge_rozo_verified, which record whether ' +
              'an operator has ever real-money verified the route and can be months old. "degraded" = the router has ' +
              'seen consecutive upstream failures on this route just now; expect 502s and gate accordingly. Set and ' +
              'cleared automatically: it clears on the next successful call, or after 15 minutes with no further ' +
              'failure. A route can legitimately be payment_status "verified" AND live_status "degraded" — that pair ' +
              'means "we proved this works, and it is broken at the moment".',
          },
          live_status_reason: {
            type: 'string',
            description:
              'Present only when live_status is "degraded": failure count, coarse failure category, and the time of ' +
              'the most recent failure. Deliberately coarse — upstream error bodies are never echoed here.',
          },
          live_status_since: {
            type: 'string',
            description: 'ISO timestamp of the first failure in the current run. Present only when degraded.',
          },
          recommended: {
            type: 'boolean',
            enum: [true],
            description: 'Present (true) only for operator-curated recommended services. Recommended implies real-money verified.',
          },
          charge_rozo_verified: {
            type: ['boolean', 'null'],
            description: 'Has Rozo real-money verified this route in charge mode? null = N/A for this mode or never tested in it.',
          },
          charge_rozo_verified_at: {
            type: ['string', 'null'],
            description: 'ISO timestamp of charge-mode verification, or null.',
          },
          session_rozo_verified: {
            type: ['boolean', 'null'],
            description: 'Has Rozo real-money verified this route in session mode? null = N/A for this mode or never tested in it.',
          },
          session_rozo_verified_at: {
            type: ['string', 'null'],
            description: 'ISO timestamp of session-mode verification, or null.',
          },
          docs: {
            type: 'object',
            properties: {
              homepage: { type: 'string' },
              llms_txt: { type: 'string' },
              api_reference: { type: 'string' },
            },
          },
          methods: {
            type: 'object',
            properties: {
              stellar: {
                type: 'object',
                properties: {
                  intents: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
}

export function handleOpenApi(): Response {
  return new Response(JSON.stringify(spec, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
