# Verified Services — Charge & Session Mode Registry

> **Purpose**: Track which MPP Router services have been manually verified
> for Stellar charge and session (channel) mode. This document is the
> source of truth for `verifiedMode` values in `OPERATOR_OVERLAY`
> (`src/services/merchants.ts`).

## How stellar.intents Works

The catalog's `methods.stellar.intents` field tells Stellar clients which
payment intents the router will accept for a given service:

| Upstream mode | `stellar.intents` output | Rationale |
|---|---|---|
| `tempo.charge` | `["charge", "channel"]` | Both intents safe — charge settles per-request, channel clients can also use charge upstreams |
| `tempo.session` | `["channel"]` | Only channel is safe. Charge would accept payment but upstream rejects (no session voucher) — **pay-but-404 trap** |
| `verifiedMode === false` | *(omitted entirely)* | Route is known-broken. No stellar block = agents won't attempt payment |

**Rule**: the router never advertises `charge` for a session-only upstream.
This prevents the scenario where a Stellar agent pays via charge, the router
forwards to a session-only merchant, the merchant rejects, and the agent
loses money.

The `stellar_x402` block follows the same rule — omitted when stellar
intents are empty.

### Code location

- `stellarIntentsFor()` in `src/services/merchants.ts` implements this logic
- `OPERATOR_OVERLAY` in the same file stores all `verifiedMode` overrides
- `pickUpstreamPaymentMethod()` in `src/services/build-routes.ts` determines
  upstream charge vs session from the mpp.dev catalog snapshot

---

## Verified Services

### Charge Mode (verified working)

These services have been tested end-to-end with Stellar charge intent.
The router sends a `WWW-Authenticate: Payment intent="charge"` challenge,
the agent signs a one-shot SAC transfer, and the upstream merchant
accepts the charge settlement.

| Service ID | Public Path | Price | Verified By | Verified Date | Notes |
|---|---|---|---|---|---|
| `exa_search` | `/v1/services/exa/search` | $0.005 | muggledev | 2026-04-11 | Web search. First service verified on charge path |
| `firecrawl_scrape` | `/v1/services/firecrawl/scrape` | $0.002 | muggledev | 2026-04-11 | URL scraping |
| `parallel_search` | `/v1/services/parallel/search` | $0.010 | muggledev | 2026-04-10 | Web search. Original test service from day 1 |
| `alchemy_rpc` | `/v1/services/alchemy/rpc` | $0.000 | muggledev | 2026-04-11 | JSON-RPC. mpp.dev catalog says session, but merchant actually accepts charge. Overlay overrides `upstreamPaymentMethod: 'tempo.charge'` |
| `storage_upload` | `/v1/services/storage/upload` | $0.000 | muggledev | 2026-04-11 | Multipart upload initiation |

### Session Mode (verified working)

These services use Tempo session channels. The router holds an open KV
channel with the upstream merchant. Stellar agents must use the `channel`
intent — the router converts the channel commitment into a session voucher
for the upstream.

| Service ID | Public Path | Price | Verified By | Verified Date | Channel TX | Notes |
|---|---|---|---|---|---|---|
| `openrouter_chat` | `/v1/services/openrouter/chat` | free | muggledev | 2026-04-11 | `0x278bf3c7bb...` | Chat completions. Channel opened via `open-tempo-channel.ts`, KV state at `tempoChannel:openrouter_chat` |
| `openai_chat` | `/v1/services/openai/chat` | free | muggledev | 2026-04-11 | — | Chat completions |
| `gemini_generate` | `/v1/services/gemini/generate` | $0.000 | muggledev | 2026-04-11 | — | Uses `{model}` placeholder, default `gemini-2.0-flash` |
| `tempo_rpc` | `/v1/services/tempo/rpc` | $0.001 | muggledev | 2026-04-11 | — | Tempo L2 RPC endpoint |

### Broken (verified failing)

These services have been tested and confirmed broken. `verifiedMode: false`
in the overlay removes them from Stellar discovery so agents don't waste
money on them.

