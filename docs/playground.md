# Playground sessions

Self-serve prepaid demo sessions for the MPP Router. A Stellar developer makes
one wallet-signed USDC payment, gets a session token, and can then run real paid
calls against charge-verified upstreams from the browser.

Completely separate from the paid proxy (`src/routes/proxy.ts`): no auth flavour
was added there, no cache or refund behaviour was touched.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/playground/config` | none | Live model / chip / deposit catalog. Single source for the frontend. |
| `POST` | `/v1/playground/session/intent` | none | Quote a deposit → `{intent_id, memo, destination, amount_usdc, expires_at}` |
| `POST` | `/v1/playground/session/open` | none | Claim a paid deposit → `{session_token, balance_usd, expires_at}` |
| `GET` | `/v1/playground/session` | Bearer | Masked account, balance, last 20 calls |
| `POST` | `/v1/playground/chat` | Bearer | One chat turn against an allow-listed model |
| `POST` | `/v1/playground/blend-activity` | Bearer | Blend pool activity, aggregated + summarised |
| `POST` | `/v1/playground/tx-decode` | Bearer | Decode a Stellar transaction by hash |
| `GET` | `/v1/playground/admin/totals` | Bearer (operator) | Aggregates for solvency recon |

CORS needs no change: `authorization` and `content-type` are already in the
global allow-list, and all playground routes are `GET`/`POST`.

## Configuration

### Vars (in `wrangler.toml`, non-secret)

| Name | Default | Meaning |
| --- | --- | --- |
| `PLAYGROUND_ENABLED` | `"false"` | Kill switch. Every `/v1/playground/*` route 404s unless this is **exactly** `"true"`. Flip + redeploy to pull the feature with no code rollback. |
| `PLAYGROUND_GLOBAL_CAP_USD` | `"200"` | Global outstanding-credit ceiling. Deposit intents are refused once `Σ balances + Σ open holds + the new deposit` would exceed it. An unparseable value falls back to `$200`, never to "unlimited". |

### Secrets (`wrangler secret put <NAME>`)

| Name | Required | Meaning |
| --- | --- | --- |
| `PLAYGROUND_SESSION_SECRET` | yes | HMAC key for session tokens, min 16 chars. **Not** `MPP_SECRET_KEY` — rotating that one invalidates every outstanding 402 challenge on the paid proxy, so the playground must be rotatable alone. Unset ⇒ mint/verify fail closed with a 503 and the feature is inert. |
| `PLAYGROUND_RECON_TOKEN` | for recon | Operator bearer token for `/v1/playground/admin/totals`. Unset ⇒ that endpoint 404s. |
| `STELLAR_ROUTER_PUBLIC` | already set | The existing router USDC receiving account. Deposits land here; no new hot-wallet capability is created. |

Optional: `PLAYGROUND_HORIZON_URL` (defaults to `https://horizon.stellar.org`).

Generate a session secret without it ever entering a transcript:

```bash
openssl rand -hex 32 | wrangler secret put PLAYGROUND_SESSION_SECRET
```

## Deposit flow

1. Client `POST`s `{account}` to `/session/intent`. The DO checks the intent
   rate limit, the per-account $10/day deposit cap, and the global ceiling,
   then returns a memo nonce (`pg-` + 20 hex, 23 bytes — fits `MEMO_TEXT`'s 28).
2. The user's wallet sends **exactly** the quoted USDC amount to
   `STELLAR_ROUTER_PUBLIC` with that memo. (They need a little XLM for the fee.)
3. Client `POST`s `{intent_id, tx_hash}` to `/session/open`. The Worker verifies
   against Horizon that the transaction succeeded, the memo matches, and a
   payment operation has the exact destination, Circle's pubnet USDC issuer,
   the exact amount, and an operation source equal to the intent's account.
4. `(tx_hash, op_index)` is consumed atomically, the balance is credited, and a
   7-day session token is minted.

Claim-jacking needs **both** the `intent_id` (returned only to its creator) and
a matching on-chain fact. Re-opening with the same intent and payment is
idempotent and returns the original session; anything else is a 409.

## Money

Every amount is a 7-decimal USDC atomic `bigint`. No `number` amount exists in
the subsystem — see `src/playground/amount.ts`.

Each call is `reserve(call_id, max_price)` → upstream → `commit(actual)` or
`release`. The hold is taken **before** the upstream call, so a balance can
never go negative; a 4xx/5xx/timeout releases it in full, so a failed call is
never billed. A retried `call_id` returns the recorded outcome and never
charges twice.

Prices: chat `$0.02` (cheap tier) / `$0.10` (flagship), Blend activity `$0.03`,
tx-decode `$0.005`. Deposits are `$0.10` or `$1.00` and are **non-refundable
demo credit**.

## Model availability

Flagship models (`claude-opus-5`, `claude-sonnet-5`, `gpt-5.2`) and
`claude-haiku-4-5` are advertised by `/config` but ship **unavailable**. Their
upstream routes resolve to `tempo.session`, and the playground's charge seam
(`payMerchant()`) registers only `tempo.charge` with no `onChallenge` hook, so
it cannot answer a session challenge. Callable today: `llama-3.1-8b-instant`
(Groq) and `deepseek-v4-flash` (DeepSeek). Full reasoning in
`src/playground/models.ts`.

## Recon

```bash
npx tsx scripts/admin/playground-recon.ts --api https://apiserver.mpprouter.dev
```

Read-only. Checks that `credited == committed + balances + holds`, that the
incremental outstanding counter matches a full rescan, and that on-chain
memo-matched deposits are `>=` credited. Exits non-zero on mismatch — wire it to
a daily cron and page the founder on failure.

## Deploy checklist

Backend deploy here is **High risk** per the charter: founder approval, a codex
P0 review, and a smoketest before it goes out. Ship with `PLAYGROUND_ENABLED`
still `"false"`, set the secrets, then flip the var in a second deploy so the
feature's first real deposit is a deliberate act.
