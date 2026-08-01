# MPP Router — Open AI-Payment Protocol on Stellar (Spec v0.1)

> Tagged as `v0.1.0-tranche1` — the SCF #44 Tranche 1 spec deliverable.
> Status: **draft / v0**. Everything documented here is live in production at
> `https://apiserver.mpprouter.dev` and was verified with real Stellar-mainnet
> paid calls. Field names and header shapes are stable within v0.1; breaking
> changes bump the minor version and get a new tag.

## What this spec covers

An agent with a Stellar wallet — and nothing else: no API key, no account,
no card — can discover a paid API service, receive a machine-readable quote,
pay in USDC on Stellar mainnet, and get the result. This directory specifies
the four contracts that make that work:

| Document | Contract |
| --- | --- |
| [`stellar-x402.md`](./stellar-x402.md) | The x402 v2 `exact` scheme on Stellar: discovery, the `Payment-Required` 402 dialect, credential headers, settlement semantics |
| [`mpp-session.md`](./mpp-session.md) | The MPP payment dialect: `WWW-Authenticate: Payment …` challenges, the `charge` (single-shot) and `channel` (bounded-budget session) intents |
| [`catalog.md`](./catalog.md) | The machine-readable service catalog: field semantics, price labels, payability, and the verified-flag contract |
| [`provider-registration.md`](./provider-registration.md) | How a provider/route enters the catalog, the operator overlay, and the real-money verification gate |

## Design invariants (normative)

These hold across all four documents:

1. **Validation before payment.** Request-body validation runs before any 402
   is issued. A malformed request gets a `400` with the field contract; an
   agent is never charged for a request the upstream cannot serve.
2. **No pay-then-fail by discovery.** A route known to be unable to settle is
   removed from payable discovery entirely (`payment_status: "unavailable"`,
   no `stellar` intents block) rather than left payable-but-broken.
3. **Dual-dialect parity.** When both the MPP (`WWW-Authenticate`) and x402
   (`Payment-Required`) dialects are emitted for the same 402, they carry the
   same amount, the same asset, and the same recipient.
4. **Verified means real-money-verified.** A `charge_rozo_verified` /
   `session_rozo_verified` flag is only set after a real paid call returned a
   valid upstream result. The flags carry timestamps and are snapshots, not
   live guarantees — consumers that need current state must probe.
5. **Stellar-credential funding boundary.** The router only spends from its
   upstream settlement pool for calls that carry a Stellar credential the
   router itself issued. Any other credential type is forwarded untouched.

## Live endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/services/catalog` | Versioned machine-readable catalog |
| `GET /v1/services/search` | Catalog search |
| `POST\|GET /v1/services/{service}/{operation}` | The paid proxy routes |
| `GET /x402/supported` | x402 capability discovery |
| `GET /health` | Router pool status |
| `GET /llms.txt` | Agent-readable usage guide |

Full OpenAPI: `https://apiserver.mpprouter.dev/openapi.json` (OpenAPI 3.1.0).

## Verification methodology

Every claim in this spec was captured from production traffic. The
verification discipline itself is documented in
[`../verified-services.md`](../verified-services.md) (the verified-mode
registry and the `stellar.intents` derivation rules) and
[`../SOP-provider-e2e-test.md`](../SOP-provider-e2e-test.md) (the real-money
E2E procedure). A zero-cost daily monitor guards regressions.
