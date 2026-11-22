-- Short links: several links per affiliate, each with its own destination
-- and campaign, so clicks and sales can be counted per link.
CREATE TABLE links (
  id            TEXT PRIMARY KEY NOT NULL,            -- random UUID
  affiliate_id  INTEGER NOT NULL,
  slug          TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- the /r/<slug> part
  destination   TEXT NOT NULL,                        -- path on the site, e.g. /pricing
  campaign      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',       -- active|archived
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_links_affiliate ON links(affiliate_id, status);
ALTER TABLE clicks ADD COLUMN link_id TEXT;
ALTER TABLE conversions ADD COLUMN link_id TEXT;
CREATE INDEX idx_clicks_link ON clicks(link_id);
CREATE INDEX idx_conversions_link ON conversions(link_id);
