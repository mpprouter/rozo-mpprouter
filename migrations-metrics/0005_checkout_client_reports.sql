-- Agent Checkout B9: client-side outcome reports from the checkout CLI and
-- MCP server (2026-11-17).
--
-- WHY: the weekly patrol (W24) sees order creates and paid orders per client
-- version, but not the payments a client refused locally (a guard stopped it
-- before any order existed or before any money was sent), nor the ones the
-- user abandoned. Old versions with a broken guard are only visible here.
--
-- PRIVACY INVARIANT: no person, wallet or payment detail. Never add an
-- address, amount, tx hash, invoice link, IP, email, free text or key column.
-- rozo_payment_id is an opaque order id the client already holds; it lets a
-- report be joined to an order that did get created, nothing more.
--
-- Add-only: a new table and an index. Nothing else reads or writes it.
CREATE TABLE IF NOT EXISTS checkout_client_reports (
  -- Server-generated (crypto.randomUUID), never caller-supplied.
  report_id       TEXT PRIMARY KEY,
  -- Epoch milliseconds, server clock.
  created_at      INTEGER NOT NULL,
  -- 'rozo-checkout-cli' | 'rozo-checkout-mcp'
  client          TEXT NOT NULL,
  -- Client semver, e.g. '0.1.27'.
  client_version  TEXT NOT NULL,
  -- 'succeeded' | 'refused' | 'failed' | 'abandoned' | 'unconfirmed'
  outcome         TEXT NOT NULL,
  -- The client's own error or guard code (UPPER_SNAKE), NULL on success.
  code            TEXT,
  -- 'coinbase' | 'bitrefill' | 'x402' | NULL
  flow            TEXT,
  rozo_payment_id TEXT
);
CREATE INDEX IF NOT EXISTS checkout_client_reports_created
  ON checkout_client_reports (created_at);
