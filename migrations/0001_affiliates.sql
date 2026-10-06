-- In-house affiliate program schema. Applied via:
--   pnpm wrangler d1 execute DB --file=migrations/0001_affiliates.sql --remote
--   pnpm wrangler d1 execute DB --file=migrations/0001_affiliates.sql --env preview --remote

-- An affiliate. Created by the admin (invite-only); status moves
-- pending -> active once approved (promo code minted). code is the ?ref= slug.
CREATE TABLE affiliates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE NOT NULL,
  name            TEXT,
  code            TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending|active|suspended
  commission_pct  INTEGER NOT NULL DEFAULT 20,
  promo_code_id   TEXT,                              -- Stripe promotion code (buyer discount)
  stripe_account_id TEXT,                            -- Connect Express account (Phase D)
  created_at       INTEGER NOT NULL,
  source           TEXT,                             -- admin|application
  message          TEXT,                             -- applicant's note
  applied_at       INTEGER                           -- ms epoch; NULL for admin-created affiliates
);

-- One row per inbound affiliate-link click. ip_hash only (never raw IP).
CREATE TABLE clicks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id  INTEGER NOT NULL,
  ip_hash       TEXT,
  created_at    INTEGER NOT NULL
);

-- One row per payout batch. Stores stable transfer parameters for retries.
CREATE TABLE payouts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id    INTEGER NOT NULL,
  amount_cents    INTEGER NOT NULL,
  stripe_transfer_id TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|sent|failed|manual
  created_at      INTEGER NOT NULL,
  batch_key       TEXT,
  stripe_account_id TEXT,                            -- destination snapshot
  transfer_started_at INTEGER                        -- first attempt, ms epoch
);

-- One row per attributed paid checkout. UNIQUE(stripe_session_id) makes a
-- retried webhook a no-op. Claimed conversions remain paying until finalized.
CREATE TABLE conversions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id    INTEGER NOT NULL,
  stripe_session_id TEXT UNIQUE NOT NULL,
  stripe_event_id TEXT UNIQUE,
  payment_intent  TEXT,                              -- enables refund matching later
  customer_email  TEXT,
  amount_cents    INTEGER NOT NULL,                   -- net of discount
  commission_cents INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|approved|paying|paid|refunded
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  payout_id       INTEGER REFERENCES payouts(id)
);

CREATE INDEX idx_conversions_affiliate ON conversions(affiliate_id, status);
CREATE UNIQUE INDEX idx_payouts_batch_key ON payouts(batch_key);
CREATE UNIQUE INDEX idx_payouts_pending_batch ON payouts(affiliate_id)
  WHERE status='pending' AND batch_key IS NOT NULL;
CREATE INDEX idx_conversions_payout ON conversions(payout_id);
