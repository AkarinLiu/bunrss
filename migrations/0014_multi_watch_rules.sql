-- Multiple independent watch rules per subscription. The previous single-rule columns are copied
-- into the new table (one row per feed that had watch words) and then dropped.
CREATE TABLE watch_rule (
  id            INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  include_words TEXT NOT NULL,
  exclude_words TEXT,
  mode          TEXT NOT NULL DEFAULT 'any',
  created_at    INTEGER NOT NULL
);
CREATE INDEX watch_rule_subscription ON watch_rule(subscription_id);

INSERT INTO watch_rule (subscription_id, include_words, exclude_words, mode, created_at)
SELECT id, watch_words, watch_exclude, watch_mode, (unixepoch() * 1000)
  FROM subscription
 WHERE watch_words IS NOT NULL AND TRIM(watch_words) <> '';

ALTER TABLE subscription DROP COLUMN watch_words;
ALTER TABLE subscription DROP COLUMN watch_exclude;
ALTER TABLE subscription DROP COLUMN watch_mode;
