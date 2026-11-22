-- Fraud checks. fraud_reason is set when a conversion looks like a
-- self-referral; flagged conversions are never approved automatically.
ALTER TABLE conversions ADD COLUMN fraud_reason TEXT;
-- IP hashes an affiliate has signed in from (never raw IPs).
CREATE TABLE affiliate_ip_hashes (
  affiliate_id  INTEGER NOT NULL,
  ip_hash       TEXT NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (affiliate_id, ip_hash)
);
CREATE INDEX idx_clicks_affiliate_ip ON clicks(affiliate_id, ip_hash, created_at);
