-- Adds self-serve affiliate applications (schema only; 0001 first).
-- Apply via:
--   pnpm wrangler d1 execute DB --file=node_modules/cf-affiliate/migrations/0002_affiliate_applications.sql --remote
--   pnpm wrangler d1 execute DB --file=node_modules/cf-affiliate/migrations/0002_affiliate_applications.sql --env preview --remote

-- Where this affiliate came from: 'admin' (created via POST /api/admin/affiliates)
-- or 'application' (self-serve POST /api/affiliate/apply).
ALTER TABLE affiliates ADD COLUMN source TEXT;

-- The applicant's note to the admin.
ALTER TABLE affiliates ADD COLUMN message TEXT;

-- When they applied (ms epoch); NULL for admin-created affiliates.
ALTER TABLE affiliates ADD COLUMN applied_at INTEGER;
