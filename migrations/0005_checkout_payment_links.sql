-- Original merchant payment link of every checkout order (founder decision
-- 2026-10-26: "you should save the original link. stripe and openrouter").
--
-- Why: on 2026-10-26 a Stripe Crypto settlement parked and nobody could
-- re-drive or re-pay the invoice because the only copy of the customer's
-- crypto.stripe.com/pay/<blob> link lived encrypted inside the router's
-- settlement record; Rozo intents only carries the cpis_ id. Coinbase links
-- are reconstructible from the pl_/paymentSession_ id, Stripe links are not.
--
-- The url IS a replayable payment capability (anyone holding it can pay the
-- invoice). It therefore lives here, in the router's own D1, readable by
-- operators (wrangler d1 execute) and never by any public endpoint, and is
-- still never written into Rozo intents metadata (echoed on every GET by id).
CREATE TABLE IF NOT EXISTS checkout_payment_links (
  -- Rozo payment id (intents_payments.id). One row per order; a re-create
  -- that resolves to the same order keeps the newest url.
  rozo_payment_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('coinbase', 'stripe_crypto')),
  -- pl_* / paymentSession_* / cpis_* : the merchant-side reference.
  order_ref TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkout_payment_links_order_ref ON checkout_payment_links (order_ref);
