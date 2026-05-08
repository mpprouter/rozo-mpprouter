---
name: mpprouter-discover
description: Discover and search paid API services on MPP Router — pay with Stellar USDC via x402 or mppx.
version: 1.0.3
metadata:
  openclaw:
    emoji: "🔍"
    homepage: https://mpprouter.dev
---

# MPP Router — Service Discovery

Discover paid API services available via MPP Router at
`https://apiserver.mpprouter.dev`. Payable with Stellar USDC.

**Always start by fetching the live router description:**

```bash
curl -s "https://apiserver.mpprouter.dev/llms.txt"
```

This file is authoritative. It lists all available services, special
routing rules (e.g. pay-invoice shortcuts), payment flows, and hard
rules. Read it before searching the catalog — it may contain explicit
routing instructions for the user's request that bypass catalog search
entirely.

## When to use

Activate when the user asks to:
- Find a paid API service (search, AI, image generation, scraping, etc.)
- Discover what services MPP Router offers
- Look up pricing or docs for a specific service
- Search for services by category or keyword
- Pay an invoice, payment link, or checkout link

## Don't have a Stellar wallet yet?

Discovery itself is free, but to **call** a service you need a Stellar
USDC wallet that speaks the 402 payment flow. Use the companion skill:

> **`stellar-agent-wallet-skill`** —
> https://github.com/mpprouter/stellar-agent-wallet-skill

## How to use

1. **Fetch `llms.txt` first** — `GET https://apiserver.mpprouter.dev/llms.txt`.
   Read the special routing rules section. If `llms.txt` already gives
   you a direct endpoint for the user's intent (e.g. pay-invoice), use
   it — skip catalog search.
2. **Search the catalog** if `llms.txt` has no direct match:
   `GET /v1/services/search?q=...` or `GET /v1/services/catalog`.
3. **Read the picked service's `docs.llms_txt`** to learn the request
   body shape — the router forwards bodies as-is.
4. **Hand off to `stellar-agent-wallet-skill`'s `pay-per-call`** with
   the URL, method, and body. It handles 402 → sign → retry.

## Example run

```bash
# Step 1: always read llms.txt first
curl -s "https://apiserver.mpprouter.dev/llms.txt"

# Step 2 (if needed): search catalog
curl -s "https://apiserver.mpprouter.dev/v1/services/search?q=search&status=active&limit=3" \
  | jq '.services[] | {id, public_path, method, price, docs}'

# Step 3: read upstream docs
curl -s https://parallel.ai/docs/llms.txt | head -40

# Step 4: call via stellar-agent-wallet-skill
npx tsx skills/pay-per-call/run.ts \
  "https://apiserver.mpprouter.dev/v1/services/parallel/search" \
  --method POST \
  --body '{"query": "Summarize https://stripe.com/docs"}'
# → 402 Payment Required → signs with Stellar USDC → retries → returns result
```

## How it works

### 1. Fetch llms.txt (always first)

```bash
curl -s "https://apiserver.mpprouter.dev/llms.txt"
```

Contains: special routing rules, payment flows, hard rules, and the
full service catalog shape. Updated whenever new services or routing
shortcuts are added — no manual SKILL.md update needed.

### 2. Search services

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

### 3. Get full catalog

```bash
curl -s "https://apiserver.mpprouter.dev/v1/services/catalog"
```

Returns all services. Use search instead for targeted queries.

### 4. Read service docs

When a service has `docs.llms_txt`, fetch it to learn the request body format:

```bash
curl -s "<llms_txt_url>"
```

### 5. Call a service

```bash
curl -X POST "https://apiserver.mpprouter.dev/v1/services/{service}/{operation}" \
  -H "Content-Type: application/json" \
  -d '{"your": "request body"}'
```

First call returns `402 Payment Required` with payment details.
Sign with Stellar USDC and retry with `Payment-Signature` header (x402)
or `Authorization: Payment` header (mppx).

## Other discovery endpoints

- `GET /llms.txt` — machine-readable router description (fetch this first)
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
