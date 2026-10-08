// Article/feed data migration. Handles the formats the popular self-hosted readers
// emit, so a user can move subscriptions, read/starred state and labels into bunrss:
//
//   - OPML                       subscriptions (also FreshRSS's `.opml.xml`)
//   - Google Reader JSON         articles: FreshRSS "favourite"/"labelled" export,
//                                Tiny Tiny RSS via the `export_ttrss` tool, our own export
//   - ZIP                        FreshRSS's combined export (OPML + JSON) and the
//                                tt-rss `data_migration` plugin ({articles:[…]} batches)
//
// Everything routes through subscribe() / setArticleState() / addArticleTag(), so the
// instance quota guards stay in one place (server/library.ts).
import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { db } from "./db";
import { addArticleTag, setArticleState, subscribe, type Failure } from "./library";
import { translate, type Locale } from "./i18n";

const READING_LIST = "user/-/state/com.google/reading-list";
const READ = "user/-/state/com.google/read";
const UNREAD = "user/-/state/com.google/unread";
const STARRED = "user/-/state/com.google/starred";

/** GReader categories may be namespaced with a user id (`user/123/...`); normalize to the wildcard form. */
const normalize = (t: string) => t.replace(/^user\/\d+\//, "user/-/");
const labelName = (t: string) => t.slice(t.indexOf("/label/") + "/label/".length).trim();

/** Counters shared by every import entry point. `feeds` counts newly created subscriptions. */
export interface ImportResult {
  feeds: number;
  articles: number; // article rows inserted
  states: number; // read/starred flags applied
  tags: number; // labels attached as tags
  skipped: number; // items or steps dropped (no feed/guid, quota, bad label)
}

const emptyResult = (): ImportResult => ({ feeds: 0, articles: 0, states: 0, tags: 0, skipped: 0 });
const addResult = (into: ImportResult, r: ImportResult) => {
  into.feeds += r.feeds;
  into.articles += r.articles;
  into.states += r.states;
  into.tags += r.tags;
  into.skipped += r.skipped;
};

// ---------------------------------------------------------------- export

/**
 * The user's articles that carry state: read, starred, or tagged. Exporting every
 * article would be pointless — an article with no state row is implicitly unread
 * and will reappear from the feed. Matches FreshRSS's "starred or labelled" scope,
 * extended with read state.
 */
export function exportArticles(userId: number, author: string) {
  const rows = db
    .query<any, [number, number, number]>(
      `SELECT a.id, a.guid, a.title, a.link, a.author, a.content, a.summary, a.published_at, a.fetched_at,
              f.feed_url, f.site_url, COALESCE(sub.custom_title, f.title, f.feed_url) AS feed_title,
              COALESCE(s.read, 0) AS read, COALESCE(s.starred, 0) AS starred
       FROM article a
       JOIN feed f ON f.id = a.feed_id
       JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
       LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = ?
       WHERE s.id IS NOT NULL
          OR EXISTS (SELECT 1 FROM article_tag at WHERE at.article_id = a.id AND at.user_id = ?)
       ORDER BY a.published_at`,
    )
    .all(userId, userId, userId);

  const tags = new Map<number, string[]>();
  for (const r of db
    .query<{ article_id: number; name: string }, [number]>(
      `SELECT at.article_id, t.name FROM article_tag at JOIN tag t ON t.id = at.tag_id
       WHERE at.user_id = ? ORDER BY t.name COLLATE NOCASE`,
    )
    .all(userId)) {
    const list = tags.get(r.article_id);
    if (list) list.push(r.name);
    else tags.set(r.article_id, [r.name]);
  }

  return {
    id: READING_LIST,
    title: `bunrss/${author}`,
    author,
    items: rows.map((a) => {
      const ts = a.published_at ?? a.fetched_at;
      const href = a.link ?? "";
      const categories = [READING_LIST, a.read ? READ : UNREAD];
      if (a.starred) categories.push(STARRED);
      for (const name of tags.get(a.id) ?? []) categories.push("user/-/label/" + name);
      return {
        guid: a.guid,
        id: "tag:google.com,2005:reader/item/" + (a.id as number).toString(16).padStart(16, "0"),
        published: Math.floor(ts / 1000),
        timestampUsec: String(ts * 1000),
        title: a.title ?? "",
        author: a.author ?? "",
        content: { content: a.content ?? a.summary ?? "" },
        alternate: [{ href, type: "text/html" }],
        canonical: [{ href }],
        origin: { streamId: "feed/" + a.feed_url, title: a.feed_title, htmlUrl: a.site_url ?? "", feedUrl: a.feed_url },
        categories,
      };
    }),
  };
}

// ---------------------------------------------------------------- OPML import

/** Parses an OPML subscription list and subscribes the user. Idempotent, quota-guarded. */
export function importOpml(userId: number, xml: string, locale: Locale = "zh-CN"): { imported: number; skipped: number } {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
  const outlines: { url: string; title: string | null; categoryId: number | null }[] = [];
  const walk = (nodes: any[], categoryId: number | null) => {
    for (const node of nodes ?? []) {
      const hasUrl = node?.["@_xmlUrl"];
      if (hasUrl) {
        outlines.push({ url: String(hasUrl), title: node["@_title"] ?? node["@_text"] ?? null, categoryId });
      } else if (node?.outline) {
        const name = node["@_title"] ?? node["@_text"];
        let cid = categoryId;
        if (name) {
          cid = db
            .query<{ id: number }, [number, string, number]>(
              "INSERT INTO category (user_id, name, sort_order) VALUES (?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET name = name RETURNING id",
            )
            .get(userId, String(name), Date.now())!.id;
        }
        walk(Array.isArray(node.outline) ? node.outline : [node.outline], cid);
      }
    }
  };
  const body = doc?.opml?.body?.outline;
  walk(Array.isArray(body) ? body : body ? [body] : [], null);

  let imported = 0;
  let skipped = 0;
  for (const o of outlines) {
    const added = subscribe(userId, o.url, o.categoryId, o.title, locale);
    if ("error" in added) skipped++;
    else if (added.created) imported++;
  }
  return { imported, skipped };
}

// ---------------------------------------------------------------- article import

function feedUrlOf(item: any): string | null {
  const o = item?.origin ?? {};
  if (typeof o.feedUrl === "string" && o.feedUrl.trim()) return o.feedUrl.trim();
  // GReader clients commonly use `feed/<url>` as the stream id
  const sid = typeof o.streamId === "string" ? o.streamId : "";
  return sid.startsWith("feed/http") ? sid.slice("feed/".length) : null;
}

function linkOf(item: any): string | null {
  const alt = item?.alternate?.[0]?.href ?? item?.canonical?.[0]?.href;
  if (typeof alt === "string" && alt) return alt;
  return typeof item?.url === "string" && item.url ? item.url : null;
}

function contentOf(item: any): string {
  for (const c of [item?.content, item?.summary]) {
    if (typeof c === "string") return c;
    if (c && typeof c.content === "string") return c.content;
  }
  return "";
}

/** Accepts unix seconds/milliseconds/microseconds (number or numeric string) and parseable date strings. */
function publishedAt(item: any): number {
  const raw = item?.published ?? item?.updated ?? item?.timestampUsec ?? item?.crawlTimeMsec;
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) {
    const n = Number(raw);
    if (n > 1e15) return Math.floor(n / 1000); // microseconds
    if (n > 1e11) return Math.floor(n); // milliseconds
    return Math.floor(n * 1000); // seconds
  }
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** tt-rss `data_migration` batch rows are flat; map them onto the neutral item shape. */
function ttrssItem(a: any): any {
  const categories: string[] = [];
  if (a?.marked) categories.push(STARRED);
  categories.push(a?.unread ? UNREAD : READ);
  if (typeof a?.label_cache === "string") {
    try {
      const labels = JSON.parse(a.label_cache);
      if (Array.isArray(labels)) {
        for (const l of labels) if (Array.isArray(l) && typeof l[1] === "string") categories.push("user/-/label/" + l[1]);
      }
    } catch {
      // a broken label cache shouldn't sink the whole import
    }
  }
  return {
    guid: a?.guid,
    title: a?.title,
    author: a?.author,
    content: a?.content,
    link: a?.link,
    published: a?.updated,
    origin: { feedUrl: a?.feed_url, title: a?.feed_title },
    categories,
  };
}

/** Accepts a bare array, `{items:[…]}` (neutral) or `{articles:[…]}` (tt-rss data_migration). */
function itemsFromParsed(parsed: any): any[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.articles)) return parsed.articles.map(ttrssItem);
  return null;
}

