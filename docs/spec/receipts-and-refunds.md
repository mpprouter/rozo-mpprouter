# Receipts and Refunds

> Part of the MPP Router spec. See [`README.md`](./README.md) for the design
> invariants that hold across every document here.

An agent that pays before it knows whether the service will deliver needs two
things the payment itself cannot give it: **proof of what it bought**, and **a
way to get its money back when nothing arrives**. This document specifies both.

The rule the router holds itself to is deliberately narrow, and it is a
statement about delivery, not about the merchant's reasons:

> **If the upstream does not deliver, the payer gets the money back.**

The router does not evaluate *why* an upstream refused. Non-delivery is
observed, classified, and refunded mechanically.

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **Payer** | The account that funded the paid call — for a charge-mode call, the `from` of the settled Stellar transfer |
| **Delivery** | An upstream response the payer can use: a non-error status with a non-empty body |
| **Non-delivery** | Payment settled, no usable upstream response (§3) |
| **Payment proof** | The verified inbound Stellar transaction the refund is derived from — recorded *before* the upstream call is attempted |
| **Receipt** | A signed statement of what was paid, what happened, and, when applicable, what was refunded |

## 2. Payment proof precedes delivery

The router records verified inbound payment proof **before** it attempts
upstream delivery. This ordering is what makes an automatic refund possible at
all: a refund is computed from a settled transaction that is already known and
verified, never reconstructed after the fact from a failure.

A payment proof carries the settled transaction hash, the payer account, the
asset, and the amount in atomic units. Every refund references exactly one
payment proof.

## 3. Non-delivery classification

The router classifies a paid call into exactly one of these outcomes. The first
four are non-delivery and trigger a refund:

| Reason | Condition |
| --- | --- |
| `timeout` | The upstream did not respond within the route's delivery window |
| `upstream_5xx` | The upstream returned a 5xx |
| `non_fulfillment` | The upstream returned any other post-payment error status — it accepted the request and declined to serve it |
| `empty_response` | The upstream returned a success status with an empty body |

`non_fulfillment` is intentionally broad. A merchant that takes payment and
then answers `4xx` has not delivered, whatever the reason code says, and the
payer should not be left holding the loss while the two sides discuss whose
fault it was.

Two cases are **not** refunds because no payment is taken:

- **Malformed request.** Request-body validation runs before any 402 is issued
  (invariant 1 in [`README.md`](./README.md)); a malformed request is rejected
  with `400` and never charged.
- **Expired quote.** A credential presented after its quote expiry is rejected
  before settlement.

## 4. Refund amounts

| Mode | Refund |
| --- | --- |
| **charge** (single-shot) | The full settled amount. A charge call either delivered or it did not; there is no partial delivery to price. |
| **channel / session** (bounded budget) | The unconsumed remainder. Value already settled against a valid signed commitment is not reversed. |
| **duplicate payment** | The duplicate settlement, in full |

Refunds are paid in the same asset, to the payer account taken from the payment
proof. The router never refunds to an address supplied in the failing request.

## 5. Execution and safety bounds

A refund is created as a durable job the moment non-delivery is classified, and
it survives router restarts. Execution is **pull-only**: the signer asks for
work, leases a job, signs, and reports back. The router's request path never
holds signing authority.

Three bounds govern execution, and they are enforced in code rather than by
convention:

1. **Automatic ceiling.** Refunds below the configured automatic maximum are
   signed and submitted without human involvement.
2. **Manual review above the ceiling.** A refund at or above the maximum is
   parked in `manual_review` and an operator is notified. It is never
   auto-signed.
3. **Notification threshold.** Completed refunds above the notification
   threshold raise an operator alert even though they were automatic.

The signer simulates every transfer before signing, and persists the
transaction envelope and hash before broadcast, so a refund that was submitted
can always be recovered and verified — never re-signed blindly.

A refund moves through `pending → leased → submitted → confirmed`, or diverts
to `manual_review`. `confirmed` is only reached after Stellar reports the
transaction successful; the router does not treat submission as completion.

## 6. Receipts

`GET /v1/refunds/{refund_id}`

While a refund is in flight:

```json
{
  "version": 1,
  "refund_id": "6e8eb745-d90e-45fc-a258-4846e9552f16",
  "outcome": "refund_pending",
  "reason": "non_fulfillment",
  "payment_tx": "c852353506...",
  "refund_amount": "10000",
  "merchant": "anthropic",
  "iat": "2026-08-09T13:04:41Z"
}
```

Once Stellar confirms the refund, the same URL returns a **signed** receipt: the
same fields plus the refund transaction hash and confirmation time, with an
`HS256` signature over the payload. The signature lets a payer — or a reviewer —
verify the receipt came from the router without trusting the transport.

Both transactions in a receipt are independently checkable on Stellar. Nothing
in a receipt has to be taken on the router's word.

## 7. Worked example (mainnet, 2026-08-09)

A live non-delivery, refunded automatically, with no operator action:

| Step | Evidence |
| --- | --- |
| Payer pays 0.001 USDC | `c85235350658c6d9993a97700c48028783a5b66b1f6e329579370ac97bc47a52` (13:04:34Z) |
| Upstream returns a post-payment error | classified `non_fulfillment` |
| Router refunds 0.001 USDC to the payer | `dbc1695e0ad916b96fb779d386e3189c35c775a17772a05c6843305e03d76f65` (13:05:36Z) |
| Receipt | `6e8eb745-d90e-45fc-a258-4846e9552f16` → `refunded_full` |

Both transactions succeeded on Stellar mainnet, 62 seconds apart, with the
refund an exact reversal of the payment — same asset, same amount, back to the
paying account.

## 8. Channel remainder recovery (payer-initiated)

Section 5 covers refunds the router initiates. A channel funder has an
additional path that does not depend on the router being reachable at all: the
one-way channel contract's own `close_start()` / `refund()` primitives, which
return the unsettled remainder to the funder after the contract's waiting
period, authorised by the funder's own key.

This is a floor, not the normal path. It means a funder's unsettled balance is
recoverable even if the router disappears entirely. The tooling ships in the
router repository (`npm run refund-channel`); the funder's key stays in their
own keystore and is never sent to the router.

## 9. Invariants

1. **Payment proof precedes delivery.** A refund is always derived from a
   verified settled transaction, never reconstructed from a failure.
2. **Refunds go to the payer.** The destination comes from the payment proof,
   never from request input.
3. **The request path cannot sign.** Signing authority is isolated from the
   proxy; the signer pulls work rather than being pushed to.
4. **Confirmed means on-chain.** A refund is `confirmed` only after Stellar
   reports success — never on submission.
5. **Large refunds are not automatic.** Above the configured ceiling, a human
   decides.
6. **Settled value is never reversed.** A channel refund returns the remainder;
   it does not claw back what a valid signed commitment already settled.
