## What changed

<!-- one or two lines -->

## Checklist

- [ ] `npx vitest run` and `npx tsc --noEmit -p .` are green.
- [ ] Provider matrix: if this PR touches an endpoint that accepts an invoice URL (`quote-invoice`, `create-invoice`, `invoice-details`, `invoice-status`), it was tested per provider x endpoint (Coinbase v1 `pl_*`, Coinbase v3 `paymentSession_*`, Stripe `crypto.stripe.com/pay/*`) and the section below states which cells changed. A provider supported by one endpoint but not its sibling (`quote-invoice` vs `create-invoice` vs `invoice-details`) is a bug, not a feature gap. Reason: until #188 `quote-invoice` rejected Stripe links while `invoice-details` accepted them, and the web checkout's Pay USDC/USDT flow was broken for Stripe for 6 days.
- [ ] merge is not deploy: this Worker is deployed by hand with `wrangler deploy`; say in the PR whether a deploy is needed.

## Provider x endpoint matrix

| | quote-invoice | create-invoice | invoice-details | invoice-status |
| --- | --- | --- | --- | --- |
| Coinbase v1 `pl_*` | | | | |
| Coinbase v3 `paymentSession_*` | | | | |
| Stripe `crypto.stripe.com/pay/*` | | | | |

<!-- fill each touched cell with "unchanged", "added", "fixed" or "n/a", or write "no invoice endpoint touched" -->
