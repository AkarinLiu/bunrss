CREATE TABLE api_token (
  id           INTEGER PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_token_user ON api_token(user_id);
