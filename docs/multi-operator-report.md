# MPP Router — open, multi-operator: provider onboarding and direct settlement

MPP Router by ROZO · Stellar mainnet · last updated 2026-09-14

## 1. The claim

MPP Router is not a single-operator gateway. Independent providers run their own servers, list themselves without anyone at ROZO approving, and get paid on their own keys. This document is the evidence: who is live, how they got there, and what each proof does and does not show.

## 2. Operators live today

Two independent operators serve paid calls through MPP Router with payment settling to their own Stellar keys, both onboarded through the self-serve flow with no ROZO approval step. A third, Mercury Data, is a provider-authorised managed integration:

| Operator | Shape | Verified by a real paid call | Settlement |
| --- | --- | --- | --- |
| **Agent402** (agent402.tools) | Runs its own x402 endpoints; the router relays the buyer's request and payment credential unchanged | 2026-09-12 · tx [`cb81cc75…838e`](https://stellar.expert/explorer/public/tx/cb81cc75af8ad64925d0a594efa17483d25aef26f01e12e82b12f3d6ed98838e) | Buyer → Agent402's Stellar address, directly |
| **Stellar Indexer** by Creit Tech (stellarindexer.com) | Runs its own authenticated API; MPP Router hosts the x402 paywall in front of it | 2026-09-14 · tx [`e577302e…28de`](https://stellar.expert/explorer/public/tx/e577302ef37e8edeb0ed5af40f679bce6b02198a238f584d2e21f9278ef728de) | Buyer → Creit Tech's Stellar address, directly; the router settles only after the origin answered 2xx |
| **Mercury Data** by xycloo Labs (mercurydata.app) | Runs its own indexer; MPP Router fronts it with a router-held credential at `/v1/services/mercury` (three routes, $0.001/call), by agreement with the operator | Charge-verified 2026-08-11 (see [verified-services.md](verified-services.md)) | Buyer → router pool, settled to Mercury by agreement; moving to direct settlement once Mercury supplies a payout address |

In both transactions the USDC transfer goes from the router's verification wallet to the operator's own address; no ROZO account is in the path. Each operator's public verification record shows the checks, the proof type and its exact meaning, and the settlement transaction:

- https://www.mpprouter.dev/providers/agent402-tools
- https://www.mpprouter.dev/providers/stellar-indexer

## 3. Evidence

### 3.1 Independent providers run their own servers and are paid on their own keys

- **Agent402** operates `agent402.tools` (578 x402 endpoints, its own Stellar facilitator). Five routes are listed with the operator's written permission (2026-09-05); `GET /api/stablecoin-peg` went through the paid gate on 2026-09-12. The router paid $0.003 USDC through Agent402's own 402 and the transfer landed on Agent402's advertised `payTo`. The router does not proxy these calls, hold funds, or take a fee.
- **Stellar Indexer** operates `api.stellarindexer.com` (Bearer-token API, no payment layer of its own). Creit Tech supplied a payout address and the per-call prices from its own price list ($0.004/call for Classic Data and Contracts' Data). The router serves `https://stellar-indexer-pay.mpprouter.dev/<path>`: unpaid requests get an x402 402 naming Creit Tech's address; paid requests are forwarded to the origin with the stored credential and settled only after the origin answers 2xx. The verification call paid $0.004 USDC to Creit Tech's address on 2026-09-14.

Catalog effect: `GET https://apiserver.mpprouter.dev/services` now carries routes with `settlement: direct` and an `operator` object naming a non-ROZO operator (`settlement_mode: relay` for Agent402, `router_paywall` for Stellar Indexer).

### 3.2 Self-serve onboarding, no manual approval

Flow (all public endpoints, no ROZO human in the path):

1. `POST /v1/providers/check` — free: reachability, 402 discovery, dialect (MPP or x402), advertised networks and payouts.
2. `POST /v1/providers/register` — one of three ownership proofs, chosen by the provider: `x402_pay_to` (the live 402 advertises the registered address), `well_known` (a token published under the provider's origin), or `wallet_signature`. A router-hosted registration uses `hosted_origin_auth` (the origin accepts the supplied credential). The public record states in words what each proof does and does not prove.
3. `POST /v1/providers/verify` — free 402 probe, then one bounded real payment (≤ $0.02, from the router's verification wallet, to the provider's registered address), then automatic `published`. Failures return a machine-readable `code`, an `action`, and `can_safely_retry` (the router never pays twice for one registration version; a frozen attempt is reconciled from the ledger, not re-paid).
4. `GET /v1/providers/:id/verification` — the durable public record.

Both listings above were produced by exactly this path. Portal: https://www.mpprouter.dev/onboard/x402 (providers with a 402) and https://www.mpprouter.dev/onboard/start (providers without a payment layer — the hosted paywall).

### 3.3 Provider-onboarding tooling

- Self-serve registration, verification and public records: `mpprouter/rozo-mpprouter` PR #135, #149, #150.
- Router-hosted paywall for APIs without a payment layer (credential stored encrypted under a Worker secret, never returned): PR #151, #152.
- Provider dashboard (token-gated): `/providers/:id/dashboard`; public provider pages and the `/services` listing: `mpprouter/mpprouter-landingpage` PR #44, #46, #47, #48–#52.
- Machine discovery: `/.well-known/x402` and `/llms.txt` carry third-party routes with per-route `payTo`.

### 3.4 Service-quality routing

- Per-route metrics (provider success rate, p50 latency, refund rate, caller-error vs router-fault attribution) are recorded at the proxy chokepoint every paid call passes through and published at `GET /v1/stats` and https://www.mpprouter.dev/stats.
- Selection: `GET /v1/services/select?capability=<id>` chooses among published routes that declare the same capability contract (`GET /v1/services/capabilities`), ordered deterministically — healthy providers with ≥ 5 fresh samples by success rate, then p50 latency, then price; providers without enough samples by price; degraded last; `offline` excluded. The response names the selected provider's `public_path` and `pay_to` before any quote, and `&provider=<id>` pins a provider (never silently replaced). Policy and thresholds are returned with every response.
- Honest status: at report time no published third-party route declares a capability id, so the endpoint answers `no_eligible_provider` with the policy; the ordering is covered by the test suite (`tests/provider-t3-loop.test.ts`). It engages as soon as two operators declare the same contract.

### 3.5 Independent security review

HackenProof audit report: https://github.com/mpprouter/rozo-mpprouter/releases/download/v0.2.1-tranche2/HackenProof.Audit.Report.for.MPP.Router.ROZO.pdf (attached to the `v0.2.1` release).

## 4. What is and is not claimed

- Both self-serve verification payments were technical validation spend by ROZO ($0.003 and $0.004), not organic buyer demand.
- Mercury Data is a managed integration, not an independent operator in the sense of §3.1: the router holds the credential and the pool receives the payment. It is listed because it is a real third-party service with a real agreement, and because it is the next candidate for direct settlement.
- `x402_pay_to` and `hosted_origin_auth` prove that the endpoint's payment configuration matches the registered address (and, for hosted, that the registrant can authenticate to the origin). Neither proves private-key custody; the public records say so verbatim.
- The hosted-paywall shape keeps the paywall on ROZO infrastructure; the operator's API and key stay theirs and settlement is still direct. Agent402 is the fully self-operated sample; Stellar Indexer is the hosted sample.
- Operator addresses are not reproduced in this report; they are visible in the linked verification records and on-chain.

## 5. Where to look

| | |
| --- | --- |
| Live catalog | https://apiserver.mpprouter.dev/services |
| Service directory | https://www.mpprouter.dev/services |
| Provider records | https://www.mpprouter.dev/providers/agent402-tools · https://www.mpprouter.dev/providers/stellar-indexer |
| Metrics | https://www.mpprouter.dev/stats · https://apiserver.mpprouter.dev/v1/stats |
| Onboarding | https://www.mpprouter.dev/onboard/x402 · https://www.mpprouter.dev/onboard/start |
| Spec releases | https://github.com/mpprouter/rozo-mpprouter/releases |
| Audit | HackenProof report on the `v0.2.1` release |
