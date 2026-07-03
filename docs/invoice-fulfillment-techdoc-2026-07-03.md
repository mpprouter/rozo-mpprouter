# Coinbase Invoice Fulfillment — Technical Reference

*Last updated: 2026-07-03. Covers the full "agent pays a Coinbase Payment Link with any stablecoin" pipeline.*

## 1. Architecture

```
Caller (agent / pay.rozo.ai UI)
   │  POST create-invoice (pl_* link)
   ▼
MPP Router worker (apiserver.mpprouter.dev)          repo: rozov2/rozo-mpprouter
   │  quote via agentapi → create Rozo intent
   ▼
Rozo Intents API (payment-api)                       repo: rozo/rozobridge/rozo-intents-api
   │  user pays in (any supported rail)
   │  payout: USDC → funder wallet 0x2352…1739 on Base
   │  ── HMAC webhook: payment_payin_completed / payment_payout_completed ──▶
   ▼
MPP Router worker webhook.ts (KV state machine)
   │  POST pay-invoice (x-admin-secret)
   ▼
agentapi.rozo.ai (thin CF Worker proxy)              repo: rozoskills/shawn-local-skills/cloudflare-worker
   ▼
Supabase fn pay-invoice (project wlfqutceffdblxbdgygs)   repo: rozoskills/shawn-local-skills
   │  ERC-3009 ReceiveWithAuthorization, funder wallet pays
   ▼
Coinbase Commerce Payments escrow 0xBdEA…0cff (Base) → merchant (e.g. OpenRouter)
```

## 2. API Reference

### 2.1 CREATE — `POST https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/create-invoice`

**Auth: none (public).** Rationale: creating an intent only opens a quote; money moves
only when the caller actually pays the returned payment link. Abuse surface = junk
unpaid intents (they expire in 1h).

Request:
```json
{
  "url": "https://payments.coinbase.com/payment-links/pl_...",   // or {"payment_id": "pl_..."}
  "source": { "chainId": "900", "tokenSymbol": "USDC" }          // optional, default Base USDC
}
```

Flow: quote the link via `quote-invoice` (admin secret) → compute discount →
**idempotency**: `GET /payments/order/wallet_rozopay/<pl_id>` on Rozo — the `pl_*` id
IS the Rozo `orderId`, so the same Coinbase link always maps to one live intent
(expired intent = miss, a fresh one is created) → `POST /payments` on Rozo with
`X-API-Key` (`ROZO_INTENTS_API_KEY`).

Response: `{ ok, reused, linkId, merchant, original, callerPays, discount, paymentLink, rozoPaymentId, expiresAt, source }`.

**Discount formula** (`computeCallerPaysAtomic`): `callerPays = max(invoice − $5, invoice × 100/105)`
— ~4.76% off small invoices, capped at $5 for large ones. All math in atomic USDC (bigint).

**Webhook config is NOT sent by this endpoint.** Rozo's payment-api attaches
`webhookUrl` + `webhookSecret` server-side from the `api_developers` registration of
`wallet_rozopay` (secret lives in Supabase Vault; `webhook_secret_source: "merchant"`).
The worker's `ROZO_WEBHOOK_SECRET` must equal that Vault secret.

### 2.2 GET — `GET https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/invoice-status?payment_id=pl_*`

**Auth: none (public read).** Also accepts `rozo_payment_id=<uuid>`. Note the param
name is `payment_id`, not `pl_id`. Returns:

```json
{
  "ok": true, "pl_id": "...", 
  "routerState": { "status": "paid|paying|payin_seen|failed_*", "paidAt", "invoiceAmountAtomic", "funderBalanceAtomic", "failureReason" },
  "coinbase":    { "status", "usageCount", "maxUsage", "settled", "merchant", "fiat" },
  "rozoPayment": { ... }
}
```
`routerState` comes from KV (`invoice-fulfillment:<pl_id>`, 7-day TTL); `coinbase` is
fetched live. This is what pay.rozo.ai polls.

### 2.3 WEBHOOK — `POST https://apiserver.mpprouter.dev/v1/services/rozo-agent-api/webhook`

Sender: rozo-intents-api (`maybeForwardMerchantWebhook`, shared/merchant-webhook.ts).
Events sent: **`payment_payin_completed`** and **`payment_payout_completed`** only
(failure states are NOT pushed — poll for those).

Payload: `{ event_id, type, timestamp, data: <Payment> }` where `data.orderId` = `pl_*`
and `event_id` = `webhooks_log.id` on the Rozo side (paste it into portal Deliveries to
find the record).

Worker reaction per event:
- `payin_completed` → **optimistic**: check funder Base-USDC balance (minus reserved
  counter); if `available ≥ invoice` → pay now; else defer and wait for payout.
- `payout_completed` → funds have landed on the funder wallet → always attempt
  (if balance still short → `failed_insufficient_balance`, see §5).

### 2.4 PAY — `agentapi.rozo.ai` → Supabase fn `pay-invoice` (+ `quote-invoice`)

Two modes:
- **Public x402 mode**: no admin header → returns a 402 challenge; caller pays
  invoice + surcharge via x402, then the function pays the link.
- **Admin mode**: `x-admin-secret` header (constant-time compare) → skips x402,
  pays directly from the funder wallet. This is the mode the MPP worker uses.

