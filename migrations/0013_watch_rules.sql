-- Per-subscription watch rule: include words (existing watch_words), exclude words, and whether
-- every include word must appear ("all") or just one ("any"). Existing rows keep the old
-- behaviour: include-only, match any.
ALTER TABLE subscription ADD COLUMN watch_exclude TEXT;
ALTER TABLE subscription ADD COLUMN watch_mode TEXT NOT NULL DEFAULT 'any';
