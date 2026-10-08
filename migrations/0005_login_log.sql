CREATE TABLE login_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_log_user ON login_log(user_id, created_at DESC);
