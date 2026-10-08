import { db } from "./db";
import { getLimit } from "./settings";
import { translate, type Locale } from "./i18n";

/** A rejected operation: `status` is the HTTP status the route should return. */
export interface Failure {
  error: string;
  status: number;
}

export function countSubscriptions(userId: number): number {
  return db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM subscription WHERE user_id = ?").get(userId)!.n;
}

export function countStarred(userId: number): number {
  return db
    .query<{ n: number }, [number]>("SELECT COUNT(*) n FROM article_state WHERE user_id = ? AND starred = 1")
    .get(userId)!.n;
}

/**
 * Adds a subscription, enforcing the instance limit. Idempotent: re-subscribing to a feed
 * already in the library is a no-op and never counts against the limit.
 * Used by both the /api/feeds route and OPML import so the limit has exactly one guard.
 */
export function subscribe(
  userId: number,
  url: string,
  categoryId: number | null,
  title?: string | null,
  locale: Locale = "zh-CN",
): { feedId: number; created: boolean } | Failure {
  db.query("INSERT OR IGNORE INTO feed (feed_url, title) VALUES (?, ?)").run(url, title ?? null);
  const feed = db.query<{ id: number }, [string]>("SELECT id FROM feed WHERE feed_url = ?").get(url)!;

  const already =
    db.query<{ n: number }, [number, number]>("SELECT COUNT(*) n FROM subscription WHERE user_id = ? AND feed_id = ?").get(
      userId,
      feed.id,
    )!.n > 0;
  if (already) return { feedId: feed.id, created: false };

  const max = getLimit("max_subscriptions");
  if (max > 0 && countSubscriptions(userId) >= max) {
    return { error: translate(locale, "library.subscriptionLimit", { max }), status: 409 };
  }
  db.query("INSERT INTO subscription (user_id, feed_id, category_id, created_at) VALUES (?, ?, ?, ?)").run(
    userId,
    feed.id,
    categoryId,
    Date.now(),
  );
  return { feedId: feed.id, created: true };
}

/** True when the article belongs to a feed the user is subscribed to. */
function ownsArticle(userId: number, articleId: number): boolean {
  const row = db
    .query<{ n: number }, [number, number]>(
      `SELECT COUNT(*) n FROM article a
       JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
       WHERE a.id = ?`,
    )
    .get(userId, articleId);
  return !!row && row.n > 0;
}

/** Sets read/starred for an article, enforcing the star limit. Returns null on success. */
export function setArticleState(
  userId: number,
  articleId: number,
  patch: { read?: boolean; starred?: boolean },
  locale: Locale = "zh-CN",
): Failure | null {
  if (!ownsArticle(userId, articleId)) return { error: "not found", status: 404 };

  // only block *new* stars, so unstarring whatever is already over the limit still works
  if (patch.starred === true) {
    const current = db
      .query<{ starred: number }, [number, number]>(
        "SELECT starred FROM article_state WHERE user_id = ? AND article_id = ?",
      )
      .get(userId, articleId);
    if ((current?.starred ?? 0) === 0) {
      const max = getLimit("max_starred");
      if (max > 0 && countStarred(userId) >= max)
        return { error: translate(locale, "library.starLimit", { max }), status: 409 };
    }
  }

  db.query(
    `INSERT INTO article_state (user_id, article_id, read, starred, read_at)
     VALUES (?1, ?2, COALESCE(?3, 0), COALESCE(?4, 0), ?5)
     ON CONFLICT(user_id, article_id) DO UPDATE SET
       read    = COALESCE(?3, read),
       starred = COALESCE(?4, starred),
       read_at = CASE WHEN ?3 IS NOT NULL THEN ?5 ELSE read_at END`,
  ).run(
    userId,
    articleId,
    patch.read === undefined ? null : patch.read ? 1 : 0,
    patch.starred === undefined ? null : patch.starred ? 1 : 0,
    patch.read ? Date.now() : null,
  );
  return null;
}

// ---------------------------------------------------------------- tags

export interface Tag {
  id: number;
  name: string;
}

const TAG_NAME_MAX = 32;

