-- Where clicks come from, for the click charts. Country from Cloudflare,
-- a device class from the user agent, and only the referring site's host.
ALTER TABLE clicks ADD COLUMN country TEXT;
ALTER TABLE clicks ADD COLUMN device TEXT;          -- mobile|tablet|desktop
ALTER TABLE clicks ADD COLUMN referrer_host TEXT;
CREATE INDEX idx_clicks_created ON clicks(created_at);
CREATE INDEX idx_conversions_created ON conversions(created_at);
