import Parser from "rss-parser";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { db } from "./db";

const UA = "bunrss/1.0 (+https://github.com/)";
const parser = new Parser({ timeout: 15000, headers: { "user-agent": UA } });

export interface FeedRow {
  id: number;
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
}

const selectFeeds = db.query<FeedRow, []>(
  "SELECT id, feed_url, etag, last_modified FROM feed",
);
const selectDue = db.query<FeedRow, [number]>(
  "SELECT id, feed_url, etag, last_modified FROM feed WHERE last_fetched_at IS NULL OR last_fetched_at < ?",
);
const markFetched = db.query("UPDATE feed SET last_fetched_at = ? WHERE id = ?");
const setError = db.query("UPDATE feed SET last_error = ?, last_fetched_at = ? WHERE id = ?");

// Site-icon discovery state: NULL = not looked up yet, '' = looked up (fall back to /favicon.ico).
const selectIconState = db.query<{ icon_url: string | null; site_url: string | null; feed_url: string }, [number]>(
  "SELECT icon_url, site_url, feed_url FROM feed WHERE id = ?",
);
const setIconUrl = db.query("UPDATE feed SET icon_url = ? WHERE id = ?");

const upsertArticle = db.query(
  `INSERT INTO article (feed_id, guid, title, link, author, content, summary, published_at, fetched_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
   ON CONFLICT(feed_id, guid) DO UPDATE SET
     title = excluded.title, link = excluded.link, author = excluded.author,
     content = excluded.content, summary = excluded.summary, published_at = excluded.published_at`,
);
const updateFeedMeta = db.query(
  `UPDATE feed SET
     title           = COALESCE(title, ?1),
     site_url        = COALESCE(site_url, ?2),
     description     = COALESCE(description, ?3),
     last_fetched_at = ?4, etag = ?5, last_modified = ?6, last_error = NULL
   WHERE id = ?7`,
);

/** Fetches one feed with conditional GET, upserts articles. Returns number of items seen. */
export async function refreshFeed(feed: FeedRow): Promise<number> {
  const headers: Record<string, string> = { "user-agent": UA };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;

  let res: Response;
  try {
    res = await fetch(feed.feed_url, { headers, redirect: "follow" });
  } catch (e) {
    setError.run(`fetch: ${e instanceof Error ? e.message : String(e)}`, Date.now(), feed.id);
    return 0;
  }
  if (res.status === 304) {
    markFetched.run(Date.now(), feed.id);
    await ensureFeedIcon(feed.id, null);
    return 0;
  }
  if (!res.ok) {
    setError.run(`HTTP ${res.status}`, Date.now(), feed.id);
    return 0;
  }

  const parsed = await parser.parseString(await res.text()).catch((e: unknown) => {
    setError.run(`parse: ${e instanceof Error ? e.message : String(e)}`, Date.now(), feed.id);
    return null;
  });
  if (!parsed) return 0;

  const now = Date.now();
  let count = 0;
  db.transaction(() => {
    for (const raw of parsed.items ?? []) {
      const item = raw as Record<string, any>;
      const guid = String(item.guid ?? item.id ?? item.link ?? item.title ?? "").trim();
      if (!guid) continue;
      const pub = Date.parse(item.isoDate ?? "");
      upsertArticle.run(
        feed.id,
        guid,
        item.title ?? null,
        item.link ?? null,
        item.creator ?? item.author ?? null,
        item["content:encoded"] ?? item.content ?? null,
        item.contentSnippet ?? item.summary ?? null,
        Number.isFinite(pub) ? pub : now,
        now,
      );
      count++;
    }
  })();

  updateFeedMeta.run(
    parsed.title ?? null,
    parsed.link ?? null,
    parsed.description ?? null,
    now,
    res.headers.get("etag"),
    res.headers.get("last-modified"),
    feed.id,
  );
  await ensureFeedIcon(feed.id, parsed.link ?? null);
  return count;
}

export async function refreshAll(): Promise<void> {
  const feeds = selectFeeds.all();
  await Promise.allSettled(feeds.map((f) => refreshFeed(f)));
}

/** Refresh only feeds not fetched in the last `staleMs`, for the background cron. */
export async function refreshStale(staleMs: number): Promise<void> {
  const feeds = selectDue.all(Date.now() - staleMs);
  await Promise.allSettled(feeds.map((f) => refreshFeed(f)));
}

