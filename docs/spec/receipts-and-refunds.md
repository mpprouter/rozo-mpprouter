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

`manual_review` is a diversion, **not** a dead end. `POST /admin/refunds/unpark`
returns a parked refund to `pending`, discarding its stale
envelope so the executor signs a fresh one. It is idempotent, records an
`admin_unpark` audit event on the refund, and permits no other transition —
`confirmed`, `submitted` and `leased` refunds are refused, so it can never
re-send money that already went back or steal a job from a live lease.

It is addressable by `refundId` or by the `paymentTx` printed on the public
ledger row, and it requires the operator's own `ADMIN_TOKEN` — unlike every
other refund admin route, the signer's `REFUND_EXECUTOR_TOKEN` is refused.
`manual_review` exists to take a decision away from the automated path, so the
credential that path carries must not be able to reverse it.

Two properties keep a transient network fault from becoming a stranded refund
in the first place: signed envelopes are valid for **ten minutes**, comfortably
longer than the confirmation poll and the one-minute executor tick that both run
inside that window; and refunds signed back-to-back from the same account never
reuse a sequence number that the network has already accepted, even when the RPC
reports a stale account.

Silence is also alerted on, not only rejection: any refund still unconfirmed ten
minutes after it was queued raises exactly one operator alert, whatever state it
is sitting in.

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
same fields plus the refund transaction hash and confirmation ledger, wrapped in
an **Ed25519** signature made with a Stellar keypair:

```json
{
  "receipt": {
    "version": 1,
    "payment_id": "challenge-1",
    "payment_tx": "c852353506...",
    "merchant": "anthropic",
    "amount": "10000",
    "mode": "charge",
    "outcome": "refunded_full",
    "refund_tx": "dbc1695e0a...",
    "refund_amount": "10000",
    "reason": "non_fulfillment",
    "confirmed_ledger": 58412290,
    "iat": "2026-08-09T13:04:41.000Z",
    "exp": "2026-08-10T13:04:41.000Z"
  },
  "signature": "8mQ...base64url...Ag",
  "algorithm": "Ed25519",
  "canonicalization": "rozo-receipt-json-v1",
  "signer": {
    "stellar_address": "G...",
    "ed25519_public_key_hex": "a1b2..."
  }
}
```

Both transactions in a receipt are independently checkable on Stellar. Nothing
in a receipt has to be taken on the router's word — including the receipt
itself, per the next section.

## 6.1 Verifying a receipt

The signature is **asymmetric**. Anyone holding the signer's public Stellar
address can verify a receipt; nobody but the router can produce one. That is the
whole point: a receipt is evidence a third party can check, not an assertion we
make about ourselves.

### The signing key

Receipts are signed by a **dedicated** Stellar keypair, not the router pool
treasury key. A receipt signer holds no funds and carries no payment authority,
so it can live in the request path while the treasury secret stays offline. Its
public address is published in two places, which must agree:

* `signer.stellar_address` on the receipt itself, and
* `stellar.receipt_signer` on `GET /health`.

Fetch the address from `/health` rather than trusting the copy embedded in the
receipt you are checking — a forged receipt could carry a forged signer.

```bash
curl -s https://apiserver.mpprouter.dev/health \
  | jq '{current: .stellar.receipt_signer, retired: .stellar.receipt_signer_retired}'
```

`/health` publishes the **current** signer plus `receipt_signer_retired`, the
addresses of any previously-used signers. Rotating the key does not invalidate
receipts the old key signed, so an older receipt is valid if its signature
verifies against the current address **or** any retired one. A receipt whose
signer matches nothing in either list should be rejected outright.

A Stellar `G...` address *is* an Ed25519 public key in strkey encoding; the
receipt also carries the same 32 bytes as `ed25519_public_key_hex` for
verifiers that would rather not depend on a Stellar library.

### Canonicalisation (`rozo-receipt-json-v1`)

The signed bytes are UTF-8 `JSON.stringify` over the `receipt` object with keys
emitted in exactly this order, omitting any key whose value is absent:

```
version, payment_id, payment_tx, merchant, amount, mode, outcome,
refund_tx, refund_amount, reason, confirmed_ledger, iat, exp
```