const insertArticle = db.query(
  `INSERT INTO article (feed_id, guid, title, link, author, content, summary, published_at, fetched_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)
   ON CONFLICT(feed_id, guid) DO NOTHING`,
);
const selectArticle = db.query<{ id: number }, [number, string]>("SELECT id FROM article WHERE feed_id = ? AND guid = ?");

/**
 * Applies parsed items to a user. Missing feeds are subscribed (respecting the
 * subscription limit) and missing articles are written with the content from the file,
 * so favourites older than the feed's current window survive.
 */
export function importItems(userId: number, items: any[], locale: Locale = "zh-CN"): ImportResult {
  const result = emptyResult();
  const feedCache = new Map<string, number | null>();
  const catCache = new Map<string, number>();
  const now = Date.now();

  const ensureCategory = (name: string): number => {
    const hit = catCache.get(name);
    if (hit) return hit;
    const row = db
      .query<{ id: number }, [number, string, number]>(
        "INSERT INTO category (user_id, name, sort_order) VALUES (?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET name = name RETURNING id",
      )
      .get(userId, name, now)!;
    catCache.set(name, row.id);
    return row.id;
  };

  db.transaction(() => {
    for (const item of items) {
      if (!item || typeof item !== "object") {
        result.skipped++;
        continue;
      }
      const feedUrl = feedUrlOf(item);
      const guid = String(item.guid ?? item.id ?? linkOf(item) ?? item.title ?? "").trim();
      if (!feedUrl || !guid) {
        result.skipped++;
        continue;
      }

      let feedId = feedCache.get(feedUrl);
      if (feedId === undefined) {
        const origin = item.origin ?? {};
        // tt-rss exports carry the feed's category; FreshRSS's don't (OPML handles those).
        const catName = typeof origin.category === "string" ? origin.category.trim() : "";
        const added = subscribe(
          userId,
          feedUrl,
          catName ? ensureCategory(catName) : null,
          typeof origin.title === "string" ? origin.title : null,
          locale,
        );
        if ("error" in added) {
          feedId = null;
        } else {
          feedId = added.feedId;
          if (added.created) result.feeds++;
        }
        feedCache.set(feedUrl, feedId);
      }
      if (feedId === null) {
        result.skipped++;
        continue;
      }

      const title = typeof item.title === "string" && item.title ? item.title : guid;
      const author = typeof item.author === "string" ? item.author : null;
      if (
        insertArticle.run(feedId, guid, title, linkOf(item), author, contentOf(item), publishedAt(item), now).changes > 0
      ) {
        result.articles++;
      }
      const articleId = selectArticle.get(feedId, guid)!.id;

      let read: boolean | undefined;
      let starred: boolean | undefined;
      const labels: string[] = [];
      for (const raw of Array.isArray(item.categories) ? item.categories : []) {
        if (typeof raw !== "string") continue;
        const t = normalize(raw);
        if (t === READ) read = true;
        else if (t === UNREAD) read = false;
        else if (t === STARRED) starred = true;
        else if (t.includes("/label/")) {
          const name = labelName(t);
          if (name) labels.push(name);
        }
      }

      if (read !== undefined || starred !== undefined) {
        if (setArticleState(userId, articleId, { read, starred }, locale)) result.skipped++;
        else result.states++;
      }
      for (const name of labels) {
        if ("error" in addArticleTag(userId, articleId, { name }, locale)) result.skipped++;
        else result.tags++;
      }
    }
  })();

  return result;
}

