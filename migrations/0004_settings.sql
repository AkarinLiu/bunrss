CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 0 means "unlimited"
INSERT INTO setting (key, value) VALUES
  ('max_subscriptions', '0'),
  ('max_starred', '0');