/** Downloads an article's page and swaps in Readability's extracted main content. */
export async function extractFullText(articleId: number): Promise<boolean> {
  const row = db.query<{ link: string | null }, [number]>("SELECT link FROM article WHERE id = ?").get(articleId);
  if (!row?.link) return false;
  const res = await fetch(row.link, { headers: { "user-agent": UA } });
  if (!res.ok) return false;
  const { document } = parseHTML(await res.text());
  const parsed = new Readability(document as unknown as Document).parse();
  if (!parsed?.content) return false;
  db.query("UPDATE article SET content = ? WHERE id = ?").run(parsed.content, articleId);
  return true;
}

// ---------------------------------------------------------------- feed discovery

export interface DiscoveredFeed {
  title: string;
  url: string;
}

const FEED_TYPE_RE = /(rss|atom|rdf|feed\+json)/i;
const MAX_HTML_BYTES = 1_500_000;

/** True when a fetched URL is itself a feed (by content type or by its opening markup). */
function isFeedDocument(contentType: string, body: string): boolean {
  if (FEED_TYPE_RE.test(contentType) || contentType.toLowerCase().includes("xml")) return true;
  return /^<\?xml|^<rss|^<feed|^<rdf:RDF/i.test(body.slice(0, 512).trimStart());
}

/** Reads at most `max` bytes, so a huge or slow page can't stall discovery. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) (merged.set(c, offset), (offset += c.length));
  return new TextDecoder().decode(merged);
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

const ICON_REL_RE = /\b(icon|apple-touch-icon)\b/i;

/** First site icon declared in an HTML <head> (`<link rel="icon">` etc.), resolved absolutely. */
function iconFromHtml(body: string, base: string): string | null {
  const headEnd = body.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? body.slice(0, headEnd) : body;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttrs(m[0]);
    if (!ICON_REL_RE.test(attrs.rel ?? "")) continue;
    const href = attrs.href;
    if (!href || href.startsWith("data:")) continue;
    try {
      return new URL(href, base).toString();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Looks a feed's site icon up once and stores it (`icon_url` NULL = "not looked up yet";
 * empty string = looked up, none declared). Transient failures leave NULL so a later refresh retries.
 */
async function ensureFeedIcon(feedId: number, siteUrlHint: string | null): Promise<void> {
  const state = selectIconState.get(feedId);
  if (!state || state.icon_url !== null) return;
  const base = state.site_url ?? siteUrlHint;
  if (!base) {
    setIconUrl.run("", feedId);
    return;
  }
  try {
    const res = await fetch(base, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return; // transient — retry on a later refresh
    setIconUrl.run(iconFromHtml(await readCapped(res, MAX_HTML_BYTES), res.url || base) ?? "", feedId);
  } catch {
    // network error: leave NULL to retry next time
  }
}

/**
 * Discovers feeds advertised by a web page (`<link rel="alternate">`), or accepts a feed URL directly.
 * Scans only `<head>` with a regex — a full DOM parse is far too slow on large pages.
 * Throws on an unreachable URL; returns [] when the page advertises no feeds.
 */
export async function discoverFeeds(input: string): Promise<DiscoveredFeed[]> {
  const res = await fetch(input, {
    headers: { "user-agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await readCapped(res, MAX_HTML_BYTES);
  const finalUrl = res.url || input;

  if (isFeedDocument(res.headers.get("content-type") ?? "", body)) {
    const parsed = await parser.parseString(body).catch(() => null);
    return [{ title: parsed?.title?.trim() || new URL(finalUrl).host, url: finalUrl }];
  }

  const headEnd = body.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? body.slice(0, headEnd) : body;
  const pageTitle = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim() || new URL(finalUrl).host;
  const feeds: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttrs(m[0]);
    if (!/\b(alternate|feed)\b/.test(attrs.rel?.toLowerCase() ?? "")) continue;
    const href = attrs.href;
    if (!href) continue;
    const type = attrs.type?.toLowerCase() ?? "";
    if (!FEED_TYPE_RE.test(type) && !/\.(rss|atom|xml)(\?|$)/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(href, finalUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    feeds.push({ title: attrs.title?.trim() || pageTitle, url });
  }
  return feeds;
}
