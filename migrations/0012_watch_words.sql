-- Per-subscription watch words: when a newly fetched article matches any of them, the owner gets
-- one in-app notification (row below) and, when SMTP is configured, one summary email per feed.
ALTER TABLE subscription ADD COLUMN watch_words TEXT;

CREATE TABLE notification (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  feed_id    INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  title      TEXT,
  link       TEXT,
  matched    TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Overlapping refreshes are possible (see index.ts), so one row per user/article no matter what.
CREATE UNIQUE INDEX notification_user_article ON notification(user_id, article_id);
CREATE INDEX notification_user_read ON notification(user_id, read, id DESC);
