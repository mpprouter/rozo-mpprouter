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
| `coinbase` | $200 to $1,200 | T3A |
| `stripe`, `bitrefill`, `other` | <= $1,200 | T3B |
| anything else, or above the cap | | refused |

## Variables

All plain `[vars]` (public addresses), commented out in `wrangler.toml`:

| Var | Meaning |
| --- | --- |
| `FUNDER_TIERS_ENABLED` | Only the exact string `true` enables tiers. |
| `FUNDER_T1_ADDRESS` | x402 signer wallet (sign-x402). |
| `FUNDER_T2_ADDRESS` | Coinbase invoices below $200. |
| `FUNDER_T3A_ADDRESS` | Coinbase invoices $200 to $1,200. |
| `FUNDER_T3B_ADDRESS` | Stripe, Bitrefill and other merchants, up to $1,200. |

| `FUNDER_T3_BACKEND` | Exactly `legacy` = phase 2a (below). Same variable the signer reads. |

## Phases

- **Phase 2a** (`FUNDER_TIERS_ENABLED=true`, `FUNDER_T3_BACKEND=legacy`): T1
  (x402) and T2 (Coinbase below $200) use their own wallets. Every payment the
  selector puts in T3A or T3B (Coinbase $200 to $1,200, Stripe, Bitrefill,
  other) is served by the legacy funder `BASE_FUNDER_ADDRESS` exactly as with
  the flag off: same receiver, same balance check; `expected_funder` is the
  legacy funder so the signer cross-check agrees (the signer serves legacy-mode
  T3 with the same wallet). `FUNDER_T3A_ADDRESS` / `FUNDER_T3B_ADDRESS` are not
  read or required. T1 / T2 may still not equal the legacy funder. Refusals
  (unknown kind, non-positive, above the cap) are unchanged.
- **Phase 2b** (`FUNDER_T3_BACKEND` anything else, e.g. unset): T3A / T3B are
  their own wallets and must be configured.

With the flag on, Coinbase and Stripe settles also send `rozo_payment_id`
(the intents order whose payout went to the selected wallet) so a T3 signer
can verify the order read-only. Bitrefill already sends it; coupon, UPI and
admin pay have no order and send none.

`X402_TOPUP_RECEIVER`, when set, still overrides the x402 top-up receiver;
otherwise it defaults to T1 while the flag is on.

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
3. Drain or pause in-flight orders that pay out to the legacy funder: after
   the switch their settlement is refused (receiver mismatch) and needs a
   human.
4. TRON / TON alpha: routed with kind `tron_ton_alpha` (`routeFunder`). An
   order the alpha route created (`metadata.source` =
   `mpprouter-tron-ton-alpha`) is received and paid by the legacy funder in
   phase 2a whatever the amount, so capability, options, order creation and
   settlement work exactly as with the flag off; its settle sends
   `payment_kind: "tron_ton_alpha"` with `expected_funder` (legacy) and
   `rozo_payment_id`. A main-checkout order that a TRON / TON payment lands on
   stays a plain Coinbase order. In phase 2b alpha is refused
   (`ALPHA_FUNDER_TIERS_PAUSED`, reason `alpha_paused`). rozo-intents-api must
   keep alpha-created orders on the legacy destination.
5. Manual `/admin/pay-invoice` accepts only Coinbase ids while the flag is on.

Rollback: unset `FUNDER_TIERS_ENABLED` (or set it to anything but `true`) and
redeploy.
