# PROPOSAL — Provider Lifecycle SOP + Test System (for codex review)

> Status: **PROPOSAL — not implemented.** This document is for codex review of the
> *approach* before any code/SOP is written. It extends the existing reactive
> `docs/SOP-provider-e2e-test.md` into a full lifecycle: onboard → verify →
> monitor → triage.
>
> Owner: Rozo. Date: 2026-06-24. Trigger: the stableemail `502 "Invalid base64
> JSON header"` incident (see `docs/rootcause-invalid-base64-json-header-2026-06-24.md`).

---

## 1. Why this proposal exists — the gap the incident exposed

The current SOP (`SOP-provider-e2e-test.md`) is **reactive**: it tells us how to
diagnose a provider AFTER a customer reports it broken. The stableemail incident
showed a class of failure that gets to the customer first, every time:

> A provider that was working can break **silently** when (a) we upgrade a shared
> dependency (mppx 0.4→0.7 made the x402 schema strict) and/or (b) the **merchant
> unilaterally changes its 402 challenge** (stableemail added a `solana:` offer).
> Neither change is visible in our repo, our tests, or our catalog. The first
> signal we got was a customer (Argens) reporting a 502.

The five mistakes made while fixing it (all caught by codex, see the RCA) share
one root pattern: **a locally-safe assumption breaks when it composes with an
external/other change.** A lifecycle that only reacts cannot catch these. We need
gates and monitors.

### Concrete gaps in today's SOP

| Gap | Today | Consequence |
|---|---|---|
| **G1. No onboarding gate** | A route can be marked `verified` / advertised payable by hand-editing OPERATOR_OVERLAY, with no enforced real-money proof. | A route can claim "verified" without ever settling once. |
| **G2. No continuous regression** | We only test when a customer complains. | Merchant- or dependency-induced breakage reaches customers before us. |
| **G3. Triage table is incomplete** | It covers TIP-1034/channel/pool errors, but NOT challenge-parse failures (`Invalid base64 JSON header`), dependency version drift, or "merchant changed its challenge shape". | We mis-blamed the client at first; the table would have pointed straight at the merchant challenge. |
| **G4. No "verified-but-now-failing" reconciliation** | `*_rozo_verified` flags are set once and never revisited. | A flag says "verified 2026-04-11" while the route is dead today. |

---

## 2. Proposed lifecycle (the four stages)

```
ONBOARD ──▶ VERIFY ──▶ MONITOR ──▶ (on failure) TRIAGE ──▶ back to VERIFY
  add route   real-$    weekly smoke   responsibility    fix + codex + reverify
  to overlay  proof     of all verified  table (extended)
```

### Stage A — ONBOARD (adding a new provider)

A checklist, NOT new code. When a route is added to OPERATOR_OVERLAY:
1. Record the merchant's upstream URL, intent (`charge`/`session`), price, and the
   minimal request body in `scripts/e2e/providers.mjs` (the single source of truth
   for testable routes) — including an `okCheck` that validates a real upstream body.
2. The route starts as `payment_status: available` (payable, **not** `verified`).
   It MUST NOT be hand-marked `*_rozo_verified: true` at this stage.
3. Capture the merchant's 402 challenge shape once (zero-cost probe) and note
   which networks it advertises in `accepts[]` — so a later change is detectable.

**Open question for codex:** should onboarding be blocked unless `providers.mjs` has
an entry? i.e. make `providers.mjs` the gate, so an un-testable route cannot be
advertised. (Leaning yes.)

### Stage B — VERIFY (the gate to mark `verified`)

A route may only get `charge_rozo_verified: true` / `session_rozo_verified: true`
(+ timestamp) after a **real-money** pass through production:
- `node scripts/e2e/charge-e2e.mjs <id>` returns `PASS` (HTTP 200 + okCheck).
- The verification timestamp is written by the **same tooling that runs the test**,
  not by hand — so a `verified` flag always corresponds to an actual settlement.

**Proposal:** add a `--write-verified` mode to `charge-e2e.mjs` that, on PASS,
emits the overlay snippet (`{chargeVerified:true, chargeVerifiedAt:"<ISO>"}`) for
the operator to paste — OR (stronger) writes a machine-managed
`verified-routes.json` that the catalog reads, so humans never hand-set the flag.

