# Tiered Base USDC funder wallets

Status: code shipped dark. `FUNDER_TIERS_ENABLED` is not set, so the router
uses the single legacy funder (`BASE_FUNDER_ADDRESS` in
`src/funder-address.ts`) exactly as before. Enabling the flag adds new payout
destinations and needs founder approval first.

## Rules

The selector is `selectFunderTier(kind, amountAtomic)` in
`src/funder-tiers.ts`. That file and `src/funder-tier-vectors.json` are
mirrored byte for byte with the remote signer (pay-invoice / sign-x402), which
picks its key with the same rules. Change both repos in one review, or neither.

`amountAtomic` is the USDC the funder signs for (the Coinbase / Stripe /
Bitrefill invoice amount, 6 decimals), not the caller's fee-inclusive price.

| Kind | Amount | Tier |
| --- | --- | --- |
| `x402` | <= $5 | T1 |
| `coinbase` | < $200 | T2 |
| `coinbase` | >= $200 | T3A |
| `bitrefill`, `other` | any | T3B |
| `stripe` | any | legacy funder on every backend (band T3B; the KMS T3B signs no EIP-2612 Permit yet) |
| `tron_ton_alpha` | < $200 / >= $200 | T2 / T3A (legacy funder in phase 2a) |
| anything else | | refused |

Payments with no intents order (coupon, UPI, admin pay) use
`resolveNoOrderFunder` (`routeNoOrderFunder`, mirrored): the same table,
except that T3A / T3B become the legacy funder, because the phase 2b KMS T3
signer only signs against a paid-out intents order received by its wallet.

Tier bands have no upper bound (founder 2026-11-24). The order cap is a
separate refuse-check (`over_order_cap`) applied after the band to every
non-x402 payment. Its single source here is `ORDER_CAP_USD` in
`src/routes/native-sources.ts` (currently $1,200; the signer reads its own
env `ORDER_CAP_USD`, default $1,200 when unset or unparsable). Raising the
cap needs no change to `funder-tiers.ts` or the vectors; raise the signer env
together with (or before) the router constant.

## Variables

All plain `[vars]` (public addresses), commented out in `wrangler.toml`:

| Var | Meaning |
| --- | --- |
| `FUNDER_TIERS_ENABLED` | Only the exact string `true` enables tiers. |
| `FUNDER_T1_ADDRESS` | x402 signer wallet (sign-x402). |
| `FUNDER_T2_ADDRESS` | Coinbase invoices below $200. |
| `FUNDER_T3A_ADDRESS` | Coinbase invoices $200 and above (up to the order cap). |
| `FUNDER_T3B_ADDRESS` | Stripe, Bitrefill and other merchants (up to the order cap). |

| `FUNDER_T3_BACKEND` | Exactly `legacy` = phase 2a (below). Same variable the signer reads. |

## Phases

- **Phase 2a** (`FUNDER_TIERS_ENABLED=true`, `FUNDER_T3_BACKEND=legacy`): T1
  (x402) and T2 (Coinbase below $200) use their own wallets. Every payment the
  selector puts in T3A or T3B (Coinbase $200 and above, Stripe, Bitrefill,
  other) is served by the legacy funder `BASE_FUNDER_ADDRESS` exactly as with
  the flag off: same receiver, same balance check; `expected_funder` is the
  legacy funder so the signer cross-check agrees (the signer serves legacy-mode
  T3 with the same wallet). `FUNDER_T3A_ADDRESS` / `FUNDER_T3B_ADDRESS` are not
  read or required. T1 / T2 may still not equal the legacy funder. Refusals
  (unknown kind, non-positive, above the cap) are unchanged.
- **Phase 2b** (`FUNDER_T3_BACKEND` anything else, e.g. unset): T3A / T3B are
  their own wallets and must be configured. The legacy funder is never a new
  order's destination, but stays a paying wallet: orders created before the
  switch with the legacy destination are paid by it until they drain, and
  no-order T3-sized payments are paid by it (signer: while its `PRIVATE_KEY`
  is set). It stays in the balance watch.

With the flag on, Coinbase and Stripe settles also send `rozo_payment_id`
(the intents order whose payout went to the selected wallet) so a T3 signer
can verify the order read-only. Bitrefill already sends it; coupon, UPI and
admin pay have no order and send none.

`X402_TOPUP_RECEIVER`, when set, still overrides the x402 top-up receiver;
otherwise it defaults to T1 while the flag is on.

## Paying out: the receiving wallet pays (flag on)

