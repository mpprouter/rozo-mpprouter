# Live Service Probe — 2026-07-31

> **Purpose**: ground truth for "which endpoints actually work today", captured by
> **unpaid** probing of production (`https://apiserver.mpprouter.dev`). No payment was
> made, no channel was opened, no `verifiedMode` was changed.
>
> **Why re-probe**: catalog `verified` / `payment_status` fields are *historical
> snapshots, not current state* — the 2026-07-29 SCF44 lesson. Everything below is a
> live observation; where it disagrees with the catalog, the catalog is wrong.
>
> Companion docs: `docs/verified-services.md` (the `verifiedMode` registry),
> `REMIND.md` (channel/funding cheatsheet).

## Method

For each candidate: `POST` with a plausible JSON body and **no** `Authorization` /
`Payment-Signature` header, then decode both 402 dialects:

- MPP: `WWW-Authenticate: Payment id=…, method=…, intent=…, request=<base64url JSON>`
- x402: `Payment-Required: <base64url JSON>` (`x402Version: 2`, `accepts[]`)

Sample sizes: 26 hand-picked candidates (cheapest tier + all 12 catalog-verified +
known-broken controls) and 80 randomly sampled payable routes.

## Catalog shape (live, 2026-07-31)

| | |
|---|---|
| services | 496 (all POST, all `payment_method: stellar`) |
| payable (`payment_enabled`) | 481 |
| catalog-`verified` | 12 (all `charge_rozo_verified`; **zero** session-verified) |
| `unavailable` | 15 |
| distinct merchants | 81 |

## Result 1 — the dual-dialect 402 is healthy

Every route that accepted the request body emitted a **clean, consistent** dual 402:
**30/30** in the random sample, **21/21** in the hand-picked set.

Both dialects agree on amount, asset and recipient. Worth correcting a common
assumption: the two dialects carry the **same** `payTo` / `recipient`
(`GDK3AV..DXXB`) and the **same** asset (`CCW67T..MI75`), not different ones. Any
client that special-cases "MPP payTo ≠ x402 payTo" is coding against something this
server does not do.

Amounts are Stellar 7-decimal base units in both dialects (`20000` = $0.002).

Representative capture — `firecrawl_scrape`, HTTP 402:

```
www-authenticate: Payment id="d1uVjlA_…", realm="apiserver.mpprouter.dev",
  method="stellar", intent="charge", request="<base64url>",
  expires="2026-07-31T00:22:04.876Z", opaque="eyJyb3V0ZSI6ImZpcmVjcmF3bF9zY3JhcGUifQ"
payment-required: <base64url>
```

decoded `request` (MPP):

```json
{ "amount": "20000",
  "currency": "CCW67T..MI75",
  "recipient": "GDK3AV..DXXB",
  "methodDetails": { "credentialTypes": ["transaction"], "feePayer": true,
                     "network": "stellar:pubnet" } }
```

decoded `Payment-Required` (x402):

```json
{ "x402Version": 2, "error": "Payment required",
  "resource": { "url": "https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape" },
  "accepts": [ { "scheme": "exact", "network": "stellar:pubnet", "amount": "20000",
                 "asset": "CCW67T..MI75", "payTo": "GDK3AV..DXXB",
                 "maxTimeoutSeconds": 300, "extra": { "areFeesSponsored": true } } ] }
```

Request validation runs **before** the 402 (an empty body returns
`400 {"error":"Invalid request","message":"model is required"}`). That ordering is
correct — agents are never charged for a malformed request — but it does mean an
agent cannot discover a price without first constructing a valid body.

## Result 2 — showcase candidates, ranked

All three below were probed unpaid today and returned a clean dual 402. Ranked by
what an agent actually pays.

