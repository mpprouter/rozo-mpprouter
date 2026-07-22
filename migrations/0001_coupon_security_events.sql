-- MPPRouter coupon security audit log (Cloudflare D1).
--
-- One row per POST /coupon/redeem OUTCOME, including malformed bodies,
-- unknown codes, Turnstile failures, rate-limited / circuit-open rejections,
-- amount mismatches, used/expired coupons, and successes. This is the
-- historical forensic trail; real-time counters and circuit-breaker state live
-- in the coupon Durable Object, NOT here.
--
-- REDACTION INVARIANT: this table stores ONLY keyed HMAC-SHA-256 digests
-- (see src/utils/redact.ts). It must NEVER contain a plaintext coupon code,
-- payment link, payment id, or full IP address. Do not add such columns.
--
-- This database is MPPRouter-specific. It is NOT the Rozo Intents Supabase.

CREATE TABLE IF NOT EXISTS coupon_security_events (
  -- Client-generated per-request UUID (crypto.randomUUID). UNIQUE so a
  -- double-insert from a retried write is idempotent rather than duplicated.
  request_id       TEXT PRIMARY KEY,
  -- Epoch milliseconds. Stored as INTEGER for cheap range pruning / windowing.
  created_at       INTEGER NOT NULL,
  -- Coarse outcome bucket: 'success' | 'failure' | 'rejected'.
  result           TEXT NOT NULL,
  -- Fine-grained reason, e.g. 'invalid_coupon', 'amount_mismatch',
  -- 'turnstile_failed', 'rate_limited', 'circuit_open', 'pair_frozen',
  -- 'malformed_body', 'redeemed'. Never contains user input.
  failure_reason   TEXT,
  -- Keyed digests (nullable when the corresponding input was absent/malformed).
  code_hash        TEXT,
  payment_id_hash  TEXT,
  pair_hash        TEXT,
  -- IP prefix digest is always present (unknown IP hashes to a fixed bucket).
  ip_prefix_hash   TEXT NOT NULL,
  -- 1 when Turnstile verification passed, 0 otherwise.
  turnstile_passed INTEGER NOT NULL DEFAULT 0
);

-- Retention / incident windowing: prune "delete rows older than N days" and
-- "count recent events by prefix" both range-scan created_at.
CREATE INDEX IF NOT EXISTS idx_cse_created_at ON coupon_security_events (created_at);

-- Incident investigation: "how many failures for this code / payment id / pair
-- / source network in the recent window". Composite (hash, created_at) so the
-- per-identifier lookups used by rate-limit forensics stay index-only.
CREATE INDEX IF NOT EXISTS idx_cse_code    ON coupon_security_events (code_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_cse_pid     ON coupon_security_events (payment_id_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_cse_pair    ON coupon_security_events (pair_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_cse_ip      ON coupon_security_events (ip_prefix_hash, created_at);
