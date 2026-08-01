# x402 on Stellar — the `exact` scheme (v0.1)

x402 v2 is an HTTP-native payment protocol built around the `402 Payment
Required` status code. This document specifies how the MPP Router implements
it on **Stellar mainnet** (`stellar:pubnet`) with **USDC via its Stellar
Asset Contract (SAC)**.

## 1. Capability discovery

`GET /x402/supported` returns the payment kinds the router accepts:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:pubnet",
      "extra": {
        "pay_to": "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
        "asset": "USDC",
        "facilitator": "self",
        "fees_sponsored": true
      }
    }
  ],
  "extensions": [],
  "signers": {
    "stellar:pubnet": [
      "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB"
    ]
  }
}
```

- `facilitator: "self"` — the router settles payments itself; there is no
  third-party facilitator.
- `fees_sponsored: true` — the payer does not need XLM for transaction fees;
  the router sponsors them (`areFeesSponsored` in per-quote offers).

## 2. The 402 challenge

An unauthenticated request to a payable route returns HTTP 402 with **two
headers carrying the same quote** (see [`mpp-session.md`](./mpp-session.md)
for the `WWW-Authenticate` dialect):

```
HTTP/2 402
www-authenticate: Payment id="…", realm="apiserver.mpprouter.dev",
  method="stellar", intent="charge", request="<base64url JSON>",
  expires="…", opaque="…"
payment-required: <base64url JSON>
```

The `Payment-Required` value decodes to:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "stellar:pubnet",
      "amount": "20000",
      "asset": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      "payTo": "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
      "maxTimeoutSeconds": 300,
      "extra": { "areFeesSponsored": true }
    }
  ]
}
```

Normative field semantics:

| Field | Semantics |
| --- | --- |
| `amount` | **Stellar base units, 7 decimals.** `"20000"` = 0.0020000 USDC = $0.002. Both dialects use the same unit |
| `asset` | The USDC SAC contract id on pubnet: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `payTo` | The router's Stellar receiving account (same value as `signers` in discovery) |
| `maxTimeoutSeconds` | Quote validity window; also mirrored as `expires` on the MPP header |

**Parity rule (normative):** the MPP and x402 dialects of one 402 carry the
same `amount`, `asset`/`currency`, and `payTo`/`recipient`. A client may
implement either dialect and observe identical economics.

## 3. Paying — credential headers

After satisfying the challenge (signing a SAC `transfer` of exactly `amount`
base units to `payTo`), the client retries the same request with **one** of
two accepted headers:

1. `Authorization: Payment <base64>` — the mppx / pre-x402 Stellar
   convention.
2. `Payment-Signature: <base64>` — the x402 v2 header
   (`encodePaymentSignatureHeader()` in `@x402/core`); no `Payment ` prefix.

The router normalizes format 2 into format 1 internally; both hit a single
verification path. Verification checks the challenge id, amount, asset and
recipient echo before any upstream spend happens.

**Funding boundary (normative):** only Stellar credentials issued against the
router's own challenge cause the router to spend from its upstream settlement
pool. Bearer/Basic/EVM-x402/other credentials are forwarded to the merchant
as-is; the router takes no economic part in those calls.

## 4. Response semantics

| Status | Meaning |
| --- | --- |
| `200` | Payment settled and upstream returned a result. Body is `{ "success": true, "data": <upstream body> }` |
| `202` | Payment settled; upstream started an async job. Poll per the job contract in the response |
| `400` | Request invalid — **issued before any 402/payment**, agent is never charged for it |
| `402` | No/invalid credential — dual-dialect challenge as above |
| `403` | `Route not enabled for payment` — route exists but is outside payable discovery |
| `502` | Payment leg or upstream failed after intake — body carries `{ "error": "Merchant payment failed", "status": <upstream status>, "detail": <upstream body> }` |

## 5. Amount precision

Stellar USDC has 7 decimals. Upstream merchant quotes may use different
decimals (e.g. 6); the router converts and **never silently truncates** — a
quote whose precision exceeds 7 decimals is refused rather than rounded
against the agent.