**Open question for codex:** machine-managed `verified-routes.json` vs hand-edited
overlay with tool-generated snippets. Trade-off: automation correctness vs. an
extra moving part on the payment-advertising path. (Leaning: tool-generated
snippet first — smaller blast radius — then automate if it proves reliable.)

### Stage C — MONITOR (catch silent regressions before customers)

A scheduled job that re-runs the e2e suite against ALL routes currently flagged
`verified`, on a cadence (proposal: weekly; charge routes are cheap — whole suite
< $1). Two parts:

1. **Zero-cost layer (frequent, e.g. daily):** probe every `verified` route's 402
   and assert the challenge still parses with mppx's parser AND that
   `accepts[].network` set hasn't gained an unrecognized network. This would have
   caught the stableemail Solana-offer change **before** anyone paid. Cheap enough
   to run daily.
2. **Real-money layer (weekly):** `charge-e2e.mjs` full run; any route that flips
   from PASS→FAIL raises an alert (DingTalk, the channel the router already uses)
   and is auto-demoted from `verified` → `available` with a note.

**Open question for codex:** is auto-demotion on a single failed run too
aggressive (flaky merchant → false demote)? Proposal: demote only after N
consecutive failures, alert on the first.

### Stage D — TRIAGE (extend the responsibility table)

Add the missing failure modes to the SOP's table:

| Symptom | Layer | Likely cause | Blame |
|---|---|---|---|
| `502 ... "Invalid base64 JSON header"` | challenge parse (mppx) | merchant added an offer with a network mppx can't parse (e.g. `solana:`), OR mppx schema got stricter on upgrade | **us** (parser fragility) — mitigated by the sanitizer; if it still appears, a NEW unparseable shape |
| `502 ... validation failed / expected array` | merchant body schema | our request body shape is wrong for this merchant | **us** (wrong body in providers.mjs) |
| previously-verified route now 502/parse-fails | merchant changed challenge, or dep upgrade | external change to a working route | **us to detect, often merchant to fix** |
| catalog says `verified` but route dead | stale flag (G4) | flag never reconciled | **us** (process) |

---

## 3. What gets built (if the approach is approved)

Minimal, in priority order — NONE of this is implemented yet:

1. **Extend the triage table** in `SOP-provider-e2e-test.md` with the rows above
   (docs only, zero risk).
2. **`scripts/e2e/monitor-verified.mjs`** — zero-cost daily layer: for every
   `verified` route, probe 402 and assert (a) mppx can parse the challenge, (b) the
   advertised `accepts[].network` set is a subset of a known-good allowlist. Emits a
   report; alerts on drift. (Read-only, no money, safe to run anywhere.)
3. **Wire the weekly real-money run** into the existing `charge-e2e.mjs` + a
   schedule, with first-failure alert / N-consecutive demote.
4. **(Optional, debated) machine-managed verified flag** per Stage B.

The sanitizer shipped today (`sanitize402Response`) is the *point fix*; this
proposal is the *process fix* so the next merchant/dep change is caught by us, not
by a customer.

---

## 4. Explicit questions for codex

1. Is the four-stage lifecycle the right decomposition, or is there a simpler
   framing that still closes G1–G4?
2. Stage B: tool-generated overlay snippet vs machine-managed `verified-routes.json`
   — which is safer for a payment-advertising path?
3. Stage C: daily zero-cost network-drift probe — is "assert `accepts[].network` ⊆
   allowlist" the right invariant, or does it create false alarms when a merchant
   adds a *legitimate* new network we simply don't pay (which is exactly the
   stableemail case the sanitizer now tolerates)? If the sanitizer already tolerates
   it, should the monitor alert (informational) rather than fail?
4. Stage C auto-demotion: right call, or should `verified` only ever be changed by
   a human after triage?
5. Anything in this proposal that could itself create a payment-safety risk (e.g.
   a monitor that accidentally runs against real customer funds, or a verified-flag
   automation that could mark a broken route verified)?
6. What's MISSING — a failure mode this lifecycle still wouldn't catch?
