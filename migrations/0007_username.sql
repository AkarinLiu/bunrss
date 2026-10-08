-- Optional username; a non-NULL username is globally unique, so it binds to exactly one account (and thus one email).
-- Existing rows keep NULL and keep signing in with their email.
ALTER TABLE user ADD COLUMN username TEXT;
CREATE UNIQUE INDEX user_username ON user(username);
