# MPP Router

## Recover an unused Stellar channel balance

The channel funder can recover the remaining balance without contacting MPP
Router. This is the escape hatch for non-delivery or Router downtime.

```bash
# Optional: inspect the current contract balance.
npm run refund-channel -- status --channel <C...>

# Start the on-chain waiting period. <identity> is a local Stellar CLI key name.
npm run refund-channel -- start --channel <C...> --source <identity>

# After the waiting period, return the entire remaining balance to the funder.
npm run refund-channel -- claim --channel <C...> --source <identity>
```

Use `--network testnet` for a testnet channel; the default is `mainnet`.
Add `--dry-run` to print the Stellar CLI command without submitting it.

The private key stays in the user's Stellar CLI key store. The script never
sends it to the Router. `refund()` fails safely if the waiting period has not
elapsed. This flow refunds the channel remainder only; it does not reverse an
amount the Router already settled from a valid signed commitment.

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

For integration details, see [docs/integration.md](docs/integration.md).
