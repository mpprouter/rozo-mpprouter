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

## Automatic non-delivery refunds

For `stellar.charge`, the Router records the confirmed inbound payment before
calling the merchant. A timeout, upstream 5xx, explicit non-fulfillment (403),
or empty successful response creates one idempotent full-refund job. Async jobs
are checked by the Worker cron as well as during buyer polling. Failed channel
calls roll back the just-accepted cumulative voucher when it is still the
latest voucher, so undelivered usage is not consumed.

Failed charge responses include `Refund-Id`, `Refund-Status`, and
`Refund-Status-Url`. The public URL is an unguessable capability. It returns a
pending status until Stellar RPC confirms the exact signed USDC transfer back
to the original payer; only then does it return the HMAC-signed refund receipt
with both payment and refund transaction hashes.

The Router pool secret must not be placed in the Worker. Run the pull-only
executor from an isolated operator account whose Stellar CLI keystore contains
the Router pool identity:

```bash
REFUND_EXECUTOR_TOKEN=... npm run refund-executor -- \
  --router https://apiserver.mpprouter.dev \
  --source <router-pool-identity> --network mainnet --watch
```

The executor validates the job, builds a single SAC `transfer`, stores its
signed XDR and deterministic hash before broadcast, and reconciles ambiguous
broadcast outcomes by resubmitting only that exact envelope. Set the optional
`REFUND_MAX_ATOMIC` operator policy to cap an executor instance; the product
does not hard-code the sub-$1 limit used by rollout tests.

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
