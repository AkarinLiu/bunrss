-- Per-user article tags (free-form labels). Deletion cascades from user / article / tag.
-- Names are unique per user, case-insensitively, so "Work" and "work" are the same tag.
CREATE TABLE tag (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name COLLATE NOCASE)
);

CREATE TABLE article_tag (
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, article_id, tag_id)
);
CREATE INDEX article_tag_tag ON article_tag(tag_id);