Keys outside that list are not signed and must be ignored when verifying. Do
not re-serialise the receipt with your own JSON encoder's key order — rebuild
it in the order above. The contract is pinned in code as
`RECEIPT_FIELD_ORDER` in `src/refund/receipt-signer.ts` and is covered by tests
that assert the exact byte prefix.

### Runnable verification (Node 20+)

Needs only `@stellar/stellar-sdk`, which decodes the `G...` address and does the
Ed25519 check. Save as `verify-receipt.mjs` and run
`node verify-receipt.mjs <refund_id>`.

```js
import { Keypair, StrKey } from '@stellar/stellar-sdk'

const ROUTER = 'https://apiserver.mpprouter.dev'
const FIELDS = [
  'version', 'payment_id', 'payment_tx', 'merchant', 'amount', 'mode',
  'outcome', 'refund_tx', 'refund_amount', 'reason', 'confirmed_ledger',
  'iat', 'exp',
]

const refundId = process.argv[2]
const body = await (await fetch(`${ROUTER}/v1/refunds/${refundId}`)).json()
if (body.algorithm !== 'Ed25519') throw new Error(`unexpected algorithm ${body.algorithm}`)

// Trust the operator's published addresses, not the one inside the receipt.
// Retired signers stay published so receipts predating a rotation still verify.
const health = await (await fetch(`${ROUTER}/health`)).json()
const trusted = [
  health.stellar.receipt_signer,
  ...(health.stellar.receipt_signer_retired ?? []),
].filter(Boolean)
const signer = body.signer.stellar_address
if (!trusted.includes(signer)) throw new Error(`untrusted signer ${signer}`)

// Rebuild the exact signed bytes.
const canonical = {}
for (const field of FIELDS) {
  if (body.receipt[field] !== undefined) canonical[field] = body.receipt[field]
}
const message = Buffer.from(JSON.stringify(canonical), 'utf8')
const signature = Buffer.from(
  body.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64',
)

const ok = Keypair.fromPublicKey(signer).verify(message, signature)
console.log(ok ? 'VALID' : 'INVALID', '·', signer)

// Same check without any Stellar dependency, using the raw key:
const raw = StrKey.decodeEd25519PublicKey(signer)          // 32 bytes
console.log('ed25519 public key', Buffer.from(raw).toString('hex'))
```

Verify the two transaction hashes in the receipt against Stellar independently.
The signature and the chain are separate evidence and should be checked
separately.

### What a valid signature proves — and what it does not

**It proves** the router produced this exact receipt: these hashes, this amount,
this outcome, this timestamp. Because only the holder of the secret half of the
published address can produce that signature, we cannot later deny having issued
it, and nobody else can fabricate one in our name. Change one character of one
field and verification fails.

**It does not prove** that the refund settled — the chain proves that. Check
`payment_tx` and `refund_tx` on Stellar yourself. A signed receipt whose
transactions do not check out is a signed statement we are on the hook for, not
a settlement.

When the router is operated by a third party, the mechanism is unchanged: that
operator sets their own signing key, `/health` publishes their address, and
receipts verify against it. Nothing in this scheme is specific to ROZO holding
the key.

### Predecessor: `HS256` receipts

Before this change, receipts carried an HMAC-SHA256 signature
(`"algorithm": "HS256"`) keyed on a shared secret. That is a **symmetric**
construction: only the router could verify its own receipts, so an `HS256`
receipt proved nothing to a payer or a reviewer. It has been removed.

Verifiers should key off the `algorithm` field and **reject anything other than
`Ed25519`**. Receipts issued before the cutover cannot be verified by a third
party at all and should be treated as unverified claims; the transaction hashes
they carry remain checkable on Stellar, which is the stronger evidence in any
case. Cutover date: **2026-08-18** (Worker version `5a5a265a`, the first deploy with
`RECEIPT_SIGNING_SECRET` set; signer `GACLZFFWWJX33XEY25VNNXUG73EQDGV5KOR6M6EBNTZ3BR4DHROOQFCH`,
published on `/health`).

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
6. **Receipts are verifiable without us.** Signatures are Ed25519 against a
   published public address, never a shared secret. If a receipt can only be
   verified by the party that issued it, it is not evidence.
7. **Settled value is never reversed.** A channel refund returns the remainder;
   it does not claw back what a valid signed commitment already settled.
