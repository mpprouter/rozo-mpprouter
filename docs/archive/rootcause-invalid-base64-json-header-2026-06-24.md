# Root cause: `502 "Invalid base64 JSON header"` on stableemail/send (and any merchant that added a Solana x402 offer)

Date: 2026-06-24
Reporter: Argens (Fucci), customer
Severity: HIGH (payment path; silently breaks previously-working `charge` merchants)
Status: root-caused, reproduced at zero cost, fix proposed (pending codex review)

## TL;DR

`mppx@0.7.0`'s x402 challenge parser rejects the **entire** 402 response if **any**
`accepts[]` offer carries a `network` it does not recognize. Several upstream
merchants (stableemail, exa, …) recently added a **Solana** x402 offer
(`network: "solana:5eykt4Us…"`) alongside their EVM/Tempo offers. mppx's
`PaymentRequiredSchema` only accepts `eip155:\d+`, so decoding throws
`InvalidJsonHeaderError("Invalid base64 JSON header.")`. That throw kills the
whole challenge-collection step — including the perfectly valid `www-authenticate`
(tempo) challenge that the router actually pays with. The router catches the throw
and returns `502 {"error":"Merchant payment failed","detail":"Invalid base64 JSON header."}`.

**No money moves** — the failure is during challenge decode, strictly before any
signing or broadcast. Argens's read ("thrown server-side during MPP→merchant
settlement, not client-side") is **correct**: it is thrown inside our router's
`payMerchant()` → mppx client, on the router→merchant leg.

## Evidence (all reproduced, zero cost)

1. The error string lives only in `mppx/dist/internal/HeaderCodec.js:28`
   (`throw new InvalidJsonHeaderError()` → message `"Invalid base64 JSON header."`).
   `HeaderCodec.decode()` throws it on ANY of: bad base64, bad JSON, or
   **failing `schema.parse`** (zod). It is NOT only a base64 problem.

2. The upstream `payment-required` header base64-decodes to valid JSON fine
   (manual `Buffer.from(h,'base64')` → `JSON.parse` succeeds). So the failure is
   the zod `schema.parse`, not base64.

3. Running the real router charge client (`mppx/client` `tempo.charge`,
   identical to `src/mpp/tempo-client.ts payMerchant`) against the live
   `https://stableemail.dev/api/send` throws:

   ```
   InvalidJsonHeaderError: Invalid base64 JSON header.
     at Module.decode (mppx/dist/internal/HeaderCodec.js:19)
     at x402Challenges (mppx/dist/client/Transport.js:82)        <-- decodePaymentRequired(header)
     at paymentRequiredChallenges (mppx/dist/client/Transport.js:75)
     at getChallenges (mppx/dist/client/Transport.js:48)
     at wrappedFetch (mppx/dist/client/internal/Fetch.js:54)
   ```

4. Feeding the live header through mppx's own `PaymentRequiredSchema.safeParse`
   pinpoints the exact field:

   ```
   issues: [{ path: ['accepts', 1, 'network'],
              code: 'invalid_format',
              message: 'Invalid EVM CAIP-2 network' }]
   ```

5. Dumping `accepts[]` shows what `accepts[1]` is — a Solana offer:

   | merchant | accepts[0] | accepts[1] | www-authenticate |
   |---|---|---|---|
   | stableemail | `exact eip155:8453` (USDC/Base) | `exact solana:5eykt4Us…` | **present** (`method=tempo`) |
   | exa | `exact eip155:8453` | `exact solana:5eykt4Us…` | **absent** |

## Why it broke "suddenly" (was working before)

- Pre-`0f432b1`/`6d97455` the router ran `mppx@0.4.12`. The merchants had not
  yet added the Solana offer. So the x402 header decoded fine.
- Two things changed around the same window: (a) we bumped mppx 0.4.12→0.7.0,
  (b) merchants began advertising a Solana x402 offer. The 0.7.0 x402 schema is
  strict (`eip155:\d+` only) AND the decode failure is non-isolating (one bad
  offer fails the whole list), so the Solana offer now poisons the whole 402.
- This is the classic "two safe-looking changes compose into a break" trap.

## Why exa still settles but stableemail doesn't — the real distinction

Both upstream x402 headers now contain the poisoning Solana offer, so the
**x402 collection branch throws for both**. The difference is the
`www-authenticate` header:

- `paymentRequiredChallenges` (Transport.js:70) array-spreads BOTH branches:
  `Challenge.fromResponseList` (www-authenticate / tempo) **and** `x402Challenges`
  (payment-required). Because they're spread into one array literal, the
  `x402Challenges` throw aborts the whole expression **even when the
  www-authenticate branch would have yielded a usable tempo challenge.**
