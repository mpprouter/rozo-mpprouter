# MPP Router Integration Guide

## Overview

MPP Router provides a single public API for accessing supported paid services through a unified Stellar payment flow.

Public base URL:

```text
https://apiserver.mpprouter.dev
```

Clients must integrate only with MPP Router public URLs. Internal upstream providers, routing logic, and settlement details are not part of the public contract.

## Public API Contract

All client requests must be sent to Router-managed URLs under:

```text
https://apiserver.mpprouter.dev
```

Public routes use stable aliases:

```text
/v1/services/{service}/{operation}
```

Examples:

- `POST /v1/services/exa/search`
- `POST /v1/services/firecrawl/scrape`
- `POST /v1/services/openrouter/chat`
- `POST /v1/services/parallel/search`

## Service Discovery

### `GET /health`

Returns router health and basic public status.

### `GET /services`

Returns the public service catalog.

### `GET /v1/services/catalog`

Returns the same public catalog under a versioned path.

The public catalog contains only Router-facing metadata. It does not expose internal upstream domains or routing preferences.

## Payment Model

When payment is required, Router returns:

- HTTP `402 Payment Required`
- a `WWW-Authenticate` payment challenge
- a Router-issued Stellar payment request

Clients pay Router, not the internal upstream provider.

Payment identity:

```text
realm="apiserver.mpprouter.dev"
```

## Expected Client Flow

1. Client sends a request to `https://apiserver.mpprouter.dev/...`
2. Router returns `402 Payment Required` when payment is needed
3. Client signs and submits payment using the Stellar MPP flow
4. Client retries the same request
5. Router validates payment and returns the result

## Example

```ts
import { Mppx } from 'mppx/client'
import { stellar } from '@stellar/mpp/charge/client'
import { Keypair } from '@stellar/stellar-sdk'

const keypair = Keypair.fromSecret(process.env.STELLAR_SECRET!)

const mppx = Mppx.create({
  methods: [stellar.charge({ keypair })],
  polyfill: false,
})

const response = await mppx.fetch(
  'https://apiserver.mpprouter.dev/v1/services/parallel/search',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'stellar payments' }),
  },
)

const data = await response.json()
console.log(data)
```

## Error Handling

Clients should handle at least:

- `2xx` success
- `400` invalid request
- `402` payment required
- `403` route not allowed
- `404` unknown public service route
- `429` rate limited
- `5xx` router or upstream failure

## Stability Guarantees

MPP Router treats the following as public contract:

- base URL: `https://apiserver.mpprouter.dev`
- versioned public path format
- documented catalog fields
- Router-issued payment challenge flow

MPP Router does not guarantee stability for internal upstream provider details.

## What Clients Must Not Rely On

Clients must not rely on:

- upstream provider domains
- internal merchant hostnames
- internal routing order
- unpublished internal IDs
- direct third-party service URLs

Only Router URLs under `https://apiserver.mpprouter.dev` are public integration endpoints.
