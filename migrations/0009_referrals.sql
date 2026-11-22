-- Signup referrals: which affiliate referred each of the host's users,
-- recorded at signup so a purchase after the cookie expires is still credited.
-- One row per user. A promo code entered at the first payment may replace the
-- affiliate once; after the first paid conversion the row never changes.
CREATE TABLE referrals (
  id                  TEXT PRIMARY KEY NOT NULL,   -- random UUID
  user_id             TEXT NOT NULL UNIQUE,        -- the host's own user id
  affiliate_id        INTEGER NOT NULL,
  source              TEXT NOT NULL,               -- signup|promo_code|checkout
  stripe_customer_id  TEXT,
  created_at          INTEGER NOT NULL,
  converted_at        INTEGER                      -- first paid conversion
);
CREATE INDEX idx_referrals_affiliate ON referrals(affiliate_id, created_at);
CREATE INDEX idx_referrals_customer ON referrals(stripe_customer_id);
ALTER TABLE conversions ADD COLUMN user_id TEXT;
CREATE INDEX idx_conversions_user ON conversions(user_id);
