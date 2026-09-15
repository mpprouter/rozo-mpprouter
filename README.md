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

### Refund waiting period: 100 ledgers, and how the Router meets it

The unilateral close is `close_start`, then a wait of `refund_waiting_period`
ledgers, then `refund`. That window is the Router's only chance to submit the
latest signed voucher on chain; a voucher not submitted before the window
elapses is lost with the refund. Integrators who write their own channel
contract or spec ask how long the window has to be. The answer for this Router:

- **Production value: 100 ledgers** (about 8 to 10 minutes on pubnet). It is
  enforced, not advisory: `register` rejects any channel whose on-chain
  `refund_waiting_period` is not exactly 100
  (`src/playground/channel-onchain.ts`), the same way it rejects a foreign
  WASM hash. `GET /v1/playground/config` advertises it as
  `refund_waiting_period`.
- **Settlement runs from a 2-minute cron** (`wrangler.toml`,
  `src/playground/channel-settle.ts`). On the first tick that observes
  `close_start` the channel is durably fenced and the latest voucher is
  submitted through the channel's `close`. A failed submission (lock
  contention, RPC error) is retried on every following tick until it lands,
  so the window holds 4 to 5 attempts.
- **No new spend on a closing channel.** The call path checks the channel's
  current close state before paying upstream and refuses once `close_start`
  has been called (`src/playground/channel-close-guard.ts`). Exposure is
  bounded to vouchers already served before the close began.
- **Design floor: 60 ledgers** (`CLOSE_SAFETY_MARGIN_LEDGERS`, two cron ticks
  plus settle latency). 100 is the value the Router requires; a spec that
  needs one number should use 100.

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
REFUND_EXECUTOR_TOKEN="$(<"$HOME/.config/mpprouter/refund-executor-token")" npm run refund-executor -- \
  --router https://apiserver.mpprouter.dev \
  --source <router-pool-identity> --network mainnet --watch
```

The executor validates the job, builds a single SAC `transfer`, stores its
signed XDR and deterministic hash before broadcast, and reconciles ambiguous
broadcast outcomes by resubmitting only that exact envelope. Set the optional
`REFUND_MAX_ATOMIC` operator policy to cap an executor instance; the product
does not hard-code the sub-$1 limit used by rollout tests.

Production runs the signer as a separate cron-only Cloudflare Worker:

```bash
npm run deploy:refund-signer
```

`mpprouter-refund-signer` has no public route and only runs from its cron. It
holds the Router signing key separately from the request-serving Worker. Jobs
strictly below $100 are automatic; jobs above $10 additionally send an
operator alert, while jobs at or above $100 remain pending and alert once.

Public base URL:

```text
https://apiserver.mpprouter.dev
```

Public endpoints:

- `GET /health`
- `GET /services`
- `GET /v1/services/catalog`
- `POST /v1/services/{service}/{operation}`
- `GET /v1/ledger` — public settlement ledger (no token counts)

Buyer endpoints for the [x402 dashboard](https://github.com/mpprouter/x402-dashboard),
authenticated with the dashboard's wallet-signed session JWT (`Authorization: Bearer`,
shared secret `PORTAL_SESSION_SECRET`):

- `GET /v1/me/ledger?limit=&cursor=` — this wallet's LLM calls, newest first, with
  `model`, `provider`, `input_tokens`, `output_tokens`, `cached_tokens`, `settlement_ref`
- `GET /v1/me/usage?window=24h|7d|30d` — spend and token aggregates for the same wallet
- `GET /v1/me/sessions` — this wallet's own Stellar payment channels: deposit, spent, remaining, status

Clients integrate only with Router URLs. Upstream provider domains and routing details are internal.

Quick start:

```bash
curl https://apiserver.mpprouter.dev/health
curl https://apiserver.mpprouter.dev/v1/services/catalog
```

For integration details, see [docs/integration.md](docs/integration.md).

## Recommended first paid call

```bash
curl -s -X POST https://apiserver.mpprouter.dev/v1/services/openai/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","max_tokens":16,"messages":[{"role":"user","content":"Say hi in three words."}]}'
```

Without a payment this returns 402 with the quote (0.001 USDC on 2026-09-15). With
a valid `Payment-Signature` it returns the plain OpenAI chat-completion body,
`finish_reason: "stop"`. Use this as the integration smoke test before anything
else. Three things that look like router failures but are not: reasoning models
(`gpt-5*`, `gpt-oss-*`) return empty `content` with `finish_reason: "length"`
when the token budget is 64 or less; the `groq` and `deepseek` routes wrap the
provider body in `{"success":true,"data":{...}}`; and the `openai` / `anthropic`
routes inherit the provider's region policy (unsupported region: 502 with the
provider's 403 in `detail`, payment auto-refunded). Details in `/llms.txt`.

## Agent framework guides

- [Vercel AI SDK](docs/guides/vercel-ai-sdk.md) — two tools, a Stellar wallet
  and a hard spending ceiling. Runnable example in
  [`examples/vercel-ai-sdk/`](examples/vercel-ai-sdk/).
- [OpenClaw / Claude Code skill](https://github.com/mpprouter/stellar-agent-wallet-skill)
  — the same protocol packaged as a skill.
