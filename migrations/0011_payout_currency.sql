-- Payouts in the platform's own currency. payout_cents is what a commission
-- pays in payout_currency: the commission itself when the sale was in that
-- currency, otherwise converted at the rate Stripe actually used when it
-- settled the sale (fx_source names that balance transaction).
ALTER TABLE conversions ADD COLUMN payout_currency TEXT;
ALTER TABLE conversions ADD COLUMN payout_cents INTEGER;
ALTER TABLE conversions ADD COLUMN fx_source TEXT;       -- txn_… balance transaction, NULL when no conversion was needed
ALTER TABLE conversions ADD COLUMN fx_checked_at INTEGER;