The tier amounts route NEW orders (`routeFunder`, unchanged). When an order's
money has landed, the wallet it actually paid out to pays the invoice,
whatever the amount (`resolvePayingFunder` -> mirrored
`payFromReceivingWallet`). This applies to the Coinbase webhook settle
(including TRON / TON alpha orders), Stripe settle, Bitrefill settle and its
existing-order / concurrent-conflict paths, order reuse in create-invoice and
the alpha option, and the sweep (which uses the wallet stored at send time).
Balance check, `expected_funder` and the expected signer follow that wallet.

- An amount outside the wallet's nominal range is a warning only: a
  `funder_tier_range_warning` log line and an ops alert (order, wallet,
  amount, nominal wallet). It never blocks the payout.
- Still refused: a destination that is not a configured paying wallet
  (unknown, retired, blocklisted, or an unconfigured tier), amount above the order cap (`ORDER_CAP_USD`) or not positive, an
  unknown kind, order money in T1, x402 outside T1 or above $5.
- Balance caps (T1 50, T2 200, T3B 2,000 USDC) are alert-only in the router
  (balance watch); nothing refuses a payout for a balance above a cap. The
  "enough balance to pay" check stays.

## Fail-closed behaviour (flag on)

`resolveFunder(env, kind, amountAtomic)` refuses, with no fallback to another
tier or to the legacy wallet, when the selected tier's address is missing, not
a 40-hex EVM address, has a wrong mixed-case checksum, is the zero address,
the retired (2026-11-24) funder, the legacy funder, on the EVM blocklist
(`src/evm-blocked-addresses.ts`) or the USDC contract, or equals another
tier's address. A refusal means no order is created and nothing is paid
(error code `FUNDER_TIER_REFUSED`).

Cross-checks:
- Every pay-invoice call carries `expected_funder` (the selected tier). The
  signer answers `409 {signed:false, code:"funder_tier_mismatch"}` when its own
  selection differs; the router treats that as a definite refusal before
  signing (never as an ambiguous outcome).
- A created or reused intents order whose `destination.receiverAddress` is not
  the selected tier is not handed out (`FUNDER_TIER_RECEIVER_MISMATCH`), and a
  settlement whose order paid another wallet is refused before any send.
- x402: sign-x402 answers must come from T1 (otherwise 503
  `X402_SIGNER_NOT_CONFIGURED`).

## Before enabling

1. Create the four wallets, configure the signer with the same addresses, and
   deploy the signer change that understands `expected_funder`.
2. rozo-intents-api forces the `merchant_openrouter` destination from its
   merchant row. It must route per amount to T2 / T3A (and Stripe / Bitrefill
   to T3B) before this flag is on, otherwise every order is refused by the
   receiver cross-check (fail closed, but nothing can be paid).
3. In-flight orders that pay out to the legacy funder keep being paid by it
   after the switch (recorded destination decides). Keep the signer's
   `PRIVATE_KEY` and the legacy funder's balance until they have drained.
4. TRON / TON alpha: routed with kind `tron_ton_alpha` (`routeFunder`). An
   order the alpha route created (`metadata.source` =
   `mpprouter-tron-ton-alpha`) is, in phase 2a, created with the payout
   destination `routeFunder` picks (founder 2026-11-24): T2 when the invoice
   is below $200, the legacy funder from $200 up to the order cap, refused
   above. It is then paid by the wallet its recorded destination names
   (`resolvePayingFunder`), never one recomputed from the amount: alpha orders
   created before this rule keep their legacy destination and are still paid
   by the legacy funder (a range warning, not a refusal). Its settle sends
   `payment_kind: "tron_ton_alpha"` with `expected_funder` (that wallet) and
   `rozo_payment_id`; the signer's `verifyAlphaOrder` accepts an alpha order
   paying out to the legacy funder, T2 or T3A. The upstream allocation digest's
   `destination` (`ALPHA_DESTINATION`) stays the legacy funder on purpose:
   merchant_openrouter is on the upstream legacy list, where it is a digest
   fact only, and changing it would break re-reads of options allocated
   before a deploy. A main-checkout order that a TRON / TON payment lands on
   stays a plain Coinbase order. In phase 2b alpha is routed like Coinbase
   (T2 below $200, T3A from $200; no longer paused). If merchant_openrouter
   ever leaves the upstream legacy list (bound lane or Base route), those
   lanes compare `destination` with the business order's receiver, and
   `ALPHA_DESTINATION` must then follow the order instead.
5. Manual `/admin/pay-invoice` accepts only Coinbase ids while the flag is on.

Rollback: unset `FUNDER_TIERS_ENABLED` (or set it to anything but `true`) and
redeploy.
