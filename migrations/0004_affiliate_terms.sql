-- Explicit acceptance for new self-serve applications. Existing/admin-created
-- accounts remain NULL; migration must not manufacture consent for them.
ALTER TABLE affiliates ADD COLUMN terms_version TEXT;
ALTER TABLE affiliates ADD COLUMN terms_accepted_at INTEGER;