| Rank | Route | Live 402 amount | Catalog price | Body | Why |
|---|---|---|---|---|---|
| **1** | `POST /v1/services/firecrawl/scrape` | `20000` = **$0.002** | `$0.002/request` ✅ | `{"url":"https://example.com"}` | Only cheap route that is also `charge_rozo_verified: true`. Catalog price matches the live 402 exactly. Output is human-legible (markdown of a page) — good demo material. |
| **2** | `POST /v1/services/ipinfo/ipinfo_ip-lite` | `10000` = **$0.001** | `$0.001/request` ✅ | `{"ip":"8.8.8.8"}` | Cheapest correctly-labelled working route in the catalog. Tiny body, tiny response, instant. Not Rozo-verified end-to-end, so pair it with #1 rather than leading on it. |
| **3** | `POST /v1/services/exa/search` | `50000` = **$0.005** | `$0.005/request` ✅ | `{"query":"…"}` | `charge_rozo_verified: true`, price honest, and search results demo the "agent buys a capability" story better than a scrape. |

Runners-up, all clean dual 402 with honest prices: `firecrawl_map` ($0.002),
`codex_graphql` ($0.001), `stableemail_inbox_messages` ($0.001),
`deepseek_deepseek_list-models` ($0.003), `hunter_hunter_email-count` ($0.003),
`deepgram_deepgram_list-models` ($0.004), `parallel_search` ($0.010).

**Do not showcase** anything in the `free`-labelled tier (see Bug 1) — the price the
demo prints will not be the price the agent pays.

## Result 3 — bug list

### Bug 1 — 74 payable routes advertise `price: "free"` and charge real money · P0

`src/services/build-routes.ts:194` — `if (!payment || !payment.amount) return 'free'`.

The mpp.dev snapshot marks call-time-priced endpoints with `dynamic: true` **and** an
`amountHint`, and `MppEndpoint['payment']` (`build-routes.ts:74-81`) does not even
declare those two fields, so both are silently discarded and the route is labelled
`free`. 80 POST endpoints hit this branch; 74 of them are live and payable.

Live proof (unpaid probes, today):

| Route | Catalog says | Live 402 asks |
|---|---|---|
| `tavily_tavily_search` | `free` | `900000` = **$0.09** |
| `grok_grok_chat` | `free` | `706590` = **$0.0707** |
| `deepseek_chat` | `free` | `41260` = **$0.0041** |
| `dune_execute` | `free` | **$0.05–$4** per the merchant's own `amountHint`; a `SELECT 1` probe billed **$4** |

Agents select services on price. This is the same class of defect the founder already
flagged on Dune — Dune is not special, it is 1 of 74.

**Fix (in this PR)**: declare `dynamic` / `amountHint` on the payment type and render
`"$0.05-$4/request (dynamic)"`, falling back to `"dynamic"` when the merchant gives no
range. Route count is unchanged (496) and no route's payability changes.

### Bug 2 — sub-cent prices floor to `$0.003` / `$0.000` · P1

`src/services/build-routes.ts:200-201` — `Number(big * 1000n / divisor) / 1000` then
`toFixed(3)`. Integer division floors, so:

- `mapbox_mapbox_geocode-forward`: snapshot `3750` = $0.00375, advertised **`$0.003`** — a
  25% under-report; the live 402 asks `37500` (= $0.00375).
- 17 endpoints priced below $0.0005 (`alchemy` `100`, `storage` `100`, `quicknode` `10`,
  `googlemaps weather` `150`, …) advertise **`$0.000/request`**, which reads as free.

**Fix (in this PR)**: exact decimal rendering with a 3-decimal minimum, so existing
labels like `$0.002/request` and `$0.060/request` are byte-identical while
`$0.00375/request` and `$0.0001/request` become truthful. Covered by
`tests/catalog-price-labels.test.ts`.

### Bug 3 — all 45 Nansen routes are advertised payable and are 100% broken · P0

10/10 Nansen routes probed returned `502 {"error":"Merchant returned 402 without
WWW-Authenticate header"}` (`src/routes/proxy.ts:969`). The upstream emits a 402 in a
dialect the router cannot parse. All 45 carry `payment_status: available` in the
catalog. This is ~9% of the payable catalog pointing at a dead merchant, and it is the
exact failure mode `verifiedMode: false` exists to hide.

