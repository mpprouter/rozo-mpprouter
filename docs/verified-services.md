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

### Run 2026-08-18 — SCF #44 Tranche 2 ("top 20 services verified payable")

Goal: take the count of **distinct verified services** from 15 to 20. Payer
masked `GD5R4H...BB4U`, all calls through production `apiserver.mpprouter.dev`.
Selection criteria, in order: a reviewer should recognise the name; a cheap
deterministic endpoint must exist; spread across categories rather than depth
on one provider.

> **Counting note.** The starting figure is **15 services**, not 14. A
> `chargeVerified === true` filter undercounts: `openai` was verified by a real
> paid call on 2026-08-09 but settles via the **session** dialect and so carries
> `verifiedMode: 'session'` with no `chargeVerified` flag. The submission
> promises verified *services* and describes both settlement dialects, so both
> count. The guard in `tests/get-routes.test.ts` uses the two-dialect predicate.

| Service | Category | Result | UTC | Amount | Stellar tx |
|---|---|---|---|---|---|
| `fal_flux_schnell` | image generation | ✅ PASS — real generated image URL returned | 2026-08-18T03:22:45Z | $0.003 | `7ee4ce8c359bebe4a4c94f94d9f815ff65b2faafe67a555a88d36f787ab6f9a1` |
| `alphavantage_alphavantage_company-overview` | market data | ✅ PASS — full IBM fundamentals record | 2026-08-18T03:23:14Z | $0.008 | `fc0296e6991beb22aee5923784df1de1e7971fb0c3f89d9db9a93ef6df1698f6` |
| `openweather_openweather_current-weather` | weather | ✅ PASS — live San Francisco conditions | 2026-08-18T03:23:31Z | $0.006 | `f5dfdc09cae3c3923769ada23bcc41f811f9e574157a8f90b3cabbeb11d761d9` |
| `deepl_deepl_languages` | translation | ✅ PASS — full supported-language list | 2026-08-18T03:24:29Z | $0.005 | `1a47118ef2f625ef0571cbb1ce028aad867f0d278e34a51c0a949b0a93edafea` |
| `mapbox_mapbox_geocode-forward` | maps / geocoding | ✅ PASS — real GeoJSON FeatureCollection | 2026-08-18T03:24:51Z | $0.00375 | `9592b917d7d2e7ea90fccede90e873191ce16ba6a846a4a74b2338ad1f817e51` |
| `wolframalpha_wolframalpha_short-answer` | computational knowledge | ✅ PASS — returned `"4"` for `2+2` | 2026-08-18T03:25:29Z | $0.055 | `cffd0d499221037352a7db87aaf22e2f7449a6c09058ad4c80853e4dadc33722` |

**6/6 passed. Total spend $0.08075**, confirmed by wallet balance delta
(2.0731820 → 1.9924320 USDC), which matches the six quoted prices exactly and
independently corroborates the tx-to-service mapping. Budget cap for the round
was $2.

**Result: 15 → 21 distinct verified services.** Tranche 2's commitment of 20 is
met with one service of headroom.

> **Superseded the same day: the figure is 20, not 21.** Two later delistings
> on 2026-08-18 removed both anthropic routes (see the round below). Anthropic
> was one of the 15 carried in, not one of the six added here, so the six
> results above stand exactly as recorded — but the total they produced does
> not. The commitment of 20 is still met, with zero headroom instead of one.

#### Probed and rejected — did not pay

These were free-probed first (Step 1 of `docs/SOP-provider-e2e-test.md`, costs
nothing) and excluded before any money moved. Recorded here because a rejected
candidate is as much a result as a passing one.

| Candidate | Free-probe result | Whose problem | Action |
|---|---|---|---|
| `googlemaps` (all routes) | **404** on the deployed Router for every route tried — `places:autocomplete`, `places:searchText`, `geolocate`, `computeRoutes`, `airquality`. The routes exist in this branch's `mpp-catalog-snapshot.json`, so the **deployed build predates the snapshot**. | **Ours** — a deploy-lag issue, not Google's | Deferred. Google Maps was the first-choice maps candidate; `mapbox` took the maps slot instead. Re-probe `googlemaps` after the next deploy — it is the strongest remaining name in this category. |
| `gemini::/generate` | **403 "Route not enabled for payment"** — the router's own security gate, because the route is `verifiedMode: false`. Unreachable without a deploy. | **Merchant** (see below) | Not flipped, not paid. See the note below — this is *not* an un-reprobed route. |
| `gemini::/version_files` | 404 on the deployed Router (with the required `?version=v1beta`) | Ours (deploy lag, as googlemaps) | Deferred to the same deploy |
| `gemini::/version_operations` | 405 — POST not allowed, it is a GET route | n/a | GET routes are gated `verifiedMode: false` by design |
| `wolframalpha` (first attempt, `{"input":...}`) | **400 "i is required"** — merchant pre-validates *before* the 402 is issued | n/a — our body was wrong | Retried with `{"i":"2+2"}` → clean 402 → paid → 200. Cost nothing. |

