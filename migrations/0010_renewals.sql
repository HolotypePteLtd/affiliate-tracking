-- Recurring commissions. A subscription's renewals pay the affiliate who got
-- its first sale, for recurring_months months after that sale.
ALTER TABLE conversions ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE conversions ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE conversions ADD COLUMN stripe_invoice_id TEXT;
ALTER TABLE conversions ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkout';  -- checkout|renewal
CREATE UNIQUE INDEX idx_conversions_invoice ON conversions(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX idx_conversions_customer ON conversions(stripe_customer_id, created_at);
CREATE INDEX idx_conversions_subscription ON conversions(stripe_subscription_id, created_at);
-- NULL: use AFFILIATE_RECURRING_MONTHS (default 12). 0: first payment only.
ALTER TABLE affiliates ADD COLUMN recurring_months INTEGER;
