-- Links an affiliate to a user of the host's own auth (e.g. Better Auth).
-- Set on the affiliate's first sign-in through the auth hook, matched by
-- verified email; after that the user id is what identifies them.
ALTER TABLE affiliates ADD COLUMN user_id TEXT;
CREATE UNIQUE INDEX idx_affiliates_user ON affiliates(user_id) WHERE user_id IS NOT NULL;