/** JSON entry point. */
export function importArticles(userId: number, text: string, locale: Locale = "zh-CN"): ImportResult | Failure {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: translate(locale, "import.badJson"), status: 400 };
  }
  const items = itemsFromParsed(parsed);
  if (!items?.length) return { error: translate(locale, "import.empty"), status: 400 };
  return importItems(userId, items, locale);
}

// ---------------------------------------------------------------- zip

// ponytail: whole archive is held in memory; capped so a ZIP bomb can't OOM the process.
const ZIP_MAX_ENTRIES = 500;
const ZIP_MAX_MEMBER_BYTES = 64 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Minimal ZIP reader: central directory → local headers → raw inflate. Returns file entries only. */
function unzip(buf: Uint8Array): { name: string; data: Uint8Array }[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End Of Central Directory: scan back over the (possibly commented) tail.
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");

  const entries: { name: string; data: Uint8Array }[] = [];
  const count = dv.getUint16(eocd + 10, true);
  const decoder = new TextDecoder();
  let p = dv.getUint32(eocd + 16, true);
  let total = 0;

  for (let n = 0; n < count && n < ZIP_MAX_ENTRIES; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || uncompSize > ZIP_MAX_MEMBER_BYTES || total + uncompSize > ZIP_MAX_TOTAL_BYTES) continue;
    // sizes come from the central directory, so a streaming (bit-3) local header is fine
    const dataStart = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      // maxOutputLength guards against a declared size that under-reports the real expansion
      const data =
        method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: ZIP_MAX_TOTAL_BYTES - total }) : null;
      if (!data) continue;
      total += data.length;
      entries.push({ name, data });
    } catch {
      // a corrupt member is skipped; the rest of the archive still imports
    }
  }
  return entries;
}

/**
 * ZIP entry point. Walks every member and dispatches by extension:
 * `.opml`/`.xml` → OPML subscriptions, `.json` → articles (neutral or tt-rss batch).
 */
export function importArchive(userId: number, bytes: Uint8Array, locale: Locale = "zh-CN"): ImportResult | Failure {
  let entries: { name: string; data: Uint8Array }[];
  try {
    entries = unzip(bytes);
  } catch {
    return { error: translate(locale, "import.badZip"), status: 400 };
  }
  const decoder = new TextDecoder();
  const result = emptyResult();
  let handled = 0;

  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".opml") || lower.endsWith(".xml")) {
      const opml = importOpml(userId, decoder.decode(entry.data), locale);
      result.feeds += opml.imported;
      result.skipped += opml.skipped;
      handled++;
    } else if (lower.endsWith(".json")) {
      try {
        const items = itemsFromParsed(JSON.parse(decoder.decode(entry.data)));
        if (items?.length) {
          addResult(result, importItems(userId, items, locale));
          handled++;
        }
      } catch {
        // skip non-JSON / malformed members
      }
    }
  }

  if (!handled) return { error: translate(locale, "import.empty"), status: 400 };
  return result;
}
