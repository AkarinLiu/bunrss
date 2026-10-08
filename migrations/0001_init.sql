CREATE TABLE user (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE session (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX session_user ON session(user_id);

CREATE TABLE feed (
  id              INTEGER PRIMARY KEY,
  feed_url        TEXT NOT NULL UNIQUE,
  title           TEXT,
  site_url        TEXT,
  description     TEXT,
  last_fetched_at INTEGER,
  etag            TEXT,
  last_modified   TEXT,
  last_error      TEXT
);

CREATE TABLE category (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, name)
);

CREATE TABLE subscription (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  feed_id      INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
  category_id  INTEGER REFERENCES category(id) ON DELETE SET NULL,
  custom_title TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, feed_id)
);

CREATE TABLE article (
  id           INTEGER PRIMARY KEY,
  feed_id      INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
  guid         TEXT NOT NULL,
  title        TEXT,
  link         TEXT,
  author       TEXT,
  content      TEXT,
  summary      TEXT,
  published_at INTEGER,
  fetched_at   INTEGER NOT NULL,
  UNIQUE(feed_id, guid)
);
CREATE INDEX article_feed_pub ON article(feed_id, published_at DESC);

CREATE TABLE article_state (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  read       INTEGER NOT NULL DEFAULT 0,
  starred    INTEGER NOT NULL DEFAULT 0,
  read_at    INTEGER,
  UNIQUE(user_id, article_id)
);
CREATE INDEX article_state_user ON article_state(user_id, article_id);
