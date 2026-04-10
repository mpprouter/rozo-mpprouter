# MPP Router engineering notes

Running log of non-obvious footguns and operational gotchas. Read this
before touching payment math, adding a new upstream chain, or onboarding
a merchant on a new token.

## Decimals: the 1,000,000x overcharge bug (2026-04-10)

### What happened

`POST /v1/services/parallel/search` returned a 402 challenge demanding
**10,000 USDC** when the catalog price was **$0.01**. All four
paid services in the catalog were overcharging by exactly 10^6. A single
agent calling `PAY=1` would have drained its wallet in one request.

### Root cause

Two libraries with the same field name (`amount`) but **opposite unit
conventions** met in src/routes/proxy.ts without a conversion step.

- **Tempo side (upstream merchant).** `mppx`'s `tempo.charge` runs a zod
  transform before serializing the 402 challenge: it takes the operator's
  human-readable `{ amount: "0.01", decimals: 6 }` and emits wire format
  `{ amount: "10000" }` (base units), dropping `decimals` entirely. See
  `node_modules/mppx/dist/tempo/Methods.js:44-46`. TIP-20 stablecoins on
  Tempo are all 6 decimals (pathUSD, USDC); `mppx` treats this as a
  constant — `node_modules/mppx/dist/tempo/internal/defaults.js:24` exports
  `decimals = 6` with a comment that there is no risk of mismatch.

- **Stellar side (agent-facing charge).** `@stellar/mpp`'s `charge` method
  expects `amount` as a **human-readable decimal string** and applies its
  own `toBaseUnits(amount, 7)` internally. `toBaseUnits('0.01', 7)` →
  `'100000'` stroops. See `node_modules/@stellar/mpp/dist/shared/units.js:10`.

The Router was taking the Tempo wire-format integer (`"10000"`) and
passing it straight into the Stellar charge method, which re-interpreted
it as decimal dollars (`$10,000.00`) and then multiplied by `10^7`. The
final charge emitted to the agent: `100,000,000,000,000` stroops =
**10,000 USDC**. Ratio 10^6, precisely matching the TIP-20 decimal count
the transform layer silently swallowed.

### The fix

src/routes/proxy.ts now:

1. Defines `baseUnitsToDecimalString(amount, decimals)` — a pure BigInt
   helper that converts `"10000", 6 → "0.01"`.
2. Defaults `merchantDecimals` to `TEMPO_DEFAULT_DECIMALS = 6` because
   Tempo merchants don't include `decimals` in the 402 wire format. An
   explicit `parsed.request.decimals` from the challenge wins if present
   (future-proofing for non-TIP-20 tokens).
3. Refuses (`502`) any merchant whose decimals exceed `STELLAR_USDC_DECIMALS = 7`.
   This catches silent truncation rather than letting a high-precision
   token round down to zero on the Stellar side.
4. Feeds the converted decimal string into `mppx['stellar/charge']`.

Regression coverage: tests/units.test.ts (13 cases around
`baseUnitsToDecimalString`) and tests/proxy.test.ts (the mock 402 builder
now matches real Tempo wire format — no `decimals` field, base-unit
`amount` — so the whole integration path exercises the conversion).

### Why the old tests didn't catch it

The original `makeTempoChallengeResponse('0.01')` mock passed `"0.01"` as
the amount, which is the Stellar format, not Tempo's. The test suite and
the bug were rooted in the same misunderstanding, so they covered for
each other: the Router forwarded `"0.01"`, Stellar parsed it correctly,
tests passed, nothing ever touched real Tempo wire format. The lesson:
**mocks for external payment challenges must mirror the real wire
format exactly, down to the field names and units.** Never fabricate
schemas from memory.

## Adding a new upstream chain (Binance / BNB / anything non-Tempo)

Before merging a PR that routes to a new chain, verify:

