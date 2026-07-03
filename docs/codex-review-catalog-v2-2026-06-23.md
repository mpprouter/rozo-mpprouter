# Codex Security Review — Catalog v2 Plan (2026-06-23)

> Independent codex review (gpt-5.x, high reasoning) of `docs/catalog-drift-fix-plan-2026-06-22.md`
> "v2 (FINAL)" section: remove the blanket payment gate, make all routes payable by default,
> add 4 per-mode `rozo_verified` trust fields. Reviewed with a hostile-customer (Argens) threat
> model. **Verdict: v2 as written is UNSAFE. Do NOT ship the un-gate as-is.**

---

## The core finding (overturns the plan's safety assumption)

The plan claimed removing the gate is safe because "router pays the merchant FIRST and only
settles the customer AFTER merchant 2xx". Codex traced both branches:

- **x402 branch — claim is TRUE.** Verify/simulate first (`proxy.ts:1128`), pay merchant
  (`proxy.ts:1158`), release nonce without charging on merchant error (`proxy.ts:1167`),
  settle customer only after merchant success (`proxy.ts:1179`/`:1194`). Safe ordering.

- **legacy mppx `stellar.charge` branch — claim is FALSE (the opposite).** Charge verification
  happens BEFORE merchant payment (`proxy.ts:1420` verify, then `proxy.ts:1539` pay merchant).
  The installed `@stellar/mpp` Charge method "verifies AND settles" — it broadcasts on-chain
  during verify (`@stellar/mpp/.../Charge.js:436`) and marks settled (`:474`). So if
  `payMerchantAndGetBody` then returns merchant 5xx (`proxy.ts:586`), **the customer has
  already paid and gets a 502.** Customer charged, no service delivered.

**=> Removing the gate is unsafe UNLESS** (a) the charge branch is changed to verify-only then
settle-after-merchant, OR (b) unverified routes are simply not served through the legacy mppx
charge path.

---

## All findings

### [P1] v2 unsafe for legacy stellar.charge (customer charged before merchant failure)
See above. The x402 branch is fine; the mppx charge branch settles the customer before
knowing if the merchant succeeded. With the gate gone, hundreds of unverified (often broken)
routes become reachable via this branch → customers pay and get 502.

### [P1] New money-loss surface vs today
Direct POSTs to unverified routes currently stop at the hard gate (`proxy.ts:754`). Removing
it lets hostile/stale clients trigger the full payment path on hundreds more routes. Known-
broken examples already show "we paid OK but merchant 502" (`merchants.ts:219`). mppx charge →
customer-charged-before-failure. x402 → settlement failure after merchant success returns
content anyway with failed-settle headers (`proxy.ts:1194`,`:1224`) → router POOL loss possible.

### [P1] Keep a server-side `verifiedMode === false` gate (catalog hiding is insufficient)
The current gate sits exactly before payment work (`proxy.ts:742`). The plan says confirmed-
broken stays non-payable but only enforced it in the catalog. It MUST be enforced in proxy,
because an attacker who knows the path bypasses the catalog entirely.

### [P1] Plan misses session voucher risk
`payMerchantSession` signs and bumps the cumulative BEFORE knowing the merchant's final status
(`tempo-client.ts:211`,`:272`). A merchant 5xx after voucher creation is not necessarily
harmless — the router may have advanced spend even when the proxy returns an error.

### [P2] Idempotency cache pre-auth
Idempotency cache keyed only by client-supplied `x-request-id` BEFORE auth (`proxy.ts:805`).
A guessed/reused ID can return cached paid content without proving the payer. (Pre-existing,
not introduced by v2, but worth fixing.)

### [P2] Weak overpay/drain controls
Pool preflight only checks balance >= merchant quote (`proxy.ts:978`). No per-route max quote,
daily spend cap, route circuit breaker, or quote anomaly gate. A malicious/compromised catalog
merchant can quote high; x402 settlement failure then leaves the router holding the cost.

### [P2] 4-field trust design can mislead
- `null` overloaded to mean both "N/A" and "never tested" — different things.
- Plan contradicts itself: `false` = tested-broken, but later says unverified session routes
  stay `false` while payable.
- Runtime dispatches on the merchant's LIVE 402 intent (`proxy.ts:515`,`:1514`), not the
  overlay — so static charge/session trust fields can drift from reality.

---

## Codex's minimum fix before shipping v2 (verbatim intent)

1. **Keep the `verifiedMode === false` proxy gate.** Do not remove it. Only broaden what's
   allowed through, do not open the floodgates.
2. **Do NOT open unverified routes to the legacy mppx charge path** until the charge
   settlement ordering is fixed (verify-only, then settle-after-merchant-2xx, matching x402).
3. **Add branch tests** proving a merchant-5xx does NOT settle the customer (for both branches).
4. **Add durable accounting + alerts** for x402 "settle-after-merchant" failures (pool loss).

---

## What this means for the plan (Shawn's call needed)

The founder goal — "put the ~485 services back, don't hard-gate everything" — is still
achievable, but NOT by simply deleting the gate. Safe paths:

- **Option A (safe, smaller):** keep the proxy gate, but flip its rule from "only ~11 verified
  are allowed" to "everything EXCEPT confirmed-broken (`verifiedMode:false`) is allowed" — AND
  first fix the mppx charge branch to settle-after-merchant (so an unverified-but-actually-broken
  route can't charge the customer for nothing). This restores the 485 while keeping funds safe.
- **Option B (route unverified through x402 only):** since x402 ordering is already safe, only
  un-gate routes that go through the x402 settle-after-merchant path; keep mppx-charge routes
  gated to the verified set until the charge ordering is fixed.
- **Either way:** the 4-field trust design needs cleanup (separate null-vs-untested; stop
  implying static charge/session when runtime follows live merchant intent).

Recommendation: **Option A**, because it directly delivers what the founder asked (485 back)
and the charge-ordering fix is the real root-cause repair that makes the whole router safe,
not just this feature.
