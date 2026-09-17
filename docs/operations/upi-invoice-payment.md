# UPI invoice payment (MuggleLink → router)

Server-to-server routes that let MuggleLink settle a customer's merchant invoice
after it has captured the customer's INR over Razorpay UPI. The router pays the
original invoice from its own funder wallet through the SAME executors the
crypto checkout uses (`agentapi/pay-invoice` for Coinbase, the Stripe branch of
the same function for Stripe Crypto). Code: `src/routes/upi-invoice.ts`,
`src/routes/invoice-claim.ts`.

## Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `UPI_INTERNAL_KEY` | secret (`wrangler secret put UPI_INTERNAL_KEY`) | Shared with MuggleLink. `X-Internal-Key` on every route, HMAC key for the `X-Signature` body signature and for `quote_id`. Min 16 chars. Unset ⇒ routes answer 503. |
| `UPI_PROVIDERS_ENABLED` | var (`wrangler.toml`) | CSV of `coinbase_v1`, `coinbase_v3`, `stripe_crypto`. Unset/empty ⇒ nothing payable (fail closed). `stripe_crypto` stays off until the Stripe signing branch of pay-invoice is enabled. |
| `UPI_MIN_VALIDITY_S` | var | Validity an invoice must still have at resolve time (default 900 s). |

Also required for Stripe: `INVOICE_CAPABILITY_ENCRYPTION_KEY` (the pay URL is
stored sealed, never plaintext) and the funder balance RPC (`BASE_RPC_URL`).

## Routes

All require `X-Internal-Key`. Never expose to browsers.

- `POST /api/invoice/resolve` `{ pay_url }` → provider-neutral resolution and
  a `quote_id` = HMAC-SHA256(key, `provider|invoice_key|base_amount_minor|expires_at`).
  `payable` is false for: provider says not payable (used/paid/wrong state),
  terminal success observed, less than `UPI_MIN_VALIDITY_S` left, provider not in
  `UPI_PROVIDERS_ENABLED`. 4xx: `unsupported_url` (400), `non_usd` (422),
  `expired` (410, provider no longer has the invoice), `upstream_error` (502).
- `POST /api/invoice/verified-pay-in` (+ `X-Signature` hex HMAC of the raw body,
  `X-Idempotency-Key` = `order_id`). Verifies the quote against LIVE provider
  data, creates the fulfillment record (CAS insert on the Durable Object),
  takes the cross-channel invoice claim, then executes. 202 `{ fulfillment_id,
  state }`; 409 `already_claimed` when another channel holds the invoice;
  409 `order_body_mismatch` when the same `order_id` arrives with different
  bytes; 422 `invalid_quote` / `quote_unknown` when the quote does not verify
  (nothing is claimed or paid, safe to refund).
- `GET /api/invoice/fulfillment/<order_id>` → `{ state, provider_final_state,
  execution_ref, updated_at }`. Each poll asks the provider; it never pays.

## State machine

`queued → processing → paid | failed | unknown`

- `paid` only on provider terminal success: Coinbase v3
  `PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED`, Coinbase v1 usage exhausted,
  Stripe `fulfillment_complete` / `succeeded`. An accepted executor call is
  `processing`, never `paid`.
- `unknown`: executor transport error / 5xx, or `processing` for more than 15
  minutes without provider confirmation. Never re-paid; reconcile by hand.
- `failed`: definite executor refusal, insufficient funder balance, Stripe
  branch disabled, invoice changed / already paid / provider disabled at pay
  time, or claimed by another channel. MuggleLink refunds the UPI capture.
- Terminal states are sticky. A `failed` record is never relabelled `paid`
  even if the provider later shows the invoice settled (someone else paid it).

## Cross-channel claim

`invoice-claim:v1:<invoice_key>` on the `stripe-fulfillment` AtomicStoreDO
singleton (versioned CAS, linearizable). UPI and crypto exclude each other; a
second UPI order for the same invoice is refused; crypto-vs-crypto is left to
the existing per-flow guards. The Coinbase webhook, the Stripe webhook branch
and coupon redemption all take this claim before paying and stop with
`claimed_by_other_channel` (webhook) / `LINK_CLAIMED` (coupon) if UPI holds it.
Claims are never released automatically.