Pre-pay checks (both modes): link `usageCount < maxUsage` (else 409),
`preApprovalExpiry` not passed (else 410), token must be **USDC on Base** (else 400).

## 3. Security checks per hop

| Hop | Check |
| --- | --- |
| create-invoice | none (public; server-side-resolved tokenAddress — caller-supplied addresses are ignored with a warning) |
| invoice-status | none (public read of non-sensitive state) |
| Rozo payment-api | `X-API-Key` (developer key of `wallet_rozopay`) |
| webhook receiver | HMAC-SHA256 of `"${x-rozo-timestamp}.${rawBody}"` with `ROZO_WEBHOOK_SECRET`, constant-time compare, ±5 min timestamp window (replay protection), event_id dedup (KV, 7d) |
| pay-invoice | `x-admin-secret` (constant-time) or x402 payment; link state re-validated live |
| Cloudflare edge | Bot Fight Mode active on mpprouter.dev — blocks some UAs (python urllib got 403/1010; curl passes). ⚠️ Deno-UA egress from Supabase Edge not yet verified — check `webhooks_log.response_status` on the next real delivery |

## 4. Double-spend protection (3 layers)

1. **Worker KV state machine**: event_id dedup; record status guard
   (`paid` / `failed_pay_invoice` terminal → no re-fire; `paying` → no double-fire);
   `funder-reserved-atomic` counter prevents concurrent invoices from spending the
   same balance. *Caveat: CF KV is eventually consistent — a near-simultaneous
   payin+payout pair has a narrow race window.*
2. **pay-invoice live check**: re-fetches the link; `usageCount >= maxUsage` → 409.
   *Caveat: read-then-pay race.*
3. **Coinbase link itself (hard backstop)**: `maxUsage: 1` — one-shot. A second
   capture fails at Coinbase/escrow. Worst case across all races = a failed second
   call, **never a second payment**.

## 5. Balance handling & alerting

- Funder wallet: `0x2352Fa…1739` (Base USDC). Same wallet is the Rozo payout
  destination, so payouts auto-replenish it per invoice.
- `payin_completed` + insufficient → deferred (normal; waits for payout event).
- `payout_completed` + insufficient → KV `failed_insufficient_balance` +
  `failureReason`. Not treated as terminal by the state machine, so a replayed
  webhook (manual, fresh `event_id`) retries after a top-up.
- **⚠️ GAP: no alert fires on funder low balance / failed fulfillment.**
  `DINGTALK_ACCESS_TOKEN` exists in the worker env but is only wired to the
  Tempo low-balance alert in `proxy.ts`. Recommended: DingTalk ping on
  `failed_insufficient_balance` and on `failed_pay_invoice`.
- Rozo does NOT retry webhooks. A lost/failed delivery needs manual replay
  (SOP: sign `${ts_ms}.${body}` with the payment row's `webhook_secret`, POST with
  `x-rozo-timestamp` / `x-rozo-signature: sha256=<hex>`; use curl, not python).

## 6. Supported assets

**Pay-in — what create-invoice accepts as `source`** (server-side whitelist,
`SUPPORTED_SOURCE`):

| Chain (id) | Tokens |
| --- | --- |
| Ethereum (1) | USDC, USDT |
| Polygon (137) | USDC, USDT |
| Base (8453) | USDC (default) |
| Solana (900) | USDC |
| Stellar (1500) | USDC |

Additionally, once the Rozo payment link exists, the pay.rozo.ai checkout offers its
own pay-in rails for that intent — e.g. the 2026-07-02 order was created with source
Base-USDC but actually paid via **Solana USDT** into the sol-pool. Effective pay-in
coverage = Rozo checkout rails, which is a superset of the table above.

**Settlement / payout: USDC on Base only.** Both the Rozo payout leg (to the funder
wallet) and the Coinbase link payment (`pay-invoice` rejects non-USDC-on-Base links)
are Base USDC.

## 7. Failure modes & incident history

- **2026-07-02 (payment d00d6634 / pl_…1kv5)**: Rozo never sent either webhook —
  (a) Solana sol-pool payin path had no webhook call at all, (b) withdraw-webhook's
  fire-and-forget POST was killed by Supabase Edge isolate freeze. Fixed 2026-07-03
  (await + payin webhook + 10s fetch timeout; withdraw-webhook v73, sol-pool-monitor
  v26). Order was completed by manual webhook replay.
- Coinbase pay succeeds but worker crashes before recording `paid` → KV shows
  `paying`; `invoice-status` reconciles against live Coinbase state (`settled: true`).
- Stalled merchant endpoint → webhook fetch aborts at 10s; Rozo logs the attempt in
  `webhooks_log` with the error.

## 8. Open items

1. Wire DingTalk alert for `failed_insufficient_balance` / `failed_pay_invoice` (§5).
2. Verify Supabase Edge (Deno UA) passes Cloudflare Bot Fight on the webhook route (§3).
3. Rozo-side webhook retry/backoff (currently single-shot per event).
4. E2E test wallets are dry (EVM `0x49CD…eEe0`: no Base ETH/USDC; Stellar
   `GAN3YS…4UYY`: no USDC) — blocks the smoke suite.
