-- Email verification for public sign-ups. Existing rows default to verified (1), so turning on
-- SMTP + verification never locks out an instance that already has accounts. Only register()
-- inserts 0; setup and admin-created accounts are verified immediately.
ALTER TABLE user ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;
-- Single-use, 24h token. NULL for verified accounts; a successful verify clears it (no replay).
ALTER TABLE user ADD COLUMN verify_token TEXT;
ALTER TABLE user ADD COLUMN verify_sent_at INTEGER;
CREATE UNIQUE INDEX user_verify_token ON user(verify_token);
