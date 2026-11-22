-- Automatic hold period (AFFILIATE_HOLD_DAYS). Affiliates flagged here are
-- never released automatically; their conversions keep the manual review queue.
ALTER TABLE affiliates ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_conversions_status_created ON conversions(status, created_at);
