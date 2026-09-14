# Lesson: bump the version whenever a signed payload changes meaning

**Date:** 2026-09-02 · **Where:** checkout quote receipts (`src/routes/quote-receipt.ts`, `CHECKOUT_PRICING_VERSION` in `src/routes/checkout-web-pricing.ts`)

## What happened

#128 changed how a signed quote receipt is interpreted (pricing stopped
depending on a receipt field) but kept the same receipt version. Receipts live
60 s. For the 60 s after the deploy, a receipt signed by the previous build
still verified and was accepted under the new rule with its old price.

Impact was zero: the deploy landed at 00:34Z with no checkout orders in the
window. That is luck, not design — a daytime deploy would have exposed real
orders.

## Rule

**Any deploy that changes the semantics of a signed payload must bump its
version in the same change** — including "this field is no longer written" or
"this field no longer affects the result". The old version is then rejected
outright and clients re-quote; a 60 s re-quote is cheap, a dual-semantics
window is not.

Checklist for a receipt/signature change:

1. Bump `CHECKOUT_PRICING_VERSION` (or the payload `v`).
2. Add a regression test that a payload signed under the previous version is
   rejected once the new rule is live.
3. Do not delete the replay tests that guard the old invariant until the new
   version makes them unreachable.

Fixed by bumping to `checkout-web-fee-v2` (this change).
