# The MPP payment dialect — `charge` and `channel` intents (v0.1)

MPP (Multi-Party Payments) is the `WWW-Authenticate: Payment …` dialect used
by mppx clients. The router emits it on every 402 alongside the x402
`Payment-Required` header ([`stellar-x402.md`](./stellar-x402.md)). Where
x402 `exact` covers fixed-price single calls, the MPP dialect adds the
**session/channel** shape for usage-based pricing.

## 1. Challenge format

```
WWW-Authenticate: Payment id="<challenge id>", realm="apiserver.mpprouter.dev",
  method="stellar", intent="charge", request="<base64url JSON>",
  expires="<ISO 8601>", opaque="<base64url JSON>"
```

The `request` value decodes to:

```json
{
  "amount": "20000",
  "currency": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  "recipient": "GDK3AVW3YE6UL3J4WLNKBMP65KSY32YPUKIOC6PXW65XJ3LEG3YIDXXB",
  "methodDetails": {
    "credentialTypes": ["transaction"],
    "feePayer": true,
    "network": "stellar:pubnet"
  }
}
```

- `amount` — Stellar base units (7 decimals), same unit as the x402 dialect.
- `currency` — asset contract (USDC SAC on pubnet).
- `recipient` — the router's receiving account.
- `feePayer: true` — the router sponsors the transaction fee; the agent needs
  USDC only, no XLM.
- `expires` — quote deadline; a credential presented after it is refused.
- `opaque` — router-internal echo state (e.g. the route scope); clients MUST
  return it untouched and MUST NOT interpret it.

A single 402 may carry **multiple `Payment` entries** (multiple intents
and/or multiple currencies). Clients select the offer they support — this is
MPP multi-method discovery, and offer multiplicity is normal, not an error.

## 2. Intents

| Intent | Shape | When |
| --- | --- | --- |
| `charge` | One-shot: pay `amount`, get one result | Fixed-price routes |
| `channel` | Bounded-budget session: open once with a deposit cap, then per-call vouchers settle usage against it | Usage/token-priced routes |

### 2.1 `charge`

The V1 flow: sign a SAC transfer of exactly `amount` to `recipient`, retry
with the credential (`Authorization: Payment <base64>`), receive the result.
Stateless per request.

### 2.2 `channel`

For merchants whose pricing is usage-based (per token, per compute unit), a
per-call fixed quote is impossible. The channel intent bounds the agent's
risk instead:

1. **Bootstrap.** An agent advertises channel intent on its very first
   request via query parameters: `?payment=channel&agent=G…`. The router
   answers with a channel-bound 402.
2. **Open.** The agent signs a channel open with a **deposit cap** — the
   maximum it is willing to spend in this session.
3. **Vouchers.** Each subsequent call carries a signed voucher for the new
   **cumulative** total (monotonically increasing, base-unit string). The
   router verifies `cumulative_new ≥ cumulative_stored + this_call_amount`
   and refuses vouchers that exceed the deposit cap.
4. **Settlement.** Usage settles against the deposit; the unspent remainder
   stays with the agent per the channel contract's close rules.

The catalog advertises which intents each route accepts in
`methods.stellar.intents` — see [`catalog.md`](./catalog.md). The derivation
rule (normative, from the operator's verified-mode registry):

| Upstream mode | `stellar.intents` advertised | Rationale |
| --- | --- | --- |
| upstream `charge` | `["charge", "channel"]` | Both are safe |
| upstream `session` | `["channel"]` | Charge would take payment the upstream then rejects — the pay-but-404 trap. Never advertised |
| route not verified-payable | *(block omitted)* | Agents won't attempt payment at all |

## 3. Error surface

- `503 Router session channel not installed` — the operator has not opened
  the upstream channel for this merchant; no agent payment is taken.
- `502 Merchant payment failed` with `detail` — upstream settlement or the
  upstream API call failed after intake. The `detail` field carries the
  upstream `status` and body verbatim so failures are attributable
  (router vs merchant vs upstream API).
- Challenge-echo mismatch (wrong amount/currency/recipient) — the credential
  is refused before any upstream spend.
