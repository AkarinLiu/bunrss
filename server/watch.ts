import { db } from "./db";
import { mailEnabled, sendMail, watchNotificationEmail } from "./mail";

/** The parts of a freshly inserted article the matcher looks at. */
export interface WatchArticle {
  id: number;
  title: string | null;
  link: string | null;
  summary: string | null;
  content: string | null;
}

const MAX_WORDS = 20;
const MAX_WORD_LENGTH = 64;

/** "rust, 数据库、SQLite" -> ["rust", "数据库", "SQLite"]. Spaces inside a word are kept
 * (e.g. "machine learning"); only commas/semicolons separate words. */
export function parseWatchWords(raw: string | null | undefined): string[] {
  const words = (raw ?? "")
    .split(/[,，、;；]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .map((w) => w.slice(0, MAX_WORD_LENGTH));
  return [...new Set(words)];
}

export type WatchMode = "any" | "all";

export interface WatchRule {
  include: string[];
  exclude: string[];
  mode: WatchMode;
}

/** Article text the rule matches against: HTML stripped, lower-cased once per article. */
function articleText(article: WatchArticle): string {
  return [article.title, article.summary, article.content]
    .filter(Boolean)
    .join("\n")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase();
}

/**
 * Applies one subscription's rule. Returns the include words that hit (for the notification
 * copy), or null when the article must not notify: no include hit, an "all" rule with a missing
 * include word, or any exclude word present.
 */
export function matchWatchRule(rule: WatchRule, article: WatchArticle): string[] | null {
  if (!rule.include.length) return null;
  const text = articleText(article);
  const hits = rule.include.filter((w) => text.includes(w.toLowerCase()));
  if (!hits.length) return null;
  if (rule.mode === "all" && hits.length !== rule.include.length) return null;
  if (rule.exclude.some((w) => text.includes(w.toLowerCase()))) return null;
  return hits;
}

interface RuleRow {
  user_id: number;
  email: string;
  include_words: string;
  exclude_words: string | null;
  mode: string | null;
}

const insertNotification = db.query(
  `INSERT OR IGNORE INTO notification (user_id, feed_id, article_id, title, link, matched, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
);

/**
 * Called after a feed refresh with only the *newly inserted* articles. Applies every rule of
 * every subscriber; writes one in-app notification per matched article and, when SMTP is
 * configured, one summary email per user/feed. Email is fire-and-forget: a slow mail server
 * must not hold up feed refreshing.
 */
export async function notifyWatchWords(feedId: number, articles: WatchArticle[]): Promise<void> {
  if (!articles.length) return;

  const rows = db
    .query<RuleRow, [number]>(
      `SELECT s.user_id, u.email, wr.include_words, wr.exclude_words, wr.mode
         FROM watch_rule wr
         JOIN subscription s ON s.id = wr.subscription_id
         JOIN user u ON u.id = s.user_id
        WHERE s.feed_id = ?`,
    )
    .all(feedId);
  if (!rows.length) return;

  // group rules by user so one user/feed refresh sends at most one email
  const byUser = new Map<number, { email: string; rules: WatchRule[] }>();
  for (const row of rows) {
    const group = byUser.get(row.user_id) ?? { email: row.email, rules: [] };
    group.rules.push({
      include: parseWatchWords(row.include_words),
      exclude: parseWatchWords(row.exclude_words),
      mode: row.mode === "all" ? "all" : "any",
    });
    byUser.set(row.user_id, group);
  }

  const feed = db
    .query<{ title: string | null; feed_url: string }, [number]>("SELECT title, feed_url FROM feed WHERE id = ?")
    .get(feedId);
  const feedTitle = feed?.title || feed?.feed_url || "bunrss";

  const now = Date.now();
  const canMail = mailEnabled();

  for (const [userId, group] of byUser) {
    const hits = articles.flatMap((article) => {
      const matched = new Set<string>();
      for (const rule of group.rules) for (const word of matchWatchRule(rule, article) ?? []) matched.add(word);
      return matched.size ? [{ article, matched: [...matched].join(", ") }] : [];
    });
    if (!hits.length) continue;

    db.transaction(() => {
      for (const hit of hits)
        insertNotification.run(userId, feedId, hit.article.id, hit.article.title, hit.article.link, hit.matched, now);
    })();

    if (canMail) {
      const { subject, text, html } = watchNotificationEmail(
        feedTitle,
        hits.map((h) => ({ title: h.article.title, link: h.article.link, matched: h.matched })),
      );
      void sendMail(group.email, subject, text, html).catch((e) =>
        console.error("[mail] watch notification failed:", e),
      );
    }
  }
}
