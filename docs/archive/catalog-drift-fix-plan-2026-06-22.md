# MPP Router — Catalog Drift Fix Plan (2026-06-22)

> Triggered by Argens (Fucci) bug report: dead routes ("Unknown public service route"),
> "Invalid base64 JSON header" on most providers, and 502s on several providers.
>
> Scope of THIS plan: only the issues that are **ours** to fix. The base64-header issue
> is client-side (mppx library) and is handled separately; nansen/moltycash 502s are
> merchant-side and out of scope.

---

## Root causes (investigated, evidence-backed)

### RC1 — Catalog advertises most unverified routes as Stellar-payable (the big one)

`listPublicCatalog` → `stellarIntentsFor` is **opt-OUT**: it advertises `charge` for
every route UNLESS `verifiedMode === false`. The generated route table is large, and only
a small operator-reviewed subset carries a `verifiedMode`. So most routes are advertised as
`stellar: charge` while never having been tested end to end.

Effect for an agent reading the catalog: it sees hundreds of payable services. Most of them
either 404 (path mismatch, see RC2) or 502 (merchant uses a different model / is broken).
This is why Argens experienced "most providers broken".

Evidence: `GET /v1/services/catalog` exposes unverified routes such as `stablestudio`,
`stableenrich`, and `tako` with `verifiedMode=undefined` but `stellar=YES`. Before coding,
compute the exact counts from the current route table instead of copying stale numbers from
this document (`src/routes/search.ts` and comments in `src/services/merchants.ts` have
previously drifted).

### RC2 — Two path shapes coexist; clients hold stale snapshots

`build-routes.ts` generates one route per endpoint with an auto-slugged path
(`coingecko/coingecko_simple-token-price`, `tako/mpp_v1_search_fast`). I added clean
overlay paths for 4 main endpoints yesterday (`coingecko/simple-price`, `groq/chat`,
`quicknode/rpc`, `deepseek/chat`), but:

- The ugly auto-paths still exist AND are still advertised.
- Argens's client holds an OLDER snapshot with yet another shape: double-prefix +
  slashes (`coingecko/coingecko/simple-price`, `tako/mpp_v1/search_fast`,
  `quicknode/{network}` unrendered, `stablestudio/gpt-image-1/generate` which no longer
  exists at all). All 404.

Evidence: `coingecko/coingecko/simple-price` → 400 "Unknown public service route";
`coingecko/simple-price` (mine) → 402 charge. Same for groq/quicknode.

### RC3 — A few routes have the wrong payment mode in the catalog

- `oxylabs`: catalog implies session, but live probe returns a valid **402 charge**
  challenge (`WWW-Auth=Payment id=...`). Client tried session → "channel not installed".
- `gemini`: upstream path `/{version}/models/*`; the literal `*` is never substituted, so
  the merchant 404s. Payment/session layer is fine (verified yesterday). Already flagged
  `verifiedMode: false`.

### NOT ours (out of scope, document only)

- **base64 JSON header**: thrown by `mppx/dist/internal/HeaderCodec.js:28` on the CLIENT.
  Our 0.7 server + our 0.7 client complete charges fine. Most likely Argens's client mppx
  version mismatches our 0.7 challenge header shape. Needs his probe log + version. Do NOT
  weaken our header encoding to accommodate an unverified client claim.
- **nansen / moltycash 502**: they return 402 without a WWW-Authenticate header (non-standard).
  Our router correctly maps that to 502. Merchant-side.

---

## The fix (ours) — v2 (2026-06-22, supersedes the hard-gate approach below)

### Why v2: the hard gate (PR #2) was too aggressive

PR #2 shipped an opt-IN model that (a) only advertised the ~11 manually-overlaid routes and
(b) added a proxy execution gate returning `"Route not enabled for payment"` for everything
else. Result in production: catalog advertises 11, **485 routes return "Route not enabled
for payment"** — including services Argens and his users had tested and were actually using.
We over-corrected: we treated "we haven't verified it" as "nobody may pay it", and封死了
真实在用的服务。

**Founder decision (2026-06-22): drop the hard gate. All routes stay payable by default.
Mark trust honestly with two fields instead of gating.**

### The actual safety basis (why "all payable" is safe)

