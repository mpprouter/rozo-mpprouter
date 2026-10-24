-- Commerce rollup for the public /stats page (add-only).
--
-- WHY: /v1/stats used to aggregate by listing KV `mercury_order:*` and
-- reading every key, one subrequest each. Past 400 orders the Worker
-- subrequest budget forced `truncated: true` on every window. This table is
-- written alongside each order-ledger record (src/services/order-ledger.ts)
-- so the page is a handful of SQL aggregates with zero per-key KV reads.
--
-- PRIVACY: rows are never published; only COUNT / SUM / COUNT(DISTINCT)
-- leave the Worker. The payer is stored only as a SHA-256 digest, used for
-- COUNT(DISTINCT payer_digest). No tx hash, request path, body or IP.
--
-- The KV order ledger stays the source of truth; existing rows are
-- backfilled from it by scripts/backfill-order-ledger-stats.mjs.

CREATE TABLE IF NOT EXISTS order_ledger_stats (
  order_id      TEXT PRIMARY KEY,
  -- Epoch ms of the order (OrderLedgerEntry.ts).
  created_at    INTEGER NOT NULL,
  service_id    TEXT NOT NULL,
  -- USDC in micro-units (6 decimals), summed exactly as INTEGER.
  amount_micros INTEGER NOT NULL,
  payer_digest  TEXT,
  -- 1 once refund_status = 'refunded'.
  refunded      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_order_ledger_stats_created
  ON order_ledger_stats (created_at);
