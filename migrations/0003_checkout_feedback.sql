-- Checkout post-payment feedback (ainative todos/20261003-checkout-post-success-feedback.zh.md).
--
-- One optional free-text answer per settled checkout order, plus the durable
-- state of its single Feishu notification. The row IS the notification job:
-- inserting the feedback and queueing its notification is one atomic write.
--
-- Raw `text` is a controlled internal record. It is never sent to analytics,
-- and it reaches Feishu only through redactForAlert. Rows hold no payment
-- links, coupons, wallet addresses or contact details (the endpoint rejects
-- text that looks like any of those).
CREATE TABLE IF NOT EXISTS checkout_feedback (
  feedback_id TEXT PRIMARY KEY,
  -- Rozo payment id (intents_payments.id). UNIQUE: first version is one answer
  -- per order, and double clicks / reloads / retries resolve to the same row.
  payment_id TEXT NOT NULL UNIQUE,
  merchant TEXT,
  text TEXT NOT NULL,
  locale TEXT,
  created_at INTEGER NOT NULL,
  -- Server-side settlement proof observed at submit time, e.g.
  -- coinbase_v3:PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED / router:paid.
  settlement_status TEXT NOT NULL,
  settlement_checked_at INTEGER NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (notification_status IN ('pending', 'sending', 'sent', 'failed', 'abandoned')),
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  notification_next_attempt_at INTEGER NOT NULL DEFAULT 0,
  notification_claimed_at INTEGER,
  notified_at INTEGER,
  notification_last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkout_feedback_notify
  ON checkout_feedback(notification_status, notification_next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_checkout_feedback_created_at
  ON checkout_feedback(created_at);
