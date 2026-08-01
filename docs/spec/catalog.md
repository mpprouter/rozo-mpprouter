# The machine-readable service catalog (v0.1)

`GET /v1/services/catalog` returns every proxied route with enough structure
for an agent to select, price, and pay for a call without human help.

## 1. Top level

```json
{
  "version": "…",
  "base_url": "https://apiserver.mpprouter.dev",
  "generated_at": "…",
  "supported_payment_methods": ["…"],
  "summary": { "…": "counts incl. verified" },
  "services": [ { …route objects… } ]
}
```

## 2. Route object fields

| Field | Semantics |
| --- | --- |
| `id` | Stable route id (`<service>_<operation>`), the catalog primary key |
| `name`, `category`, `categories`, `description` | Human/agent-readable metadata |
| `public_path` | The router path to call, e.g. `/v1/services/firecrawl/scrape` |
| `method` | `POST` or `GET`. GET routes pass path parameters as query parameters; required names are listed in `path_params` |
| `price` | Human-readable label — see §3 |
| `payment_method`, `network`, `asset` | Payment rail summary (`stellar`, `stellar:pubnet`, USDC SAC) |
| `status`, `status_note` | Upstream availability as last observed |
| `payment_status` | `available` \| `verified` \| `unavailable` — see §4 |
| `payment_enabled` | Boolean: whether the router will accept payment for this route |
| `payment_status_note` | Free-text caveat for agents |
| `charge_rozo_verified`, `charge_rozo_verified_at` | Real-money verification flag + timestamp for the charge intent |
| `session_rozo_verified`, `session_rozo_verified_at` | Same for the session/channel intent |
| `methods.stellar.intents` | Which intents an agent may use (`charge`, `channel`); omitted entirely when the route is not safely payable |
| `payment_hints` | Per-route quirks a paying client should know |
| `docs_url`, `docs` | Upstream API documentation |

## 3. Price labels (normative)

- Fixed-price routes: exact decimal with a 3-decimal minimum —
  `$0.002/request`, `$0.00375/request`, `$0.0001/request`. Sub-cent prices
  are never floored to `$0.000`.
- Dynamically priced routes (call-time pricing, e.g. per token): the label
  states the merchant's hint range and marks itself dynamic —
  `"$0.05-$4/request (dynamic)"` or `"dynamic"` when no range is given.
  A dynamic route is **never** labelled `free`.
- The authoritative price for any single call is the live 402 quote, not the
  label. Labels are selection aids; the 402 is the contract.

## 4. Payability and the verified contract

| `payment_status` | Meaning |
| --- | --- |
| `available` | Route is payable; not (yet) verified end-to-end by the operator |
| `verified` | A real paid call by the operator returned a valid upstream result — timestamp in `*_rozo_verified_at` |
| `unavailable` | Known-broken. Removed from payable discovery: no `stellar` intents, agents cannot pay for it |

Normative consumer rules:

1. **Verified flags are snapshots.** They assert a successful real-money call
   *at the recorded timestamp*, not current health. Agents making
   high-stakes calls should treat them as priors and handle `502` refunds by
   policy.
2. **`unavailable` is protective.** It exists so an agent can never pay for
   a call the operator knows will fail downstream (the no-pay-then-fail
   invariant). Consumers MUST NOT try to pay `unavailable` routes; the
   router answers `403 Route not enabled for payment` without taking money.
3. **Absence of `methods.stellar` = do not pay**, regardless of any other
   field.

## 5. Discovery for agents

- `GET /v1/services/search` — filtered search over the same objects.
- `GET /llms.txt` — plain-text usage contract intended for LLM agents.
- `GET /openapi.json` — OpenAPI 3.1.0 for the router's own surface.
