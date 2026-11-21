-- Purchase snapshots, safe affiliate reporting, and explicit payout currency.
-- Existing conversions retain NULL currency/country/rate when not recorded.
ALTER TABLE conversions ADD COLUMN currency TEXT;
ALTER TABLE conversions ADD COLUMN customer_country TEXT;
ALTER TABLE conversions ADD COLUMN commission_pct INTEGER;
ALTER TABLE conversions ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversions ADD COLUMN approved_at INTEGER;
ALTER TABLE payouts ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd';
ALTER TABLE payouts ADD COLUMN paid_at INTEGER;
CREATE INDEX idx_conversions_affiliate_date ON conversions(affiliate_id, created_at DESC, id DESC);
