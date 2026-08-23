-- OpenAI-compatible facade request ledger. Missing usage is NULL, never zero.
CREATE TABLE IF NOT EXISTS llm_facade_requests (
  -- Server-generated event id. The OpenAI X-Request-Id is caller-controlled
  -- and therefore must never be a uniqueness or overwrite authority.
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  wallet_address TEXT,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  provider TEXT NOT NULL,
  fallback_reason TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  input_price_per_million_usd TEXT,
  output_price_per_million_usd TEXT,
  cache_price_per_million_usd TEXT,
  quoted_amount_usd TEXT,
  upstream_cost_usd TEXT,
  settlement_ref TEXT,
  channel_cursor_before TEXT,
  channel_cursor_after TEXT,
  status TEXT NOT NULL CHECK (status IN ('settled', 'passthrough', 'failed', 'fallback_used', 'delivered_unsettled')),
  charge_evidence_json TEXT,
  authoritative_receipt_json TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  reconciliation_last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_lfr_created_at ON llm_facade_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_lfr_request_id ON llm_facade_requests(request_id);
CREATE INDEX IF NOT EXISTS idx_lfr_wallet_created ON llm_facade_requests(wallet_address, created_at);
CREATE INDEX IF NOT EXISTS idx_lfr_model_created ON llm_facade_requests(actual_model, created_at);
CREATE INDEX IF NOT EXISTS idx_lfr_provider_created ON llm_facade_requests(provider, created_at);
