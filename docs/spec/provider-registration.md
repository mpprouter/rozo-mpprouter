# Provider registration and the verification gate (v0.1)

How a provider/route enters the catalog, how the operator constrains it, and
what it takes to earn (and lose) the `verified` badge.

## 1. Pipeline

```
upstream snapshot  →  route builder  →  operator overlay  →  catalog
 (merchant-declared)   (mechanical)      (human judgment)     (published)
```

1. **Snapshot.** Providers declare their endpoints (path, method, payment
   block, pricing incl. `dynamic` + `amountHint`) in the upstream merchant
   catalog. The router ingests this snapshot mechanically.
2. **Route builder.** Deterministic transformation into catalog route
   objects. Allowlisted methods only (`POST`, `GET`); non-idempotent verbs
   are excluded until their replay semantics are reviewed. GET routes carry
   `path_params` so agents can construct calls.
3. **Operator overlay.** The operator's judgment layer — every entry is a
   deliberate, documented decision (see §2).
4. **Catalog.** Published with the field contract in [`catalog.md`](./catalog.md).

## 2. The operator overlay

The overlay is the single place where a human constrains the mechanical
pipeline. Supported controls:

| Control | Effect |
| --- | --- |
| `verifiedMode: false` + note | Removes the route from payable discovery (`payment_status: "unavailable"`, no intents). The protective off-switch |
| Service-wide key (`serviceId::*`) | One entry disables **every** payable endpoint of a merchant — required when a merchant-level fault would otherwise leave sibling routes charging customers |
| Method-qualified key (`service::GET::/path`) | Flips a single route (e.g. enabling one probed GET route at a time) |
| `upstreamPath` override | Templates a snapshot wildcard into a callable upstream path (e.g. `/{version}/models/*` → `/{version}/models/{model}:generateContent`) |
| Upstream payment-method override | Corrects a snapshot's declared charge/session mode when live behavior differs |

Overlay changes to production are operator-approved changes, not automatic.

## 3. The verification gate (normative)

A route may carry `charge_rozo_verified` / `session_rozo_verified` **only**
after a real paid call through the full production chain returned a valid
upstream result:

```
agent wallet pays Stellar USDC → router settles → router pays upstream
merchant → merchant calls the real API → valid result returned
```

- A 402 probe is **not** verification (it proves the quote layer, not
  settlement).
- Verification records a timestamp; flags are snapshots and age.
- Newly built routes default to **unverified and, where risk warrants,
  non-payable** — adding never-probed routes to the payable set wholesale is
  how catalogs end up advertising broken merchants.

## 4. Losing the badge

When live behavior contradicts the catalog (payment settles but the call
fails, merchant 5xx, upstream credential/region faults), the operator:

1. Reproduces with a real paid call, and where possible **bypasses the
   router** (direct merchant call with the same payment method) to attribute
   the fault: router vs gateway vs upstream API.
2. Flips the affected route — or the whole merchant (`serviceId::*`) — to
   `unavailable` so no further agent pays for known failures.
3. Files the diagnostics upstream (public issue) and re-verifies with real
   money after the upstream fix before restoring the badge.

Worked example: the 2026-07 `*.mpp.tempo.xyz` sequence — settlement-currency
regression detected by paid-call verification → merchants disabled
service-wide → upstream issue filed (tempoxyz/mpp#840) and fixed next day →
paid re-verification found two residual merchant-side faults (upstream
region-restriction; revoked upstream credential) → follow-up issue
(tempoxyz/mpp#852) with the routes kept offline until restored.

## 5. Ongoing guarantees

- A zero-cost daily monitor probes the verified roster and alerts on drift.
- The real-money E2E suite (`scripts/e2e/charge-e2e.mjs`) re-runs the full
  chain per provider; the procedure is documented in
  [`../SOP-provider-e2e-test.md`](../SOP-provider-e2e-test.md).