**Fix**: `src/services/merchants.ts` `OPERATOR_OVERLAY` — add `verifiedMode: false` +
`verifiedNote` for the `nansen_*` route family, same shape as the existing 15
`unavailable` entries. *Not applied here:* flipping routes off is still a catalog-facing
change to 45 routes and belongs in a founder-approved deploy, and Nansen may be a
transient upstream outage worth re-probing first.

### Bug 4 — routes advertised payable that 404 upstream · P1

`404 {"code":"route_not_found"}` from the merchant, while the catalog says available:
`stabletravel_transfers_search`, `stabletravel_transfers_cancel`,
`stabletravel_flights_seatmap`, `stableenrich_influencer_enrich-by-email`,
`stablestudio_generate_gpt-image-1_edit` — 3 distinct `stabletravel` routes among them,
so a full sweep of that merchant is likely to find more. The snapshot has drifted from the merchants' current route tables.

**Fix**: same `OPERATOR_OVERLAY` mechanism as Bug 3, after a full per-merchant sweep.

### Bug 5 — 176 payable endpoints are dropped, including the "read your result" half · P1

`src/services/build-routes.ts:250` — `if (method !== 'POST') continue`.

The snapshot contains **176** non-POST endpoints that carry a `payment` block, i.e. the
merchant expects to be paid for them. They are silently dropped, and the casualties are
systematically the *result-retrieval* halves of async APIs:

| Merchant | Exposed | Dropped |
|---|---|---|
| Dune | `POST /api/v1/sql/execute` | `GET /api/v1/execution/:id/results`, `GET …/csv` |
| Allium | `POST /api/v1/explorer/queries/:id/run-async` | `GET …/query-runs/:id/status`, `GET …/query-runs/:id/results` |

Paying $0.05–$4 for a Dune query you then have no endpoint to read is a broken product,
not a missing feature. The comment at `build-routes.ts:246-249` assumes non-POST routes
"tend to be free management endpoints"; the snapshot disproves it — these carry
`dynamic: true` and `amountHint: "$0.05-$10"`.

**Fix**: allow GET routes with a `payment` block through `buildRoutesFromMppSnapshot`
and teach `src/routes/proxy.ts` to forward GET with path-parameter substitution. That is
a real proxy change with its own review, so it is filed here, not attempted in this PR.

### Bug 6 — path-placeholder routes are unusable · P2

14 `agentmail_*` routes return
`400 {"error":"Bad upstream path placeholder"}` (`src/routes/proxy.ts:791`) because the
upstream path needs `{inbox_id}` / `{draft_id}` and there is no documented way to supply
them in the POST body. They are advertised payable. Either document the substitution
contract in `llms-txt` or mark them unavailable.

## Disagreements between catalog and live probe

| Catalog claim | Live reality |
|---|---|
| 481 routes payable | 45 (nansen) hard-fail 502; ≥5 more 404; 14 agentmail unusable → **~64 (13%) advertised-but-unusable** |
| 74 routes `price: "free"` | all charge; observed $0.0041 – $0.09, hinted up to $4 |
| 17 routes `$0.000/request` | charge $0.00001 – $0.0004 |
| `mapbox geocode-forward` `$0.003` | 402 asks $0.00375 |
| `dune_execute` payable, `free` | `403 Route not enabled for payment` (`proxy.ts:769`), channel underfunded |
| 12 routes `verified` | all `charge_rozo_verified`; **no** route has ever been session-verified |

## Not touched (founder approval required)

1. **Funding / topping up any channel** — spends real USDC, needs
   `TEMPO_ROUTER_PRIVATE_KEY` (not on this machine). Dune remains blocked on the
   approved $10 top-up.
2. **Flipping any `verifiedMode`** — including turning the 45 Nansen routes *off*.
3. **Deploying the Worker** — the price-label fix in this PR only reaches the live
   catalog after a deploy.