**On gemini specifically.** It is tempting to read `verifiedMode: false` plus a
note about an upstream 404 that was "fixed via `upstreamPath` override" as a
route that was fixed and then never re-probed — the exact shape mercury's
`events/by-ledger` was in. It is not. The overlay note in `merchants.ts` already
records a **real paid re-test on 2026-08-09**: the path fix works and the
request now reaches Google, but **the merchant's own Google API key is
rejected — 400 "API key not valid"**. That evidence is newer than the path fix.
Flipping the gate open would only buy a second 400 at our expense. Gemini is
blocked **merchant-side** and stays `verifiedMode: false` until the merchant
rotates its key; the correct next step is chasing the merchant, not a deploy.
Note also that gemini settles `tempo.session`, not charge.

#### Not attempted

`openai/embeddings` and `openai/responses` are payable and unprobed, and both
free-probe to a clean 402. They were left alone deliberately: `openai` already
counts as a verified service, so paying for them adds route depth without moving
the Tranche 2 number. Cheap follow-ups whenever route coverage is the goal.

---

### Run 2026-08-18 (later) — `anthropic_messages` re-probe → delisted

A verification round whose result is a **removal**. Recorded in the same detail
as a passing round, because a delisting carries the same burden of proof.

**Why it was run.** Earlier that day `anthropic_chat_completions` was delisted:
paid calls settled and then took a merchant-leg 403, so the router refunded
instead of delivering. Its sibling `anthropic_messages` was deliberately *not*
delisted with it, on the argument that it is a different upstream path settling
through an installed Tempo channel (session dialect) rather than per-request
charge. That argument was recorded as needing a paid re-probe, since the
route's newest evidence was a 2026-08-09 paid call. This round is that probe.
It also decided the headline number: anthropic was the only service keeping the
count at 21.

**Step 1 — free probe (no money).** `POST /v1/services/anthropic/messages`
returned `HTTP 402` with a well-formed challenge: `intent="charge"`,
`amount=10000` ($0.001), asset `CCW67TSZ...O7SJMI75`, recipient
`GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB` — matching
`/health.stellar.router_pool` and not on the compromised-address blacklist. The
quote layer is healthy, which is exactly why a free probe cannot settle this
question: the failure is downstream of payment.

**Step 2 — paid calls.** Two, on purpose. A single failure could be a
model-specific rejection, so a second current-generation id was run to rule that
out. Payer masked `GD5R4H...BB4U`.

| # | Model id | UTC | Amount | Stellar tx | Result |
|---|---|---|---|---|---|
| 1 | `claude-haiku-4-5` | 2026-08-18T09:47:30Z | $0.001 | `832cd4012991b9f4cca8a0d9ebfd18479d90c95697910e5d6b74d07961fc2152` | ❌ 502 — settled, merchant leg 403 |
| 2 | `claude-sonnet-4-5` | 2026-08-18T09:48:03Z | $0.001 | `ef7984cdbb35162331db6d32920beb9dcd96cec60a0513419eba6a9fbda09b69` | ❌ 502 — settled, merchant leg 403 |

Both returned a byte-identical body:

```json
{"error":"Merchant payment failed","status":403,
 "detail":"{\n  \"error\": {\n    \"type\": \"forbidden\",\n    \"message\": \"Request not allowed\"\n  }\n}"}
```

Corroborated independently through `GET /v1/ledger?tx=<hash>`:

```json
{"order_id":"ord_msyhbhlk_byuqlwpt","service":"anthropic_messages","amount_usd":"0.001",
 "status":"refund_pending","upstream_status":403}
{"order_id":"ord_msyhc4td_mh24qvsr","service":"anthropic_messages","amount_usd":"0.001",
 "status":"refund_pending","upstream_status":403}
```

**Verdict: delisted.** Two different current model ids failing identically rules
out the stale-id explanation that rescued this provider back on 2026-08-09, and
the error is the same `forbidden / Request not allowed` the charge route gets.
The block therefore sits at the merchant/provider level, above both settlement
dialects, and the session channel gives this route no immunity. `verifiedMode`
is now `false`.

