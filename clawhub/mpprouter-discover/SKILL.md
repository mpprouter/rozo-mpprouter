---
name: mpprouter-discover
description: Discover and search 489 paid API services on MPP Router — pay with Stellar USDC via x402 or mppx.
version: 1.0.0
metadata:
  openclaw:
    emoji: "🔍"
    homepage: https://mpprouter.dev
---

# MPP Router — Service Discovery

Discover paid API services available via MPP Router at
`https://apiserver.mpprouter.dev`. The router proxies 489 endpoints
across 88 services (OpenAI, Anthropic, OpenRouter, fal.ai, Exa,
Firecrawl, Replicate, Stability AI, Perplexity, Suno, Grok, Brave
Search, Alchemy, and more), payable with Stellar USDC.

## When to use

Activate when the user asks to:
- Find a paid API service (search, AI, image generation, scraping, etc.)
- Discover what services MPP Router offers
- Look up pricing or docs for a specific service
- Search for services by category or keyword

## How it works

### 1. Search services

```bash
curl -s "https://apiserver.mpprouter.dev/v1/services/search?q=KEYWORD&status=active&limit=10"
```

Parameters:
- `q` — keyword search across id, name, description
- `category` — filter by category (ai, media, search, blockchain, data, etc.)
- `status` — `active` (has llms_txt docs, recommended) or `limited` (use with caution)
- `limit` — max results (default 20, max 100)
- `offset` — pagination offset

Response:
```json
{
  "total": 7,
  "limit": 10,
  "offset": 0,
  "services": [
    {
      "id": "openai_chat",
      "name": "OpenAI",
      "description": "...",
      "public_path": "/v1/services/openai/chat",
      "price": "free",
      "status": "active",
      "docs": { "llms_txt": "https://..." },
      "methods": { "stellar": { "intents": ["charge"] } }
    }
  ]
}
```

### 2. Get full catalog

```bash
curl -s "https://apiserver.mpprouter.dev/v1/services/catalog"
```

Returns all ~489 services. Use search instead for targeted queries.

### 3. Read service docs

When a service has `docs.llms_txt`, fetch it to learn the request body format:

```bash
curl -s "<llms_txt_url>"
```

### 4. Call a service

```bash
curl -X POST "https://apiserver.mpprouter.dev/v1/services/{service}/{operation}" \
  -H "Content-Type: application/json" \
  -d '{"your": "request body"}'
```

First call returns `402 Payment Required` with payment details.
Sign with Stellar USDC and retry with `Payment-Signature` header (x402)
or `Authorization: Payment` header (mppx).

## Verified services (operator-tested on mainnet)

| Service | Path | Price | Mode |
|---------|------|-------|------|
| Parallel Search | `/v1/services/parallel/search` | $0.010/req | charge |
| Exa Search | `/v1/services/exa/search` | $0.005/req | charge |
| Firecrawl Scrape | `/v1/services/firecrawl/scrape` | $0.002/req | charge |
| OpenRouter Chat | `/v1/services/openrouter/chat` | dynamic | session |
| OpenAI Chat | `/v1/services/openai/chat` | dynamic | session |
| Gemini Generate | `/v1/services/gemini/generate` | dynamic | session |
| Alchemy RPC | `/v1/services/alchemy/rpc` | $0.000/req | charge |
| Tempo RPC | `/v1/services/tempo/rpc` | dynamic | session |

## Other discovery endpoints

- `GET /llms.txt` — machine-readable router description
- `GET /openapi.json` — OpenAPI 3.1 spec
- `GET /.well-known/ai-plugin.json` — AI plugin manifest
- `GET /x402/supported` — x402 protocol discovery
- `GET /health` — router health check

## Links

- Landing page: https://mpprouter.dev
- API base: https://apiserver.mpprouter.dev
- Full docs: https://mpprouter.dev/llms.txt
- Integration guide: https://mpprouter.dev/integration.md
- Powered by ROZO.AI (https://rozo.ai)
