# MPP Router

MPP Router is a Cloudflare Worker that exposes a stable public API for paid services over a Stellar-based payment flow.

Public base URL:

```text
https://apiserver.mpprouter.dev
```

Public endpoints:

- `GET /health`
- `GET /services`
- `GET /v1/services/catalog`
- `POST /v1/services/{service}/{operation}`

Clients integrate only with Router URLs. Upstream provider domains and routing details are internal.

Quick start:

```bash
curl https://apiserver.mpprouter.dev/health
curl https://apiserver.mpprouter.dev/v1/services/catalog
```

For integration details, see [docs/integration.md](/Users/happyfish/workspace/rozov2/rozo-mpprouter/docs/integration.md).
