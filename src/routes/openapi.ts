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
