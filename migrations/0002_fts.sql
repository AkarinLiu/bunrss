-- trigram tokenizer: substring search + CJK, needs SQLite >= 3.34
-- (note: FTS5 option is `tokenize`, not `tokenizer`)
CREATE VIRTUAL TABLE article_fts USING fts5(
  title, content,
  content='article', content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER article_ai AFTER INSERT ON article BEGIN
  INSERT INTO article_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER article_ad AFTER DELETE ON article BEGIN
  INSERT INTO article_fts(article_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER article_au AFTER UPDATE OF title, content ON article BEGIN
  INSERT INTO article_fts(article_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO article_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
