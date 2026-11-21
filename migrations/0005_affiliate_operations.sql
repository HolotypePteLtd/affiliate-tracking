CREATE INDEX idx_clicks_affiliate ON clicks(affiliate_id);
CREATE INDEX idx_conversions_payment_intent ON conversions(payment_intent);

-- Refund and dispute webhooks can arrive before the paid checkout webhook.
CREATE TABLE refunded_payments (
  payment_intent TEXT PRIMARY KEY NOT NULL
);

ALTER TABLE affiliates ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE used_affiliate_magic_links (
  jti TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_used_magic_links_expiry ON used_affiliate_magic_links(expires_at);

ALTER TABLE affiliates ADD COLUMN promo_code TEXT;
-- Earlier approvals always derived the public code from the referral slug.
UPDATE affiliates SET promo_code=UPPER(REPLACE(REPLACE(code, '-', ''), '_', '') || '10')
  WHERE promo_code_id IS NOT NULL;
CREATE INDEX idx_affiliates_promo_code ON affiliates(promo_code COLLATE NOCASE);
ALTER TABLE affiliates ADD COLUMN status_change_id TEXT;
ALTER TABLE affiliates ADD COLUMN status_change_target TEXT;
