# Pay-per-call APIs in a Vercel AI SDK agent

Give a Vercel AI SDK agent a wallet and it can buy the data it needs, one call
at a time — no API keys per vendor, no accounts, no invoices. This guide builds
that from zero: two tools, one Stellar wallet, a hard spending ceiling.

Runnable code for every snippet below: [`examples/vercel-ai-sdk/`](../../examples/vercel-ai-sdk/).

> This is the second supported agent framework. The first is the
> [OpenClaw / Claude Code skill](https://github.com/mpprouter/stellar-agent-wallet-skill).
> Both speak the same wire protocol and can share one wallet.

---

## What you are building

```
agent                     MPP Router                 upstream API
  │  GET /services  ─────────▶ catalog (free)
  │  POST /v1/services/... ──▶ 402 + payment challenge
  │  sign USDC transfer
  │  retry + Payment-Signature ▶ verify, settle ──────▶ real call
  │  ◀──────────────────────── result
```

Two tools is all the model sees:

| tool | cost | what it does |
| --- | --- | --- |
| `mppDiscover` | free | keyword-search 670+ catalog entries, returns URL, method, price |
| `mppCall` | the endpoint's price | plain call → 402 → sign → retry → result |

The wallet secret never appears in a tool argument, so the model can neither
read it nor choose a different one.

---

## 1. Install

```bash
mkdir mpp-agent && cd mpp-agent && npm init -y
npm pkg set type=module
npm i ai @ai-sdk/openai zod @stellar/stellar-sdk
npm i -D tsx typescript @types/node
```

Versions this guide was verified against: `ai@5`, `@stellar/stellar-sdk@16`,
Node 20+.

## 2. Fund a wallet

The agent pays in Stellar USDC. Its account needs:

- a **USDC trustline** (asset `USDC`, issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`)
- a small **USDC balance** — $1 buys hundreds of calls
- **~1.5 XLM** for the account reserve

Transaction fees are sponsored by the Router, so XLM is never spent per call.

Put the secret in a git-ignored `.env`:

```bash
# .env  — never commit this
STELLAR_SECRET=S...
OPENAI_API_KEY=sk-...
```

**Secrets rule for the rest of this guide:** the key is read from
`process.env` at tool-construction time and closed over. It is never a tool
parameter, never logged, never sent anywhere except into a local signature.

## 3. The payment core

One file, no framework imports —
[`src/mpp-x402.ts`](../../examples/vercel-ai-sdk/src/mpp-x402.ts). It exports
three functions.

### `discoverServices()` — free

```ts
const services = await discoverServices({
  query: "scrape web page markdown",
  maxPriceUsd: 0.005,
  limit: 3,
});
// [{ public_path: "/v1/services/firecrawl/scrape", method: "POST", price: "$0.002/request" }, ...]
```

`GET /services` is public and unauthenticated. The `method` field is
authoritative — **most services are POST-only, so never default to GET.**

### `parse402()` — free

A gated endpoint answers `402` with the challenge in the `Payment-Required`
response header, base64 JSON:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "stellar:pubnet",
    "amount": "20000",
    "asset": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    "payTo": "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
    "maxTimeoutSeconds": 300,
    "extra": { "areFeesSponsored": true }
  }]
}
```

`amount` is in base units and **Stellar USDC has 7 decimals**, so `20000` is
$0.002 — not $0.02. `areFeesSponsored: true` is what lets the agent sign
without holding gas.

> The Router emits a second challenge for the same charge in the
> `WWW-Authenticate: Payment ...` header (the MPP dialect). Pick one dialect
> and pay strictly from it — the challenge id is bound to the whole challenge,
> so a credential assembled from both is rejected. This guide uses x402
> throughout because it needs no dependency beyond the Stellar SDK.

### `payAndCall()` — spends money

```ts
const result = await payAndCall({
  url: "https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape",
  method: "POST",
  body: { url: "https://stellar.org", formats: ["markdown"] },
  stellarSecret: process.env.STELLAR_SECRET!,
  maxPriceUsd: 0.005,        // refuse anything dearer
  expectPayTo: ROUTER_POOL,  // refuse a different recipient
});
```

Inside, five steps:

1. plain request → expect `402`
2. decode the challenge, pick the `exact` + `stellar:` requirement
3. **guards**: refuse if the `asset` is not the pinned USDC contract, if the
   price is above your ceiling, or if `payTo` drifts. Check the asset *first* —
   every number after it, the USD ceiling included, assumes USDC's 7 decimals,
   so an unpinned asset makes the price check meaningless.
4. sign a Soroban SAC `transfer(from, to, amount)` in sponsored mode — a
   zero-address source account and only the auth entries signed, so the
   Router's facilitator can fee-bump and submit it
5. retry the identical request with a base64 `Payment-Signature` header

Three details that will cost you an afternoon if you get them wrong:

- **The header is `Payment-Signature`** (x402 v2), or the legacy
  `Authorization: Payment <base64>`. The Router does **not** read `X-Payment`;
  send that and you get a second `402` that looks exactly like a rejected
  payment.
- **x402 v2 requires echoing `accepted`** — the exact requirement object from
  the challenge, compared field by field. Don't rebuild it.
- **Ledger validity: round the window up, not down.** Ask for
  `ceil(maxTimeoutSeconds / 6)` ledgers. Mainnet closes in ~5.5s, and a
  verifier rejects an auth entry that reaches further than its own limit, so
  assuming a *slower* ledger is the safe direction.

The credential is single-use and bound to this amount and recipient. If the
retry fails, do not replay it — start over from a fresh 402.

**A failed call is not a free call.** Settlement is independent of the upstream
HTTP status: the transfer can settle and *then* the upstream API returns a 5xx.
`payAndCall` reads the Router's `X-Payment-Settle-Status` header and counts
anything that is not an outright non-settlement as spent, so a caller is never
told a paid call was free. Inferring "no charge" from a non-2xx status is how
you pay twice for the same request.

## 4. Wrap it as two AI SDK tools

[`src/tools.ts`](../../examples/vercel-ai-sdk/src/tools.ts) in full is under 100
lines; the shape is:

```ts
import { tool } from "ai";
import { z } from "zod";

export function createMppTools({
  maxPriceUsd = 0.005,
  budgetUsd = 0.025,
  expectPayTo,
} = {}) {
  let spentUsd = 0; // closure — no tool argument can reset it

  const mppDiscover = tool({
    description:
      "Search the MPP Router catalog of pay-per-call APIs. Free. Always call " +
      "this before mppCall so you use the correct path and method.",
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(10).default(3),
    }),
    execute: async ({ query, limit }) =>
      (await discoverServices({ query, limit, maxPriceUsd })).map((s) => ({
        id: s.id,
        description: s.description,
        url: `${ROUTER_BASE_URL}${s.public_path}`,
        method: s.method,
        price: s.price,
      })),
  });

  const mppCall = tool({
    description: `Call a paid endpoint. SPENDS real USDC (max $${maxPriceUsd}/call).`,
    inputSchema: z.object({
      url: z.string().url(),
      method: z.enum(["GET", "POST"]).default("POST"),
      body: z.record(z.string(), z.unknown()).optional(),
    }),
    execute: async ({ url, method, body }) => {
      // Same-ORIGIN, not startsWith — see the note below.
      if (!isSameOrigin(url, ROUTER_BASE_URL)) {
        throw new Error(`Refusing to pay a non-Router URL: ${url}`);
      }
      // Reserve before calling, so parallel tool calls can't each see an
      // unspent budget.
      if (spentUsd + maxPriceUsd > budgetUsd) {
        throw new Error(`Budget exhausted: $${spentUsd} of $${budgetUsd}`);
      }
      spentUsd += maxPriceUsd;

      const r = await payAndCall({
        url, method, body,
        stellarSecret: requireSecret(),  // read from env, never a tool arg
        maxPriceUsd, expectPayTo,
      });
      spentUsd += r.paidUsd - maxPriceUsd; // settle the reservation
      return { paidUsd: r.paidUsd, data: r.data };
    },
  });

  return { mppDiscover, mppCall };
}
```

Note what is **not** in `inputSchema`: no secret, no price, no recipient, no
budget. Every spending limit lives in code the model cannot reach. A prompt can
be talked around; a `throw` cannot.

Two of those guards are easy to get subtly wrong:

- **`startsWith` is not an origin check.** The URL comes from the model, and
  `https://apiserver.mpprouter.dev.attacker.example/v1/...` passes a prefix
  test while pointing at an attacker's 402 server — which then receives a
  wallet-signed transfer. Parse both URLs and compare protocol and host:

  ```ts
  function isSameOrigin(candidate: string, base: string): boolean {
    try {
      const a = new URL(candidate), b = new URL(base);
      return a.protocol === b.protocol && a.host === b.host
        && a.pathname.startsWith("/v1/");
    } catch { return false; }
  }
  ```

- **Reserve the budget before the call, not after.** A single model step can
  emit several `mppCall`s in parallel; if each only debits on completion, they
  all see an unspent budget and all go through.

## 5. Run the agent

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";

const { text, steps } = await generateText({
  model: openai("gpt-4o-mini"),
  tools: createMppTools({ maxPriceUsd: 0.005, budgetUsd: 0.025 }),
  stopWhen: stepCountIs(6),
  system:
    "You buy data from paid APIs on behalf of the user. Always call " +
    "mppDiscover first to find an endpoint and its exact HTTP method, then " +
    "call mppCall once. Never guess a URL.",
  prompt:
    "Scrape https://stellar.org and tell me in two sentences what Stellar " +
    "says it is for.",
});
```

`stopWhen` caps model **steps**, and it is worth setting — but do not mistake
it for a spending limit. One step can emit several tool calls in parallel, so
step count does not bound paid calls. The real ceiling is `budgetUsd`, enforced
inside `mppCall` itself: `maxPriceUsd` bounds any single call, `budgetUsd`
bounds the run.

## 6. Verify it, cheaply

Two demos ship with the example. Run the free one first — it costs nothing and
proves discovery and 402 parsing before you risk a cent.

```bash
cd examples/vercel-ai-sdk && npm install
npm run demo:free
```

Expected output (verified 2026-08-18 against production):

```
Router: https://apiserver.mpprouter.dev

1. Discover  (free)  — services under $0.005/request
   $0.002/request   POST  /v1/services/firecrawl/scrape
   $0.001/request   POST  /v1/services/stabletravel/flightaware_flights_id_intents
   $0.002/request   POST  /v1/services/firecrawl/map

2. Challenge (free)  — unpaid POST /v1/services/firecrawl/scrape
   HTTP 402
   x402Version   2
   scheme        exact on stellar:pubnet
   amount        20000 base units = $0.002
   payTo         GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB
   sponsored     true

OK — discovery and 402 parsing verified. $0.00 spent.
```

That `payTo` is the Router pool, and you can confirm it independently at
`GET /health` before you ever sign anything.

Then the paid path — the tools called directly, no model, no LLM key:

```bash
STELLAR_SECRET=S... npm run demo:paid
```

```
Calling firecrawl_scrape at $0.002/request
Paid $0.002 USDC
Result: {"success":true,"data":{"markdown":"Learn Stellar\n\n- [Intro to Stellar](...
```

Check the ledger afterwards; the wallet balance should be exactly $0.002
lower, with **XLM unchanged** — that is sponsored fees working.

```bash
curl -s https://horizon.stellar.org/accounts/<G...> | jq '.balances'
```

Finally the whole thing, model included:

```bash
OPENAI_API_KEY=sk-... STELLAR_SECRET=S... npm run demo:agent
```

## Production checklist

- [ ] `maxPriceUsd` **and** `budgetUsd` set on the tool, not suggested in the prompt
- [ ] budget reserved before the call, so parallel calls cannot race past it
- [ ] the challenge `asset` pinned to the USDC contract, checked before the price
- [ ] `expectPayTo` pinned to the address from `GET /health`
- [ ] `mppCall` compares URL **origin**, not a string prefix
- [ ] a settled-but-failed call reported as paid, never as free
- [ ] wallet holds only a working float — it is a hot key, treat it like petty cash
- [ ] `STELLAR_SECRET` from the environment or a secret manager; `.env` git-ignored
- [ ] failed retries start from a fresh 402, never a replayed credential

## Troubleshooting

| symptom | cause |
| --- | --- |
| second `402` after paying | credential in `X-Payment`; use `Payment-Signature` |
| `402`, x402Version 2 | `accepted` missing or rebuilt instead of echoed |
| `expiration_too_far` | ledger window rounded down; use `ceil(timeout / 6)` |
| `405` with `allowed_methods` | defaulted to GET; use the catalog's `method` |
| `Simulation failed` | no USDC trustline, or balance below the charge |
| `challenge asset is not the pinned asset` | the 402 named a token other than USDC — do not relax the pin, investigate |
| `Budget exhausted` | `budgetUsd` reached; raise it deliberately in code |
| empty/garbage result at a valid price | wrong request body — read the service's `docs.llms_txt` first |

## See also

- Catalog UI — <https://www.mpprouter.dev/services>
- `GET /health` — live Router pool, gas sponsor, receipt signer
- `GET /v1/ledger` — public read-only settlement ledger
- [OpenClaw skill](https://github.com/mpprouter/stellar-agent-wallet-skill) — the
  same protocol as a Claude Code / OpenClaw plugin