- So the presence/absence of `www-authenticate` does not save stableemail here —
  the x402 throw happens regardless. (Exa's production success is via a
  different leg: x402-over-Stellar paid directly by the agent's `@x402/stellar`
  client, which never invokes mppx's EVM x402 decoder. stableemail/send is paid
  by the router via mppx `tempo.charge`, which does.)

The crisp, defensible statement: **mppx 0.7.0's `x402Challenges` is not
fault-isolating — a single unrecognized-network offer throws and discards every
other (valid) challenge in the same 402.**

## Critical-eye check on the reporter (treat as potential adversary)

- Argens's claim is independently verified by our own zero-cost repro against the
  live upstream — not taken on trust. ✅
- His "no funds moved (receipt null)" is consistent with HIS path: he pays via
  x402 v2 (`@x402/stellar`), which settles the customer AFTER the merchant returns
  2xx. For that branch, this error throws before merchant 2xx, so he is not
  charged. ✅

### ⚠️ P0 CORRECTION (found by codex review 2026-06-24): NOT universally "no money moves"

An earlier draft claimed "there is NO scenario where the customer is charged and
the merchant isn't." **That is FALSE for the legacy inbound `stellar/charge`
path.** It is true ONLY for (a) the outbound router→merchant Tempo leg and (b) the
inbound `stellar.x402` branch (settles after merchant 2xx).

- Legacy `stellar/charge` "verifies AND settles" — `@stellar/mpp` broadcasts the
  customer's on-chain payment during *verify* (`sendRawTransactionSync`,
  `tempo/server/Charge.js:338`), which the proxy runs at `proxy.ts:1428`,
  BEFORE `payMerchantAndGetBody()` at `proxy.ts:1547`.
- So a customer who pays via the **legacy stellar.charge** flavor CAN be charged
  while the merchant is never paid, for exactly this `InvalidJsonHeaderError`
  (the merchant leg 502s after the customer is already settled).
- This is the same accepted-risk settlement ordering documented at
  `proxy.ts:748`. The Solana-offer bug makes that latent risk *fire* for any
  charge merchant that added a Solana x402 offer.
- Argens himself is NOT exposed (he's on x402 v2), but other legacy clients are.
  The fix below removes the trigger entirely; the underlying settlement-order
  risk for legacy stellar.charge remains a separate, founder-accepted item.
- His wallet `GDCO2AKY…6LB6` and tx `11069520…a8bb89` (exa) are public on-chain
  facts; nothing sensitive disclosed. No action needed.
- He did NOT send us a malformed header to trick our parser — the malformed- for-
  mppx header comes from the *merchant*, not the client. The client cannot
  exploit this to make us pay the wrong party.

## Fix options

### Option 1 (preferred, smallest, robust) — sanitize the upstream 402 before mppx sees it

In the router→merchant leg (`src/mpp/tempo-client.ts`), wrap `client.fetch` with a
fetch that, on a 402 response, rewrites the `payment-required` header to **drop
offers whose `network` mppx can't parse** (anything not `eip155:\d+`), keeping the
EVM/Tempo offer the router actually pays. If, after filtering, no x402 offer
remains, drop the `payment-required` header entirely so mppx falls back to the
`www-authenticate` (tempo) challenge.

- Pro: surgical, version-proof (works regardless of which networks mppx adds
  later), keeps us paying the same EVM offer we always did. No settlement-order
  change. No catalog change.
- Con: we parse/rewrite a header in the proxy (well-contained, base64-JSON only).

### Option 2 — upgrade/patch mppx so x402Challenges is fault-isolating

File upstream: `x402Challenges` should `try/catch` per-offer (or per-header) and
skip unparseable offers instead of throwing the whole list. Right fix long-term,
but not in our control and slower.

### Option 3 — pin/patch the merchant side

Not ours to fix; and it'll recur with the next merchant that adds Solana.

**Recommendation: ship Option 1 now, also file Option 2 upstream.** Option 1 is a
~30-line, well-isolated change on a path we already own, fully covered by the
existing zero-cost repro + a real-money charge verification.

## Verification plan

1. Zero-cost: `scripts/e2e/repro-stableemail.mjs` must stop throwing
   `InvalidJsonHeaderError` for stableemail after the fix (it should reach the
   broadcast/funds step and fail there with a zero-balance key — proving decode
   succeeded).
2. Real-money: `node scripts/e2e/charge-e2e.mjs` including a stableemail target
   → expect PASS (HTTP 200, real email sent) with on-chain settlement.
3. Regression: exa/firecrawl/parallel (existing charge PASS set) still PASS.
