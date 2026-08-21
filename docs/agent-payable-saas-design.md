# Agent-Payable SaaS — Product Design

Status: product hypothesis for validation; pricing is not approved or live.

## Product thesis

Turn an existing API or SaaS product into an agent-payable service without requiring every buyer to create an account, store an API key, or pre-fund a proprietary balance.

The provider adds a domain/manifest and a provider-controlled Stellar receiving account. MPP Router supplies payment negotiation, agent discovery, receipts, usage entitlements, quality metrics, and distribution. An agent can then discover, pay, and invoke the service with one command.

> Add one domain. Let agents discover, pay for, and use your existing API.

This is a market-layer product, not a replacement for the provider's existing account system. Human subscriptions and API keys can continue alongside the agent payment path.

## Before and after

Traditional flow:

```text
Find website → create account → verify email → add card/prepay
→ create API key → read provider-specific docs → configure SDK → call API
```

Agent-payable flow:

```text
agent: use <provider> <task>
→ discover verified route → receive quote → approve budget and pay
→ call provider → receive result + signed receipt
```

The provider retains the product, service logic, customer relationship, infrastructure, and receiving account. ROZO standardizes discovery and payment.

## Target provider

Start with APIs whose output is verifiable and whose unit can be metered:

- webhook delivery and monitoring;
- blockchain address monitoring and data APIs;
- search, browser, and extraction APIs;
- AI inference or media-generation endpoints;
- developer infrastructure with request-, event-, or compute-based pricing.

Do not start with human SaaS whose value is primarily a fixed monthly workspace. A card subscription already serves that job. The wedge is machine usage where an agent benefits from a bounded budget, per-use receipts, and no provider-specific setup.

## Provider onboarding

The provider submits:

1. a service domain;
2. an HTTPS origin endpoint or OpenAPI document;
3. pricing and entitlement units;
4. a provider-controlled Stellar USDC receiving account;
5. a machine-readable manifest;
6. health and test inputs that contain no customer data.

Example:

```json
{
  "name": "Address Monitor",
  "provider": "ClawRouter",
  "origin": "https://api.clawrouter.com/v1/monitor-address",
  "agent_domain": "stellar.clawrouter.com",
  "pay_to": "<provider-owned Stellar account>",
  "pricing": {
    "type": "request_pack",
    "amount": "0.10",
    "asset": "USDC",
    "requests": 100
  }
}
```

Self-serve sequence:

```text
Submit manifest → prove domain and receiving-account ownership
→ validate schema and policy → run free probe
→ run one real paid conformance call → publish verified catalog entry
→ begin quality monitoring
```

Target: under 60 minutes from a clean environment, with no manual database edit or ROZO approval. Security and policy failures fail closed with actionable explanations.

## Deployment modes

### Managed CNAME

```dns
stellar.clawrouter.com CNAME stellar-gateway.mpprouter.dev
```

MPP Router terminates the payment protocol and invokes the provider's existing API. This is the fastest commercial MVP and can coexist with a Base/x402 or account-based entry point. The provider must still control its domain, origin, service logic, and receiving account, with separate provider attribution in public metrics.

### Self-hosted adapter

The provider deploys the open seller adapter in its own Cloudflare, Vercel, AWS, or other account. It controls the domain, runtime, configuration, and receiving key. MPP Router supplies the schema, buyer SDK, conformance tests, and optional indexing.

This is the stronger independence model and required proof path for an SCF non-ROZO operator. Managed CNAME alone must not be presented as evidence that the network survives without ROZO.

## Request-pack entitlement

For sub-cent APIs, do not create an on-chain payment for every request:

```text
pay USD 0.10 in Stellar USDC → receive entitlement for 100 requests
→ invoke provider → provider decrements usage
→ response exposes remaining quota and receipt reference
```

Requirements:

- entitlement contains service, purchase ID, quota, expiry, payer, and provider;
- provider enforces replay protection and usage count;
- payment without entitlement issuance triggers a full refund;
- first request failing because the provider is unavailable triggers a full refund;
- partial-use refund policy is declared before purchase;
- provider evidence is authoritative for fulfilled usage.

## Commercial packaging hypotheses

The provider pays the subscription for enablement and distribution. Buyers still pay the provider for API usage.

| Hypothesis | Candidate package | Test |
| --- | --- | --- |
| Launch | USD 9.90/month | Small API vendor willingness to pay for payment enablement and listing |
| Growth | USD 19.90/month | Value of analytics, up to 10 attributable agent identities, and distribution |
| Annual | USD 199/year | Whether an annual discount improves commitment |

Candidate included value:

- one service/domain onboarding;
- Stellar x402/MPP payment entry point;
- catalog and agent-search indexing;
- up to 10 registered agent identities for attribution;
- payment, delivery, latency, and refund analytics;
- one provider profile/use-case article after verification;
- conformance badge and reproducible paid-call evidence.

These are validation prices. Do not charge merely for placement in an empty catalog; prove incremental paid calls first.

## Agent experience

```text
use clawrouter.address-monitor for <address>
```

The agent resolves the service, checks price and quality, requests a wallet policy decision, pays, invokes the endpoint, and stores the receipt. “Supports 10 agents” means up to 10 attributable agent identities or wallet policies in the pilot—not ten brands claimed without working integrations.

The MVP proves at least two independent agent runtimes using the same manifest/OpenAPI contract. Additional runtimes must not require bespoke provider integrations.

## Catalog, Dune, and distribution

Operator identity must remain distinct from service/model identity. Index:

- paid calls and USDC volume;
- unique external payer/agent identities and repeat paid use;
- full-price versus discounted calls;
- provider/operator share;
- success rate, refund rate, and p95 latency;
- last real-money verification timestamp.

The provider article is distribution, not acceptance evidence. It includes a reproducible command, price, example output, provider-owned domain, and payment evidence. Never publish secrets, customer payloads, internal URLs, or unapproved wallet addresses.

## Discounts

Discounts may be provider-funded, ROZO-funded, or part of a separately approved ecosystem pilot. Track discounted and full-price cohorts separately. SCF #44 grant funds must not subsidize usage; an SDF buyer-credit program requires a separate proposal and approval.

## Provisional 30-day success criteria

- three providers complete onboarding;
- at least one provider uses self-hosted mode and its own receiving key;
- clean onboarding takes at most 60 minutes;
- at least two agent runtimes complete a paid call;
- at least ten external agent/wallet identities initiate a paid call;
- at least two external identities repurchase;
- every paid failure follows the published refund rule;
- zero known pay-then-fail route remains advertised as payable.

Guardrails:

- team verification never counts as customer growth;
- a provider/model label is not an independent operator;
- no proxying or resale against upstream terms;
- no private key is shared with ROZO;
- no production listing before a real paid conformance call succeeds.

## Open decisions

1. Which first provider will join the pilot?
2. Does subscription billing begin at registration, verification, or first external paid call?
3. Does “10 agents” mean identities, wallet policies, or platforms?
4. Which two agent runtimes are the initial acceptance targets?
5. Does ROZO charge a transaction fee in addition to subscription?
6. Who funds launch discounts?
7. What partial-use refund rule applies to request packs?

