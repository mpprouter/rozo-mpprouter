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

## The fix (ours)

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

### What we will NOT do

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
