-- Usernames keep their case but uniqueness is case-insensitive, so "Alice" and "alice" cannot coexist.
-- Replace the case-sensitive index from 0007; the column has no NOCASE collation, so queries use COLLATE NOCASE explicitly.
DROP INDEX IF EXISTS user_username;
CREATE UNIQUE INDEX user_username ON user(username COLLATE NOCASE);