1. **What are the stablecoin decimals on that chain?**
   - Tempo TIP-20 USDC: 6
   - Stellar USDC (SAC): 7
   - Ethereum/Base USDC: 6
   - BNB Chain BEP-20 USDC: **18**
   - BNB Chain BEP-20 USDT: **18**
   - Most other ERC-20 stablecoins on BNB Chain: 18
   - Native BNB: 18

   **BNB Chain is the dangerous one.** If the Router ever proxies to a
   BEP-20 USDT/USDC merchant, the merchant will emit `amount` in 18
   decimals. Stellar USDC only has 7. The Router's current code will
   return 502 (`Merchant token precision exceeds Stellar USDC`) — good,
   not silent — but that also means **the route will never work**. You
   must either:
   - Quantize the charge upward to the nearest representable Stellar
     unit (lose < 10 picoUSD per request — acceptable for paid API
     calls), or
   - Introduce a separate Router pool that settles agents in a higher-
     precision currency.

2. **Does the charge library for that chain emit base units or decimals
   on the wire?** `mppx/dist/tempo/Methods.js` transforms *outbound*.
   A different chain's charge method might emit `{ amount, decimals }`
   literally, in which case the `parsed.request.decimals` explicit
   override path in proxy.ts will engage automatically. Trace it through
   the transform layer to be sure; do not assume symmetry.

3. **Write a regression test that mirrors that chain's wire format
   exactly**, using a value taken from a real 402 capture, not one
   reconstructed from a schema file. File it next to units.test.ts.

4. **Add the chain's decimals to this notes file**, next to the list
   above, so the next engineer doesn't have to rediscover it.

### Binance-specific checklist

If you wire up a merchant that charges in BEP-20 on BNB Chain:

- [ ] Capture a real 402 from the merchant before writing any router
      code. Save the raw `WWW-Authenticate` header to the PR description.
- [ ] Base64-decode the `request` field. Confirm `amount` is in base
      units (integer) and note whether `decimals` is present or
      transformed away.
- [ ] Add a test case: `baseUnitsToDecimalString('10000000000000000', 18) === '0.01'`
      (16 zeros for $0.01 at 18 decimals).
- [ ] Decide the Stellar-side precision policy (quantize up, reject, or
      add a separate settlement pool) **before** adding the route to the
      merchant catalog. Document the decision here.
- [ ] Add an integration test mirroring the real wire format at
      tests/proxy.test.ts — the existing `makeTempoChallengeResponse`
      builder is Tempo-specific; make a new `makeBnbChallengeResponse`
      rather than overloading it.
- [ ] Manually verify the end-to-end dry run (catalog price vs. actual
      402 amount) against a dev merchant before flipping the catalog
      live.

## The classifyAuth passthrough bug (2026-04-10)

### What happened

A client team reported they were getting errors like `"Challenge was
not issued by this server"` after signing Soroban auth entries (an
~11 second process). They hypothesized that Cloudflare Workers was
recycling isolates between the 402 and the retry, losing the
in-memory challenge id. That theory was wrong on two counts:

1. mppx's challenge system is **completely stateless** — challenge
   ids are HMAC-bound (see `node_modules/mppx/dist/Challenge.js`
   → `computeId`), so the Router does not store them anywhere.
   Isolate recycling cannot affect HMAC verification.
2. The Router never actually ran HMAC verification for the failing
   requests in the first place.

The real bug was in `classifyAuth()` at src/routes/proxy.ts. It
decided whether a request was carrying a Stellar credential by doing:

```ts
const methodMatch = trimmed.match(/method="([^"]+)"/i)
```

That regex assumes the `Authorization` header uses RFC 9110
auth-params format (`Payment id="...", method="stellar", intent=...`).
**But that is the `WWW-Authenticate` serialization, not
`Authorization`.** Real mppx Credentials are serialized as a single
base64url-encoded JSON blob prefixed with `Payment `:

```
Payment eyJjaGFsbGVuZ2UiOnsiaWQiOiIuLi4i...
```

The regex never matched any real credential, so `classifyAuth`
returned `'passthrough'` for every Stellar payment that ever hit
the live Router. The entire payment path — signature verification,
replay protection, Tempo pool accounting — was dead code for
production traffic. Requests were forwarded directly to the
upstream merchant with the agent's Stellar credential in the
Authorization header, which the merchant did not understand and
returned a 500 for (`Invalid payTo address: not found in server
cache` in the observed case).