Traced `src/routes/proxy.ts` (stellar.x402 branch, ~line 1047-1052): the router pays the
downstream merchant from **our own Tempo pool FIRST**, and **only submits the customer's
signed on-chain payment after the merchant returns 2xx** ("ONLY on merchant 2xx: submit the
agent's signed Soroban invoke on chain"). So if an unverified route's merchant is broken
(502), the customer's USDC authorization is never submitted → **the customer does not lose
money**. The downstream-first ordering is the real protection, not the catalog gate.
Therefore advertising an unverified route as payable does NOT endanger customer funds. The
only exposure is our own pool float, which is operational and bounded.

(Confirm this ordering also holds on the mppx `stellar.charge` branch during implementation,
not just the x402 branch — see `payMerchantAndGetBody` and the charge verify path. If charge
settles the customer BEFORE merchant 2xx, fix the ordering; do NOT reintroduce a blanket
gate.)

### Decision: per-mode trust fields, no gate (FINAL — founder-locked 2026-06-22)

A route's payment mode (charge vs session) is decided by the downstream merchant; some
support only one. Verification status differs per mode (we can batch-verify charge cheaply;
session needs a channel per merchant). So track trust **per mode**, 4 fields:

| field | type | meaning |
|---|---|---|
| `charge_rozo_verified` | `boolean \| null` | charge mode real-money verified? `null` = N/A or never tested in charge |
| `charge_rozo_verified_at` | `string \| null` | ISO timestamp of charge verification |
| `session_rozo_verified` | `boolean \| null` | session mode real-money verified? `null` = N/A or never tested in session |
| `session_rozo_verified_at` | `string \| null` | ISO timestamp of session verification |

`null` semantics: route does not use this mode / we have never touched it in this mode.
Distinct from `false` (tested, broken) and `true` (tested, works). The fields ALWAYS appear
on every entry (clients don't have to handle missing keys); inapplicable ones are `null`.

These must be backed by per-mode overlay data, NOT the single `verifiedMode` enum. Extend
`OPERATOR_OVERLAY` entries to carry per-mode verification (e.g. `chargeVerified` /
`chargeVerifiedAt` / `sessionVerified` / `sessionVerifiedAt`, or a `verified: {charge, session}`
sub-object) and render the 4 catalog fields from it. Keep the legacy `verifiedMode` working
during migration or migrate all readers together.

Payability rule (no blanket gate):
- **Default = payable.** A route with no verification (`null`/`false`) is still payable and
  still advertises stellar. The client reads the 4 fields and decides its own risk.
- **Only confirmed-broken stays non-payable.** A route we real-money-tested and found broken
  (the old `verifiedMode: false` cases — quicknode/gemini/nansen-style) is the ONLY thing
  that stays non-payable, so customers don't repeatedly hit known-dead services.

Verified set today (mark `charge_rozo_verified: true` with a timestamp): the 11 currently
advertised (exa, firecrawl, openai, openrouter, parallel, alchemy, tempo, storage, coingecko,
deepseek, groq). openrouter/openai were verified via session — set the session_ pair for
those, charge_ for the charge ones, per what was actually tested.

### charge vs session verification strategy (founder note)

- **charge**: stateless, single-shot. We can batch-verify almost all charge routes cheaply
  (probe → small real-money charge). Goal: mark the bulk of working charge routes
  `rozo_verified: true`.
- **session**: requires opening a Tempo channel + descriptor/deposit state per merchant.
  Expensive to verify. Only the few we've opened channels for get `rozo_verified: true`;
  the rest stay `false` (payable, unverified) until individually verified.

### Tactical fixes on top

1. **Path de-dupe** stays: clean overlay paths (coingecko/groq/quicknode/deepseek `chat`/
   `simple-price`/`rpc`) are the verified ones; the ugly auto-paths remain payable-unverified.

2. **oxylabs**: probes as charge. Verify with real money → mark `rozo_verified: true`.

3. **gemini**: keep `verifiedMode: false` (broken `*` wildcard path). `upstreamPath` override
   is a separate follow-up.

4. **Catalog response**: surface `rozo_verified` + `rozo_verified_at` on every entry. Do NOT
   reuse the docs-oriented `status`/`status_note` fields. Drop the v2 `payment_status` /
   `payment_enabled` design — two fields only, per founder.

### What we will NOT do

- Will NOT weaken router-side route validation or header decoding for a stale/unknown client.
- Will NOT delete snapshot routes.
- Will NOT touch nansen/moltycash behavior (merchant-side, correct as-is).
- Will NOT mass-mark routes `rozo_verified: true` without real-money proof.
- Will NOT keep the blanket "Route not enabled for payment" gate. Only `verifiedMode: false`
  stays non-payable.

---

## ⬇️ ORIGINAL v1 hard-gate design (SUPERSEDED — kept for history)

### Decision: flip the catalog to opt-IN honesty (the core change)

Change `stellarIntentsFor` so the catalog tells the truth about what's actually payable.
Do **not** overload `PublicCatalogEntry.status`: today it is typed/documented as
`active | limited` and means docs availability (`llms_txt` present or missing), with API
consumers in `src/services/merchants-types.ts`, `src/routes/search.ts`, and
`src/routes/openapi.ts`. Keep that contract unless we intentionally migrate all consumers,
schemas, and search filters together.

Add separate payment availability fields instead:

- `payment_status: 'verified' | 'untested' | 'unavailable'`
- `payment_enabled: boolean`
- optional `payment_status_note`

Three payment tiers, driven by `verifiedMode`:

| verifiedMode | `payment_status` | `payment_enabled` | advertises stellar intent? | meaning |
|---|---|---|---|---|
| `'charge'` / `'session'` | `verified` | true | yes | operator verified with real money |
| `false` | `unavailable` | false | **no** | known-broken (merchant 5xx / bad path) |
| `undefined` | `untested` | false | **no stellar block**, but still listed | exists upstream, not yet verified by us |

Key change: **`undefined` no longer advertises `charge`.** An agent paying should only
see services we've actually verified. Untested routes still appear in the catalog (so they
can be discovered and promoted) but carry no `methods.stellar` block and a clear
`payment_status: "untested"` + note, so no agent sends money into an unverified route.

### Decision (SECURITY-CRITICAL): also gate the PROXY execution path, not just the catalog

Traced `src/routes/proxy.ts`: it does **NOT** check `verifiedMode`. `resolveRoute` ->
`getRouteByPublicPath` (around proxy.ts:715 at time of writing) returns any route that
exists in `PUBLIC_SERVICE_ROUTES`, and the handler proceeds straight to charge/pay-merchant
(`const merchantHost = route.upstreamHost`). So hiding a route from the catalog ONLY stops
honest clients reading the catalog. An attacker (or anyone holding an old snapshot, like
Argens) who POSTs directly to an ugly/untested path still gets charged and still triggers a
downstream Tempo payment, potentially into a broken route. That is a real money-loss /
abuse surface, not just a UX bug.

**Fix: add a server-side gate in proxy.ts right after route resolution (after line ~715,
before any payment work).** If `route.verifiedMode !== 'charge' && route.verifiedMode !==
'session'`, refuse with a 4xx ("route not enabled for payment") BEFORE entering the charge
flow. This makes the catalog (advertising) and the proxy (execution) agree: an untested or
known-broken route is neither advertised NOR chargeable. The catalog flip alone is
insufficient; this gate is the actual security control.

Keep the refusal message generic (no merchant host / channel id / internal reason) so it
does not aid an attacker.

This is the honest, safe default. It shrinks the *payable* catalog to the verified set,
without deleting anything — untested routes are visible and promotable.

### Tactical fixes on top

1. **De-dupe path shapes.** For the 4 providers with clean overlay paths
   (coingecko/groq/quicknode/deepseek), the ugly auto-path duplicate should not also be
   advertised as payable. With the opt-in flip this is automatic: the ugly duplicates are
   `undefined` → no stellar block. The clean path (overlay, verifiedMode charge) stays.

2. **oxylabs**: add overlay `verifiedMode: 'charge'` after we verify it with real money
   (it probes as charge). Until verified, it stays untested (no stellar block) — which is
   still better than today's "advertised as session, fails".

3. **gemini**: keep `verifiedMode: false` (already done). Separately, the `*` wildcard
   path needs an `upstreamPath` override — that requires extending the overlay type to
   allow overriding `upstreamPath` (today it can't). Track as a follow-up; not in this
   change unless cheap.

4. **Catalog response**: add `payment_status`, `payment_enabled`, and
   `payment_status_note` for untested/unavailable so clients (and Argens) get an actionable
   signal instead of silently 404ing later. Leave the existing docs-oriented `status` /
   `status_note` fields alone unless this change intentionally includes a full API contract
   migration.

### What we will NOT do (v1)

- Will NOT weaken router-side route validation or header decoding to make a stale/unknown
  client "work". Unknown route → 400 is correct.
- Will NOT delete the snapshot routes. Untested ≠ deleted.
- Will NOT touch nansen/moltycash behavior (correct as-is).
- Will NOT mass-mark routes verified without real-money proof.

---

## Verification (independent, do NOT trust Argens's log)

After implementing, verify with OUR own test wallet via `scripts/e2e/`:

1. `probe-402.mjs` — confirm verified routes still 402 charge.
2. `charge-e2e.mjs` — re-confirm 3/3 charge PASS (deepseek/groq/coingecko).
3. New assertion: catalog no longer advertises `stellar` for any `verifiedMode: undefined`
   route. Add a catalog-honesty unit test.
4. Spot-check: a previously-"payable" untested route (e.g. a random stableenrich path) now
   shows `payment_status: untested`, `payment_enabled: false`, and no `methods.stellar`.
5. Add proxy security tests:
   - `verifiedMode === undefined` route returns a 4xx before merchant probing/payment.
   - `verifiedMode === false` route returns a 4xx before merchant probing/payment.
   - verified route still reaches the existing 402 charge flow.

## Blast radius

- `src/services/merchants.ts` `stellarIntentsFor` + `listPublicCatalog` (payment
  availability fields).
- `src/services/merchants-types.ts` catalog entry type for the new payment availability
  fields.
- `src/routes/openapi.ts` schema for the new payment availability fields.
- Search behavior only if we add explicit payment filters; do not repurpose the existing
  `?status=active|limited` filter.
- `src/routes/proxy.ts` verifiedMode execution gate before any charge/session/payment work.
- Possibly add 1 overlay entry (oxylabs) after verification.
- New/updated unit tests for catalog honesty and the proxy verifiedMode gate.
- No DO/CAS/session internals touched beyond confirming verified routes still reach the
  existing 402 flow.

## Risk

- Medium. The change makes the catalog advertise LESS, never more, and blocks direct proxy
  calls for routes that are not operator-verified. That means a route that happens to work
  but lacks `verifiedMode` will stop being callable until we verify and mark it. This is the
  intended safe default because it prevents stale snapshots or direct callers from sending
  money into unverified routes, but it is still a user-visible behavior change.

---

## Implementation result (2026-06-22)

Implemented exactly as planned. Computed counts at implementation time
(`PUBLIC_SERVICE_ROUTES.length`):

- **496** total routes listed.
- **11** `payment_status: verified` (carry a `methods.stellar` block, chargeable) — the
  operator overlay's `verifiedMode: 'charge' | 'session'` set.
- **5** `payment_status: unavailable` (`verifiedMode: false`).
- **480** `payment_status: untested` (`verifiedMode: undefined`).

Verified invariants (unit tests in `tests/catalog-payment-gate.test.ts`):

- No `verifiedMode: undefined` route advertises a `methods.stellar` block.
- `verified` catalog count === overlay routes with `verifiedMode: 'charge' | 'session'`.

Files changed:

- `src/services/merchants-types.ts` — added `payment_status` / `payment_enabled` /
  `payment_status_note` to `PublicCatalogEntry` (existing `status` left untouched).
- `src/services/merchants.ts` — `stellarIntentsFor` flipped to opt-IN; `listPublicCatalog`
  computes the three payment tiers.
- `src/routes/proxy.ts` — generic 403 gate after route resolution, before any payment work,
  when `verifiedMode` isn't `'charge' | 'session'`.
- `src/routes/openapi.ts` — `ServiceEntry` schema gains the three payment fields.
- `tests/catalog-payment-gate.test.ts` — new catalog-honesty + proxy-gate tests (7).
- `tests/catalog-payment-hints.test.ts` — updated the one stale `items[0]` assumption to a
  stable verified route (`parallel_search`).
- Stale route-count comments in `src/routes/search.ts` and `src/services/merchants.ts`
  replaced with "check `PUBLIC_SERVICE_ROUTES.length`".