| Service ID | Public Path | Verified By | Verified Date | Failure Reason |
|---|---|---|---|---|
| `anthropic_messages` | `/v1/services/anthropic/messages` | muggledev | 2026-04-11 | Merchant returns 500 on direct mppx call. Both `/v1/messages` and `/v1/chat/completions` fail upstream. Channel is open but unusable until Anthropic merchant is fixed |
| `dune_execute` | `/v1/services/dune/execute` | muggledev | 2026-04-11 | Channel underfunded — Dune charged $4 initial probe but channel deposit was only $1. Needs topup or higher initial deposit |
| `modal_exec` | `/v1/services/modal/exec` | muggledev | 2026-04-11 | Merchant returns `tempo.charge` despite mpp.dev catalog listing session. Router charge fallback fires, but modal rejects empty `{}` body with 500. Need correct body shape |

### Unverified (tempo.session upstream, not yet tested)

These services are listed as session-only in the mpp.dev catalog but have
not been tested through the router. After the `stellarIntentsFor` fix,
they correctly advertise `stellar.intents: ["channel"]` only.

| Service ID | Public Path | Price | Status |
|---|---|---|---|
| `anthropic_chat_completions` | `/v1/services/anthropic/chat` | free | Untested — likely same issue as `anthropic_messages` |
| `gemini_version_files` | `/v1/services/gemini/version_files` | $0.001 | Untested |
| `modal_sandbox_create` | `/v1/services/modal/sandbox_create` | free | Untested |
| `modal_sandbox_status` | `/v1/services/modal/sandbox_status` | $0.000 | Untested |
| `modal_sandbox_terminate` | `/v1/services/modal/sandbox_terminate` | $0.000 | Untested |
| `alchemy_network_nft_v3_endpoint` | — | $0.000 | Untested. Note: `alchemy_rpc` (sibling) is verified charge despite catalog saying session |

---

## Remaining ~470 services (unverified)

The bulk of the catalog (~470 services) has `verifiedMode: undefined` and
`upstreamPaymentMethod: 'tempo.charge'` (inferred from mpp.dev). These
are **assumed to work with charge** based on the default path, but have
not been individually tested.

A full charge scan is planned — see `tasks/catalog-charge-test-log.md`
for results when available.

---

## How to Verify a New Service

1. **Charge mode**: Use `smoke-test-charge.mjs` in `rozoskilltest/` or
   the `test/test-client.ts` pattern. Add the service to `TESTS` array,
   run, confirm 200 + receipt.

2. **Session mode**: First open a Tempo channel via
   `scripts/admin/open-tempo-channel.ts`, then test with a channel-aware
   client. Confirm the KV state persists at `tempoChannel:{service_id}`.

3. **Update this doc**: Add a row to the appropriate table with your name,
   date, and any notes. Then update `OPERATOR_OVERLAY` in
   `src/services/merchants.ts` to set `verifiedMode`.

4. **Deploy**: The fix only takes effect on the live catalog after deploy.

---

## Smoke Test Results (2026-04-12)

Ran 6 end-to-end tests against live `apiserver.mpprouter.dev` using
two different 402 client libraries to verify both wire formats work.

Agent: `GAN3YSPDH5VW7YFJJFUJH7LIYTJBWGH3GJMKOG6FP5RKHXGNMPX44UYY`

### MPP charge (mppx/client + @stellar/mpp/charge/client)

| Service | Price | Status | HTTP | Time | Response |
|---|---|---|---|---|---|
| exa_search | $0.005 | ✅ SUCCESS | 200 | 38,156ms | Exa results for "ROZO.ai cross-chain crypto payment protocol" |
| firecrawl_scrape | $0.002 | ✅ SUCCESS | 200 | 28,696ms | Scraped rozo.ai homepage markdown |
| parallel_search | $0.010 | ✅ SUCCESS | 200 | 21,704ms | Parallel results for "ROZO AI cross-chain USDC payments Stellar" |