### How it got past tests

tests/proxy.test.ts had two tests for "non-Stellar passthrough" and
one for "forged Stellar credential", all three of which hand-rolled
the Authorization header using the wrong (auth-params) format:

```ts
Authorization: 'Payment id="attacker", method="stellar", ...'
```

So the tests were validating behavior against a wire format that no
real client could ever send. The fake-format "Stellar" headers were
caught by the old regex, the fake-format "non-Stellar" headers were
not, and the tests happily passed. A real `Credential.serialize()`
output — the only format that actually exists on the wire — was
never tested. **Always build test fixtures with the same helpers the
real client uses** (`Credential.serialize`, `Challenge.serialize`,
etc.) so the test exercises the real parser, not a reimplementation.

### The fix

src/routes/proxy.ts now uses `Credential.deserialize()` from mppx to
classify the header. If it parses, the embedded `challenge.method`
decides the path; if it doesn't parse (any non-mppx `Payment ...`
scheme), it goes to passthrough. The regression tests in
tests/proxy.test.ts now build credentials with `Credential.serialize`
so they exercise the real wire format.

### Rule going forward

**Any test fixture representing an `Authorization` header MUST be
built with `Credential.serialize()`.** Hand-rolled strings are
forbidden — they reimplement the wire format, and drift between the
reimplementation and the real library is how this bug slipped past
for a full release cycle.

## `OPTIMISTIC_THRESHOLD` is declared but unused (2026-04-10)

`wrangler.toml` and `src/index.ts` both declare `OPTIMISTIC_THRESHOLD`
(default `"0.05"`), and a comment in proxy.ts refers to "on-chain
simulation for amounts above OPTIMISTIC_THRESHOLD". **No code path
actually reads this env var.** It was planned as an optimization: for
charges below $0.05, skip the Soroban simulation step so the Router
replies to the agent in a few hundred ms instead of waiting 10+
seconds for a mainnet RPC round-trip. The implementation was never
written.

Implications:

- **Don't rely on it.** Every charge currently runs full Soroban
  simulation regardless of amount. The "optimistic" 11-second window
  in the client report is real, but it is the agent's own simulation
  time, not the Router's verification time.
- **Don't delete it yet.** We probably want the optimization — low-
  value API calls ($0.002-$0.01) dominate traffic, and RPC latency
  is the user-visible cost here. Wire it up via the `store` parameter
  to `@stellar/mpp/charge/server` + a conditional skip of on-chain
  simulate for amounts below the threshold. See
  `node_modules/@stellar/mpp/dist/charge/server/Charge.js` line ~44
  for the call site.
- **If you do wire it up**, add a test that simulates a sub-threshold
  charge and asserts the Router did NOT make a Soroban RPC call
  (spy on `rpc.Server`). And remove the UNUSED comment in
  `src/index.ts` and `wrangler.toml`.
- **If you decide not to pursue it**, delete the env var from both
  files and the reference in proxy.ts's header comment so future
  engineers don't waste time looking for the optimization.

Until one of those two paths is taken, the env var stays as-is with
a prominent "UNUSED" comment to stop anyone from assuming the
optimization is active.

## Wire-format invariants the Router must preserve

These are load-bearing assumptions in proxy.ts. Breaking any of them
reintroduces the bug class above.

1. **Tempo merchants emit `amount` in base units, without `decimals`.**
   If this ever changes, update `TEMPO_DEFAULT_DECIMALS` handling.
2. **Stellar charge expects `amount` as a decimal string**, and its
   `decimals` parameter is configured in `createStellarPayment` (default
   7). Never pass a base-unit integer to `mppx['stellar/charge']`.
3. **The conversion must use BigInt**, not `Number` / `parseFloat`.
   JavaScript doubles cannot represent `1e15` stroops exactly.
4. **Precision can only go down, never up.** If merchant decimals > 7,
   refuse — don't multiply.
