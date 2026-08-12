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

Each call is `reserve(call_id, max_price)` → upstream → `commit` or `release`.
The hold is taken **before** the upstream call, so a balance can never go
negative. A retried `call_id` returns the recorded outcome and never charges
twice.

### Commit vs release on failure

A failed call is **not** automatically refunded. For a session call the voucher
is signed — and the cumulative watermark advanced — *before* the merchant's
final response is known, so a late failure means the router has already paid.
Refunding there would hand out free upstream calls to anyone who can make the
response leg fail. The rule is: **release only when we can prove no payment
happened.**

| Evidence | Situation | Outcome |
| --- | --- | --- |
| `no` | Refused before dispatch (unknown/unverified route, rate limit, over-budget refusal, missing session channel), or a Mercury route that never pays | **release** |
| `yes` | Session voucher signed (watermark advanced), or merchant answered our paid retry with a bad status / unparseable body | **commit** |
| `maybe` | Lost response or timeout after dispatch | **commit** |

Charged failures return `charged_usd` plus a `support_note` telling the user
plainly they were billed for a call that did not deliver, and log at error level
with `PAID-BUT-FAILED` for support to find.

### Upstream spend ceiling

Every paid call passes a `maxAmountRaw` ceiling into `payMerchant` /
`payMerchantSession`, enforced in an `onChallenge` hook that throws
**before any credential is signed** if the merchant's live 402 asks for more.
The ceilings are backend constants (`TIER_UPSTREAM_BUDGET_USD`, chip
`budgetUsd`), independent of the flat price charged to the user, so an
allow-listed merchant that reprices or is compromised cannot drain the Tempo
pool. A call with no budget set is refused rather than defaulting to unlimited.

### Deposit caps

The checks at intent creation are advisory headroom only — they hold nothing.
The **enforcement point is `/open`**, inside the DO transaction that mints
credit, because otherwise many intents could each pass the check and then all
be opened. An over-cap deposit is recorded as a terminal `over_cap` intent plus
an `overcap:` record for support; the `(tx, op)` pair is deliberately **not**
consumed, so an operator can still credit it manually once the ceiling is
raised.

### Stranded calls

A DO alarm reaps calls stuck in `reserved` past a 5-minute lease. They are
**committed**, not released — the reserve→settle window brackets the paid
upstream call — and flagged `reaped: true` so support can issue goodwill credit
where the user genuinely got nothing.

Prices: chat `$0.02` (cheap tier) / `$0.10` (flagship), Blend activity `$0.03`,
tx-decode `$0.005`. Deposits are `$0.10` or `$1.00` and are **non-refundable
demo credit**.

## Upstream payment seams

Playground calls reach upstreams three ways, all reusing existing router
machinery (`src/playground/upstream.ts`):

| Route kind | Seam | Merchants |
| --- | --- | --- |
| `route.upstreamAuth` | direct `fetch` with the router-held JWT, no payment | Mercury |
| `tempo.charge` | `payMerchant()` | Groq, DeepSeek |
| `tempo.session` | `payMerchantSession()` (mirrors `proxy.ts:659`) | OpenAI |

Session mode signs a cumulative voucher against a channel pre-opened by
`scripts/admin/open-tempo-channel.ts`, keyed by `route.id`. The playground
relies on `payMerchantSession`'s own `onChannelUpdate` → `bumpCumulative` hook
to persist the watermark and does **not** replicate the proxy's extra post-2xx
bump, which derives its delta from a live-402 `parsed.request.amount` the
playground never sees.

Production KV (read 2026-08-13) holds channels for `anthropic_messages`,
`dune_execute`, `gemini_generate`, `openai_chat`, `openrouter_chat` and
`tempo_rpc`. Of the callable playground models only `gpt-4o-mini` uses the
session path, and `tempoChannel:openai_chat` exists — so **no operator channel
work is required** to enable the playground. A regression test asserts this
invariant for every callable model.

`anthropic_chat_completions` has **no** channel, which is why its overlay entry
is now pinned to `tempo.charge`: its 2026-08-09 real-money verification
succeeded, and a session call is impossible without a channel, so those calls
must have gone through charge. The proxy had been masking the bad
catalog-derived hint by dispatching on the live 402 intent. See the evidence
block above that entry in `merchants.ts`.

## Model availability

| Model | Tier | Price | Callable | Route |
| --- | --- | --- | --- | --- |
| `llama-3.1-8b-instant` | cheap | $0.02 | yes | groq (charge) |
| `deepseek-v4-flash` | cheap | $0.02 | yes | deepseek (charge) |
| `claude-haiku-4-5` | cheap | $0.02 | yes | anthropic chat_completions (charge) |
| `gpt-4o-mini` | cheap | $0.02 | yes | openai chat (session) |
| `claude-opus-5` | flagship | $0.10 | yes | anthropic chat_completions (charge) |
| `claude-sonnet-5` | flagship | $0.10 | yes | anthropic chat_completions (charge) |
| `openai-flagship-pending-verification` | flagship | $0.10 | **no** | openai chat (session) |

The Claude ids come from the 2026-08-09 paid-verification list in
`merchants.ts`'s `verifiedNote`; retired ids 404 at the merchant. `gpt-4o-mini`
is the only OpenAI id evidenced anywhere in the repo (channel-open probe + both
E2E scripts), and it is a small model, so it sits in the cheap tier — tier
follows the model, not the provider. No flagship OpenAI model has ever been
verified through this router, so that slot stays unavailable rather than
carrying a guessed id that would 404 *after* the router paid. Full reasoning in
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
