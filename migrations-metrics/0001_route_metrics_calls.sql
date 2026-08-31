-- MPPRouter per-provider service-quality metrics (Cloudflare D1).
--
-- WHY THIS EXISTS: SCF #44 reviewers (2026-08-31) could not locate public
-- per-provider service-quality metrics. src/services/route-health.ts only
-- tracks CONSECUTIVE failures for a live ok/degraded badge and prunes them
-- after 15 minutes, so it has no denominator, no latency and no history.
--
-- SHAPE: one row per paid upstream call, not a pre-aggregated rollup.
-- Lifetime volume is in the tens of calls, so per-call rows cost nothing and
-- buy two things a daily rollup cannot: exact arbitrary windows (24h / 7d /
-- 30d / 90d / all-time all come from one range scan) and true percentiles
-- instead of histogram-bucket estimates. Revisit only if volume reaches a
-- scale where a range scan per page view stops being cheap.
--
-- PRIVACY INVARIANT: this table describes SERVICE QUALITY, not payers. It
-- must NEVER gain a payer address, tx hash, settlement ref, request body,
-- response body, API key or IP column. Those already live in the per-call
-- order ledger (src/services/order-ledger.ts, KV `mercury_order:*`), which
-- is access-controlled; this table is published publicly and must stay
-- safe to publish by construction.

CREATE TABLE IF NOT EXISTS route_metric_calls (
  -- Server-generated id (crypto.randomUUID). Never a caller-supplied value:
  -- a caller-controlled key would let a client overwrite or dedupe away
  -- another call's quality record.
  call_id        TEXT PRIMARY KEY,
  -- Epoch milliseconds. INTEGER so every window query is a range scan.
  created_at     INTEGER NOT NULL,

  -- Catalog service id, e.g. 'mercury', 'anthropic'. Derived from route.id
  -- so it matches the id used by GET /services and by the landing page's
  -- /services/<id> route.
  service_id     TEXT NOT NULL,
  -- Full catalog route id, e.g. 'mercury_txs_by_hash'. Kept alongside
  -- service_id so one page can show a provider roll-up and a per-endpoint
  -- breakdown from the same rows.
  route_id       TEXT NOT NULL,
  -- Request method, for display next to the endpoint.
  method         TEXT NOT NULL,

  -- WHOSE FAULT, not merely "did it work". Publishing a raw success rate
  -- would charge a provider for our own malformed test calls: of the 47
  -- lifetime calls in the order ledger on 2026-08-31, 19 were non-2xx and
  -- most were 4xx from bad request parameters we sent. Buckets:
  --   'ok'            — upstream returned 2xx and we delivered.
  --   'provider_fault'— upstream timed out, refused, rate-limited or 5xx'd.
  --   'caller_error'  — the request itself was bad (4xx that is not 401/403).
  --   'router_fault'  — our credentials/config were wrong (401/403 on a
  --                     router-held-credential route), or we failed to
  --                     deliver a response we had already been paid for.
  -- Only 'provider_fault' counts against a provider's published success rate.
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','provider_fault','caller_error','router_fault')),
  -- Coarse machine reason (RefundReason or 'timeout'/'upstream_error').
  -- Never an upstream error body: those quote URLs, payloads and sometimes
  -- credentials, and this table is published.
  reason         TEXT,
  -- HTTP status the upstream actually returned; NULL for transport failures
  -- and throws, where no upstream status exists.
  upstream_status INTEGER,

  -- Wall-clock ms for the upstream leg. NULL when unmeasured rather than 0:
  -- a zero would silently drag every published percentile toward zero, which
  -- is exactly how the pre-existing ledger ended up reporting a p50 of 0ms.
  latency_ms     INTEGER,

  -- 1 when the payer was refunded for this call. A provider that fails and
  -- refunds and one that fails and keeps the money are different promises,
  -- so the page reports refund rate next to success rate.
  refunded       INTEGER NOT NULL DEFAULT 0,

  -- 1 when the call came from ROZO's own test/dogfood traffic. Published
  -- figures exclude these; without the flag our own smoke tests would
  -- inflate exactly the numbers reviewers are asked to trust.
  is_internal    INTEGER NOT NULL DEFAULT 0
);

-- Every public query is "one service over a time window" or "all services
-- over a time window".
CREATE INDEX IF NOT EXISTS idx_rmc_service_created ON route_metric_calls (service_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rmc_created ON route_metric_calls (created_at);