### x402 exact (@x402/core/client + @x402/stellar/exact/client)

| Service | Price | Status | HTTP | Time | Response |
|---|---|---|---|---|---|
| exa_search | $0.005 | ✅ SUCCESS | 200 | 35,652ms | Same query, x402 Payment-Required dialect |
| firecrawl_scrape | $0.002 | ✅ SUCCESS | 200 | 34,101ms | Same scrape, x402 path |
| parallel_search | $0.010 | ✅ SUCCESS | 200 | 18,143ms | Same query, x402 path |

**6/6 passed.** Total cost: ~$0.034 USDC.

Full logs: `rozoskilltest/smoke-test-charge-log.md`, `rozoskilltest/smoke-test-x402-log.md`

---

## Paid Verification Runs (tx-hash audit trail)

Machine-readable copy: [`verified-runs.json`](./verified-runs.json). Each run is a
**real Stellar mainnet USDC payment** through the production Router; the tx hash is
publicly auditable at `https://stellar.expert/explorer/public/tx/<hash>`. Cadence:
weekly, per-round spend cap $1.

### Run 2026-08-10

| Service | Result | UTC | Amount | Stellar tx |
|---|---|---|---|---|
| deepseek_chat | ✅ PASS (real completion) | 2026-08-10T07:55:59Z | $0.004 | `d3a0a8d42fc40415a0c36e6519fd5e121df4c9154405cc8f45399446ac7edf0b` |
| tavily_tavily_search | ✅ PASS (real search results) — first verification | 2026-08-10T07:56:49Z | $0.090 | `38eaecde40d6430654212bf59b32eb0e1275a6b5f8e3d958be8a56ec71649952` |
| openai_images_generations | ❌ FAIL — payment settled, upstream OpenAI rejected merchant key region (403 `unsupported_country_region_territory`), Router 502, auto-refund pending | 2026-08-10T07:56:26Z | $0.050 | `62ada49fe848ea313693f83f7e167ed3910a753a18af3e5afb116d0c91b5c934` |
| gemini_generate | ⛔ NOT RUN — route `payment_status: unavailable` (merchant Google key invalid, re-tested 2026-08-09) | — | — | — |

---

## Changelog

| Date | Who | Change |
|---|---|---|
| 2026-08-10 | agent (founder-approved, $1 cap) | Paid verification run: deepseek+tavily PASS, DALL·E upstream-fail, Gemini blocked. Added `verified-runs.json` tx-hash audit trail |
| 2026-04-12 | muggledev | Smoke test 6/6 passed (3 mppx charge + 3 x402 exact). Deployed `stellarIntentsFor` fix to production |
| 2026-04-12 | muggledev | Created doc. Fixed `stellarIntentsFor` to respect upstream mode. Added `upstreamPaymentMethod: 'tempo.charge'` override for alchemy_rpc |
| 2026-04-11 | muggledev | Initial `verifiedMode` overlay for 12 services (5 charge, 4 session, 3 broken) |
| 2026-04-10 | muggledev | First service catalog shipped with `parallel_search` as test service |

### Mercury (xycloo Labs) — first Stellar data service — 2026-08-11
First real-money verify runs (payer masked `GD5R4H...BB4U`, $0.0005/call):
- `mercury_events_by_contract` — tx `8b3a36f2b359328a37652b7f32e89e19b253487e9b28bc01a257161e1cf6b8c6` — 200, real USDC SAC transfer events
- `mercury_txs_by_hash` — tx `871099bf7ed2f36605ed568aa927d811d43893afc70863fb8a3fdf4279c07cdb` — 200, full envelope+meta
- `mercury_txs_by_contract` — tx `c82da0fc01501df246df43e5cbfb85d60bc5d9dd7df31a95addeb59af95f4b98` — 200
- `mercury_events_by_ledger` — NOT verified: mainnet upstream slow (40s+)/500 on 2026-08-11; kept disabled, filed with provider