/** Tags for the sidebar, each with how many of the user's articles carry it and how many are unread. */
export function listTags(userId: number): (Tag & { count: number; unread: number })[] {
  return db
    .query<Tag & { count: number; unread: number }, [number]>(
      `SELECT t.id, t.name,
              (SELECT COUNT(*) FROM article_tag at WHERE at.tag_id = t.id) AS count,
              (SELECT COUNT(*) FROM article_tag at
                 LEFT JOIN article_state s ON s.article_id = at.article_id AND s.user_id = at.user_id
                 WHERE at.tag_id = t.id AND COALESCE(s.read, 0) = 0) AS unread
       FROM tag t WHERE t.user_id = ? ORDER BY t.name COLLATE NOCASE`,
    )
    .all(userId);
}

function tagByName(userId: number, name: string): Tag | undefined {
  return (
    db
      .query<Tag, [number, string]>("SELECT id, name FROM tag WHERE user_id = ? AND name = ? COLLATE NOCASE")
      .get(userId, name) ?? undefined
  );
}

/** Creates (or returns the existing) tag for a user. Idempotent, case-insensitive. Used by the tag routes. */
export function createTag(userId: number, name: string, locale: Locale = "zh-CN"): Tag | Failure {
  name = name.trim();
  if (!name) return { error: translate(locale, "library.tagNameEmpty"), status: 400 };
  if (name.length > TAG_NAME_MAX) return { error: translate(locale, "library.tagNameTooLong", { max: TAG_NAME_MAX }), status: 400 };
  return (
    tagByName(userId, name) ??
    db
      .query<Tag, [number, string, number]>("INSERT INTO tag (user_id, name, created_at) VALUES (?, ?, ?) RETURNING id, name")
      .get(userId, name, Date.now())!
  );
}

export function renameTag(userId: number, id: number, name: string, locale: Locale = "zh-CN"): Failure | null {
  name = name.trim();
  if (!name) return { error: translate(locale, "library.tagNameEmpty"), status: 400 };
  if (name.length > TAG_NAME_MAX) return { error: translate(locale, "library.tagNameTooLong", { max: TAG_NAME_MAX }), status: 400 };
  const clash = db
    .query<{ n: number }, [number, string, number]>(
      "SELECT COUNT(*) n FROM tag WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?",
    )
    .get(userId, name, id)!;
  if (clash.n > 0) return { error: translate(locale, "library.tagExists"), status: 409 };
  const res = db.query("UPDATE tag SET name = ? WHERE id = ? AND user_id = ?").run(name, id, userId);
  return res.changes === 0 ? { error: "not found", status: 404 } : null;
}

export function deleteTag(userId: number, id: number): void {
  db.query("DELETE FROM tag WHERE id = ? AND user_id = ?").run(id, userId);
}

/** Tags currently on an article, alphabetically. */
export function articleTags(userId: number, articleId: number): Tag[] {
  return db
    .query<Tag, [number, number]>(
      `SELECT t.id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id
       WHERE at.user_id = ? AND at.article_id = ? ORDER BY t.name COLLATE NOCASE`,
    )
    .all(userId, articleId);
}

/**
 * Attaches a tag to an article. `ref` is either an existing tag id or a name to create-on-demand.
 * Returns the tag (so the client can render it) or a Failure.
 */
export function addArticleTag(
  userId: number,
  articleId: number,
  ref: { tagId: number } | { name: string },
  locale: Locale = "zh-CN",
): Tag | Failure {
  if (!ownsArticle(userId, articleId)) return { error: "not found", status: 404 };
  let tag: Tag | undefined;
  if ("tagId" in ref) {
    tag = db.query<Tag, [number, number]>("SELECT id, name FROM tag WHERE id = ? AND user_id = ?").get(ref.tagId, userId) ?? undefined;
    if (!tag) return { error: translate(locale, "library.tagNotFound"), status: 404 };
  } else {
    const created = createTag(userId, ref.name, locale);
    if ("error" in created) return created;
    tag = created;
  }
  db.query("INSERT OR IGNORE INTO article_tag (user_id, article_id, tag_id) VALUES (?, ?, ?)").run(
    userId,
    articleId,
    tag.id,
  );
  return tag;
}

export function removeArticleTag(userId: number, articleId: number, tagId: number): void {
  db.query("DELETE FROM article_tag WHERE user_id = ? AND article_id = ? AND tag_id = ?").run(userId, articleId, tagId);
}
