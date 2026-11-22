-- Commission rules. Without any rules, affiliates.commission_pct applies as
-- before. A rule can target one affiliate, one Stripe product or price, both,
-- or everything; can be a percent or a fixed amount; can start at a monthly
-- sales tier; and can cap what one customer earns the affiliate.
CREATE TABLE commission_rules (
  id                      TEXT PRIMARY KEY NOT NULL,   -- random UUID
  affiliate_id            INTEGER,                     -- NULL: every affiliate
  product_id              TEXT,                        -- Stripe prod_… or price_…; NULL: every product
  kind                    TEXT NOT NULL,               -- percent|fixed
  percent                 REAL,                        -- for percent rules, e.g. 30
  fixed_cents             INTEGER,                     -- for fixed rules, per unit sold
  currency                TEXT,                        -- for fixed rules
  min_monthly_sales       INTEGER NOT NULL DEFAULT 0,  -- tier: sales so far this calendar month (UTC)
  cap_per_customer_cents  INTEGER,                     -- most one customer can earn the affiliate under this rule
  active                  INTEGER NOT NULL DEFAULT 1,
  created_at              INTEGER NOT NULL
);
CREATE INDEX idx_commission_rules_affiliate ON commission_rules(affiliate_id, active);
-- What was applied, so later rule changes never rewrite history.
ALTER TABLE conversions ADD COLUMN commission_detail TEXT;  -- JSON [{rule_id, product_id, base_cents, commission_cents}]
ALTER TABLE conversions ADD COLUMN bonus_note TEXT;         -- set on one-off bonus lines