**Consequence for the headline number: 21 → 20.** Anthropic had exactly one
listed route left and now has none, so it drops out of the distinct-verified
set. `tests/get-routes.test.ts` already anticipated this case in a comment and
its independent `>= 20` assertion still passes — **the Tranche 2 commitment of
"top 20 services verified payable" remains met, with zero headroom.** Payable
routes: 447 → 446.

**Total spend $0.002**, wallet delta `1.9884320 → 1.9864320 USDC` (exact).

#### Refund timing — slower here than on the charge route

Both calls were correctly classified `refund_pending` immediately, and the
refund path did engage: order `ord_msyhbhlk_byuqlwpt` reached `refunded`, with
the wallet independently confirming $0.001 coming back (`1.9864320` →
`1.9874320`). **The money is not lost.** At `09:54Z`, roughly six and a half
minutes after payment, the second order (`ord_msyhc4td_mh24qvsr`) was still
`refund_pending`.

Recorded only because it is slower than the one documented data point: the
`anthropic_chat_completions` refund rehearsed earlier the same day completed on
chain in **25 seconds** (`docs/grants/scf44/video2-refund-rehearsal.md` §2B,
refund tx `9df9959e...191c0afb`). The visible difference is the settlement
dialect — that route is `tempo.charge`, this one is `tempo.session`, whose
failure path additionally rolls back the channel voucher before enqueuing the
refund.

Stated deliberately weakly: **two samples against one is not a latency
regression**, the executor cron is `*/2 * * * *` so several minutes is not by
itself anomalous, and this round did not wait long enough to establish an
outer bound. The honest claim is "session-dialect refunds were observed taking
minutes where the one charge-dialect measurement took seconds, worth a proper
measurement sometime." Nothing was changed on the basis of it, and it does not
affect the delisting either way: a route that refunds in 25 seconds and a route
that refunds in ten minutes are both routes that did not deliver.

#### Playground — evaluated, no change needed

The question this round was meant to answer for the playground was whether the
Claude tier could be repointed from the dead `chat_completions` route to
`messages`. **It cannot: `messages` is dead too.** Nothing to reconnect, so
neither playground switch is touched — `wrangler.toml`'s
`PLAYGROUND_CHAT_MODELS_DISABLED = "anthropic,openai,gemini"` stays as-is, and
the `available: false` entries in `src/playground/models.ts` stay as-is. They
are now simply agreeing with reality on both routes rather than one. The
flagship playground tier stays empty until the Anthropic merchant is fixed;
`resolvePlaygroundRoute` refuses `verifiedMode: false` routes anyway, so the
code switch would block the calls even if the env switch were cleared.

---

## Changelog

| Date | Who | Change |
|---|---|---|
| 2026-08-18 | agent ($0.02 cap, spent $0.002) | Paid re-probe of `anthropic_messages` (the route held back from that morning's delisting pending exactly this test): two calls on two current model ids, both settled then took the merchant's 403, so it is **delisted** and anthropic leaves the verified set. **21 → 20 distinct verified services** (Tranche 2's commitment of 20 still met, now with zero headroom); payable routes 447 → 446. Playground Claude tier evaluated for repointing to this route — not possible, no change made. Noted, not acted on: the refunds engaged correctly (the first confirmed `refunded` on chain, wallet credited) but ran minutes rather than the 25 s measured on the charge-dialect sibling that morning |
| 2026-08-18 | agent ($2 cap, spent $0.081) | SCF #44 Tranche 2: charge-verified fal, alphavantage, openweather, deepl, mapbox, wolframalpha with real paid mainnet calls. **15 → 21 distinct verified services.** googlemaps deferred (all routes 404 on the deployed build — deploy lag); gemini stays delisted (merchant's Google key invalid, already evidenced by the 2026-08-09 paid re-test). Added a `tests/get-routes.test.ts` guard on the distinct-verified-service count that counts both `charge` and `session` dialects |
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
- `mercury_events_by_ledger` — **verified 2026-08-18** — tx `5028a601460bc30228b51d62072722b07df8c29b5bdb6100c92fa26d74064f0d` — 200, real Soroban events
  - History: failed the 2026-08-11 attempt (mainnet upstream slow 40s+/500), kept disabled and filed with the provider. Mercury diagnosed a query-plan issue on ledger ranges away from the chain tip and shipped a fix on 2026-08-15.
  - Re-verified on a **narrow** range (`start_ledger=50000000`, `end_ledger=50000010`). Very wide ranges stay bounded by a server-side timeout by design, so a wide-range probe would read as a false failure.
