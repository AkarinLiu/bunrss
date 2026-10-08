// Google Reader–compatible API (the "common subset" that Reeder, NetNewsWire,
// FeedMe, FreshRSS clients etc. speak). Auth is a per-user API token created in
// the admin console: clients log in with email + that token via ClientLogin and
// then send `Authorization: GoogleLogin auth=<token>`.
import { Hono } from "hono";
import { db } from "./db";
import { setArticleState, subscribe } from "./library";

type Env = { Variables: { userId: number; email: string; token: string } };

const READING_LIST = "user/-/state/com.google/reading-list";
const READ = "user/-/state/com.google/read";
const UNREAD = "user/-/state/com.google/unread";
const STARRED = "user/-/state/com.google/starred";
const TRACKING_READ = "user/-/state/com.google/tracking-read";

const now = () => Date.now();

// ---------------------------------------------------------------- auth

const selectToken = db.query<{ user_id: number; email: string; username: string | null }, [string]>(
  `SELECT t.user_id, u.email, u.username FROM api_token t JOIN user u ON u.id = t.user_id WHERE t.token = ?`,
);
const touchToken = db.query("UPDATE api_token SET last_used_at = ? WHERE token = ?");

function authUser(req: Request): { id: number; email: string; token: string } | null {
  const m = (req.headers.get("authorization") ?? "").match(/(?:GoogleLogin|Reader)\s+auth=([^\s,]+)/i);
  const token = m?.[1];
  if (!token) return null;
  const row = selectToken.get(token);
  if (!row) return null;
  touchToken.run(now(), token);
  return { id: row.user_id, email: row.email, token };
}

// ---------------------------------------------------------------- id helpers

const itemId = (id: number) => "tag:google.com,2005:reader/item/" + id.toString(16).padStart(16, "0");

function parseItemId(raw: string): number | null {
  const last = raw.slice(raw.lastIndexOf("/") + 1);
  // Item ids come in two forms: "short" signed base-10 and "long"
  // `tag:google.com,2005:reader/item/<16 hex, zero-padded>`. itemRefs emits short,
  // but every method accepts either. Ambiguity resolves the way FreshRSS does it:
  // all-digits (and not zero-padded) is decimal, anything else is hex.
  const n = /^[1-9]\d*$/.test(last) ? Number(last) : parseInt(last, 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * `ot`/`nt` are epoch seconds per the Google Reader spec. Some looser clients send
 * milliseconds or microseconds, so normalize to milliseconds before comparing.
 */
function timestampMs(v: number): number {
  return v >= 1e14 ? v / 1000 : v >= 1e11 ? v : v * 1000;
}

const labelId = (name: string) => "user/-/label/" + name;
const labelName = (streamId: string): string => {
  const i = streamId.indexOf("/label/");
  return i < 0 ? "" : decodeURIComponent(streamId.slice(i + "/label/".length));
};

async function form(req: Request): Promise<URLSearchParams> {
  const text = await req.text().catch(() => "");
  return new URLSearchParams(text);
}
/** GReader tags may use `user/<id>/...`; normalize to the `user/-/...` wildcard form. */
const normalizeTag = (t: string) => t.replace(/^user\/\d+\//, "user/-/");
const splitAll = (p: URLSearchParams, key: string): string[] =>
  p.getAll(key).flatMap((v) => v.split(",")).map((s) => normalizeTag(s.trim())).filter(Boolean);

// ---------------------------------------------------------------- stream query

interface StreamOpts {
  streamId: string;
  include: string[];
  exclude: string[];
  since?: number; // `ot`: only items newer than this (epoch seconds)
  until?: number; // `nt`: only items older than this (epoch seconds)
  limit: number;
  offset: number;
  order: "ASC" | "DESC";
}

/** Shared WHERE builder for stream/contents + stream/items/ids. */
function streamWhere(userId: number, o: StreamOpts): { clause: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const s = o.streamId;
  if (s.startsWith("feed/")) {
    where.push("f.feed_url = ?");
    params.push(s.slice("feed/".length));
  } else if (s.includes("/label/")) {
    where.push("sub.category_id = (SELECT id FROM category WHERE user_id = ? AND name = ?)");
    params.push(userId, labelName(s));
  } else if (s.endsWith("/starred")) {
    where.push("COALESCE(st.starred, 0) = 1");
  } else if (s.endsWith("/unread")) {
    where.push("COALESCE(st.read, 0) = 0");
  } else if (s.endsWith("/read")) {
    where.push("COALESCE(st.read, 0) = 1");
  }
  if (o.include.includes(STARRED)) where.push("COALESCE(st.starred, 0) = 1");
  if (o.include.includes(READ)) where.push("COALESCE(st.read, 0) = 1");
  if (o.include.includes(UNREAD)) where.push("COALESCE(st.read, 0) = 0");
  if (o.exclude.includes(STARRED)) where.push("COALESCE(st.starred, 0) = 0");
  if (o.exclude.includes(READ)) where.push("COALESCE(st.read, 0) = 0");
  if (o.since) {
    where.push("a.published_at >= ?");
    params.push(timestampMs(o.since));
  }
  if (o.until) {
    where.push("a.published_at <= ?");
    params.push(timestampMs(o.until));
  }
  return { clause: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

const FROM = `FROM article a
  JOIN feed f ON f.id = a.feed_id
  JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
  LEFT JOIN article_state st ON st.article_id = a.id AND st.user_id = ?`;

function streamOpts(c: { req: { query: (k: string) => string | undefined; queries: (k: string) => string[] | undefined } }, streamId: string): StreamOpts {
  const n = Number(c.req.query("n"));
  const ot = c.req.query("ot");
  const nt = c.req.query("nt");
  return {
    streamId,
    include: splitAllQuery(c.req.queries("it")),
    exclude: splitAllQuery(c.req.queries("xt")),
    since: ot ? Number(ot) : undefined,
    until: nt ? Number(nt) : undefined,
    // Google Reader allows up to 10,000; clients like Capy request the whole stream in one page.
    limit: Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 20,
    offset: Number(c.req.query("c")) > 0 ? Number(c.req.query("c")) : 0,
    order: c.req.query("r") === "o" ? "ASC" : "DESC",
  };
}

const splitAllQuery = (vals: string[] | undefined): string[] =>
  (vals ?? []).flatMap((v) => v.split(",")).map((s) => normalizeTag(s.trim())).filter(Boolean);

interface ItemRow {
  id: number;
  title: string | null;
  link: string | null;
  author: string | null;
  summary: string | null;
  content: string | null;
  published_at: number | null;
  fetched_at: number;
  feed_url: string;
  site_url: string | null;
  feed_title: string;
  read: number;
  starred: number;
}

function itemJson(a: ItemRow) {
  const ts = a.published_at ?? a.fetched_at;
  // Fluent Reader dereferences canonical[0].href unconditionally, so always emit one entry.
  const link = a.link ?? a.site_url ?? "";
  const body = a.content ?? a.summary ?? "";
  // clients derive read/starred state from these tags, so report both
  const categories: string[] = [];
  if (a.read) categories.push(READ);
  if (a.starred) categories.push(STARRED);
  return {
    id: itemId(a.id),
    crawlTimeMsec: String(a.fetched_at),
    timestampUsec: String(ts * 1000),
    published: Math.floor(ts / 1000),
    title: a.title ?? "",
    canonical: [{ href: link }],
    alternate: [{ href: link, type: "text/html" }],
    summary: { content: body, direction: "ltr" },
    content: { content: body, direction: "ltr" },
    author: a.author ?? "",
    origin: { streamId: "feed/" + a.feed_url, title: a.feed_title, htmlUrl: a.site_url ?? "" },
    categories,
  };
}

function categoryId(userId: number, name: string): number {
  return db
    .query<{ id: number }, [number, string, number]>(
      "INSERT INTO category (user_id, name, sort_order) VALUES (?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET name = name RETURNING id",
    )
    .get(userId, name, Date.now())!.id;
}

// ---------------------------------------------------------------- app

export const greader = new Hono<Env>();

greader.use("/reader/api/0/*", async (c, next) => {
  const u = authUser(c.req.raw);
  if (!u) return c.text("Unauthorized", 401);
  c.set("userId", u.id);
  c.set("email", u.email);
  c.set("token", u.token);
  await next();
});

// --- auth ---------------------------------------------------------------

async function clientLogin(c: any): Promise<Response> {
  const q = c.req.query();
  const body = c.req.method === "POST" ? await form(c.req.raw) : new URLSearchParams();
  const get = (k: string) => body.get(k) ?? q[k] ?? body.get(k.toLowerCase()) ?? q[k.toLowerCase()];
  const identifier = (get("Email") ?? "").trim().toLowerCase();
  const passwd = get("Passwd") ?? "";
  const row = selectToken.get(passwd);
  if (!row || (row.email.toLowerCase() !== identifier && (row.username ?? "").toLowerCase() !== identifier)) {
    return c.text("Error=BadAuthentication", 403);
  }
  touchToken.run(now(), passwd);
  return c.text(`SID=${passwd}\nLSID=${passwd}\nAuth=${passwd}\n`, 200, { "content-type": "text/plain" });
}
greader.post("/accounts/ClientLogin", clientLogin);
greader.get("/accounts/ClientLogin", clientLogin);
greader.post("/accounts/GoogleLogin", clientLogin);
greader.get("/accounts/GoogleLogin", clientLogin);

greader.get("/reader/api/0/token", (c) => c.text(c.get("token")));

greader.get("/reader/api/0/user-info", (c) => {
  const id = c.get("userId");
  const email = c.get("email");
  return c.json({ userId: String(id), userName: email, userProfileId: String(id), userEmail: email });
});

// --- subscriptions ------------------------------------------------------

greader.get("/reader/api/0/subscription/list", (c) => {
  const rows = db
    .query<any, [number]>(
      `SELECT f.feed_url, f.site_url, COALESCE(sub.custom_title, f.title, f.feed_url) AS title,
              sub.id AS sortid, c.name AS category_name,
              (SELECT MAX(a.published_at) FROM article a WHERE a.feed_id = f.id) AS newest
       FROM subscription sub JOIN feed f ON f.id = sub.feed_id
       LEFT JOIN category c ON c.id = sub.category_id
       WHERE sub.user_id = ? ORDER BY title COLLATE NOCASE`,
    )
    .all(c.get("userId"));
  return c.json({
    subscriptions: rows.map((r) => ({
      id: "feed/" + r.feed_url,
      title: r.title,
      url: r.feed_url,
      sortid: r.sortid.toString(16).padStart(8, "0"),
      htmlUrl: r.site_url ?? "",
      firstitemmsec: String(r.newest ?? 0),
      categories: r.category_name ? [{ id: labelId(r.category_name), label: r.category_name }] : [],
    })),
  });
});

greader.post("/reader/api/0/subscription/edit", async (c) => {
  const userId = c.get("userId");
  const p = await form(c.req.raw);
  const ac = p.get("ac") ?? "subscribe";
  const s = p.get("s") ?? "";
  const title = p.get("t");
  if (!s.startsWith("feed/")) return c.text("Bad stream id", 400);
  const url = s.slice("feed/".length);

  if (ac === "unsubscribe") {
    db.query("DELETE FROM subscription WHERE user_id = ? AND feed_id = (SELECT id FROM feed WHERE feed_url = ?)").run(userId, url);
    db.query("DELETE FROM feed WHERE feed_url = ? AND NOT EXISTS (SELECT 1 FROM subscription WHERE feed_id = feed.id)").run(url);
    return c.text("OK");
  }

  const addedLabel = splitAll(p, "a").find((x) => x.includes("/label/"));
  const removedLabel = splitAll(p, "r").find((x) => x.includes("/label/"));
  const catId = addedLabel ? categoryId(userId, labelName(addedLabel)) : removedLabel ? null : undefined;

  if (ac === "subscribe") {
    const res = subscribe(userId, url, catId ?? null, title ?? null);
    if ("error" in res) return c.text(res.error, res.status);
  }
  if (title !== null || catId !== undefined) {
    if (title !== null)
      db.query("UPDATE subscription SET custom_title = ? WHERE user_id = ? AND feed_id = (SELECT id FROM feed WHERE feed_url = ?)").run(
        title,
        userId,
        url,
      );
    if (catId !== undefined)
      db.query("UPDATE subscription SET category_id = ? WHERE user_id = ? AND feed_id = (SELECT id FROM feed WHERE feed_url = ?)").run(
        catId,
        userId,
        url,
      );
  }
  return c.text("OK");
});

greader.post("/reader/api/0/subscription/quickadd", async (c) => {
  const userId = c.get("userId");
  const p = await form(c.req.raw);
  const query = p.get("quickadd") ?? p.get("q") ?? "";
  if (!/^https?:\/\//i.test(query)) return c.json({ numResults: 0, query, streamId: null });
  const res = subscribe(userId, query, null, null);
  if ("error" in res) return c.text(res.error, res.status);
  return c.json({ numResults: 1, query, streamId: "feed/" + query });
});

// --- tags ---------------------------------------------------------------

greader.get("/reader/api/0/tag/list", (c) => {
  const userId = c.get("userId");
  const cats = db
    .query<{ name: string; unread: number }, [number, number, number]>(
      `SELECT c.name,
              (SELECT COUNT(*) FROM article a
                 JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
                 LEFT JOIN article_state st ON st.article_id = a.id AND st.user_id = ?
                 WHERE sub.category_id = c.id AND COALESCE(st.read, 0) = 0) AS unread
       FROM category c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE`,
    )
    .all(userId, userId, userId);
  // `type: "folder"` tells clients (Inoreader, Capy…) these are folders, not article tags.
  return c.json({
    tags: [{ id: STARRED }, { id: READING_LIST }, ...cats.map((x) => ({ id: labelId(x.name), type: "folder", unread_count: x.unread }))],
  });
});

// --- unread -------------------------------------------------------------

greader.get("/reader/api/0/unread-count", (c) => {
  const userId = c.get("userId");
  const feeds = db
    .query<{ feed_url: string; n: number; newest: number | null }, [number, number]>(
      `SELECT f.feed_url, COUNT(*) n, MAX(a.published_at) newest
       FROM article a
       JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
       JOIN feed f ON f.id = a.feed_id
       LEFT JOIN article_state st ON st.article_id = a.id AND st.user_id = ?
       WHERE COALESCE(st.read, 0) = 0 GROUP BY a.feed_id`,
    )
    .all(userId, userId);
  const labels = db
    .query<{ name: string; n: number; newest: number | null }, [number, number]>(
      `SELECT c.name, COUNT(*) n, MAX(a.published_at) newest
       FROM article a
       JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
       JOIN category c ON c.id = sub.category_id
       LEFT JOIN article_state st ON st.article_id = a.id AND st.user_id = ?
       WHERE COALESCE(st.read, 0) = 0 GROUP BY sub.category_id`,
    )
    .all(userId, userId);

  const total = feeds.reduce((n, f) => n + f.n, 0);
  const entry = (id: string, n: number, newest: number | null) => ({ id, count: n, newestItemTimestampUsec: String((newest ?? 0) * 1000) });
  return c.json({
    max: total,
    unreadcounts: [
      entry(READING_LIST, total, feeds.reduce<number | null>((m, f) => (f.newest && (!m || f.newest > m) ? f.newest : m), null)),
      ...feeds.map((f) => entry("feed/" + f.feed_url, f.n, f.newest)),
      ...labels.map((l) => entry(labelId(l.name), l.n, l.newest)),
    ],
  });
});

// --- stream contents ----------------------------------------------------

function contentsResponse(c: any, streamId: string): Response {
  const userId = c.get("userId");
  const o = streamOpts(c as any, streamId);
  const { clause, params } = streamWhere(userId, o);
  const rows = db
    .query<ItemRow, any[]>(
      `SELECT a.id, a.title, a.link, a.author, a.summary, a.content, a.published_at, a.fetched_at,
              f.feed_url, f.site_url, COALESCE(sub.custom_title, f.title, f.feed_url) AS feed_title,
              COALESCE(st.read, 0) AS read, COALESCE(st.starred, 0) AS starred
       ${FROM} ${clause}
       ORDER BY a.published_at ${o.order}, a.id ${o.order} LIMIT ? OFFSET ?`,
    )
    .all(userId, userId, ...params, o.limit + 1, o.offset);
  const hasMore = rows.length > o.limit;
  const items = (hasMore ? rows.slice(0, o.limit) : rows).map(itemJson);
  return c.json({
    id: streamId || READING_LIST,
    updated: Math.floor(now() / 1000),
    items,
    ...(hasMore ? { continuation: String(o.offset + o.limit) } : {}),
  });
}

greader.get("/reader/api/0/stream/contents", (c) => contentsResponse(c, c.req.query("s") || READING_LIST));
greader.get("/reader/api/0/stream/contents/*", (c) => {
  // pathname keeps percent-encoding and includes the mount prefix, so locate the id by marker
  const path = new URL(c.req.url).pathname;
  const marker = "/stream/contents/";
  return contentsResponse(c, decodeURIComponent(path.slice(path.indexOf(marker) + marker.length)));
});

// POST (and GET) with repeated `i=` item ids — how RSS Guard fetches article bodies.
function itemsContents(c: any, p: URLSearchParams): Response {
  const userId = c.get("userId");
  const ids = p
    .getAll("i")
    .map(parseItemId)
    .filter((n): n is number => n !== null);
  const updated = Math.floor(now() / 1000);
  if (!ids.length) return c.json({ id: READING_LIST, updated, items: [] });
  const order = c.req.query("r") === "o" ? "ASC" : "DESC";
  const marks = ids.map(() => "?").join(",");
  const rows = db
    .query<ItemRow, any[]>(
      `SELECT a.id, a.title, a.link, a.author, a.summary, a.content, a.published_at, a.fetched_at,
              f.feed_url, f.site_url, COALESCE(sub.custom_title, f.title, f.feed_url) AS feed_title,
              COALESCE(st.read, 0) AS read, COALESCE(st.starred, 0) AS starred
       ${FROM} WHERE a.id IN (${marks}) ORDER BY a.published_at ${order}`,
    )
    .all(userId, userId, ...ids);
  return c.json({ id: READING_LIST, updated, items: rows.map(itemJson) });
}
greader.post("/reader/api/0/stream/items/contents", async (c) => itemsContents(c, await form(c.req.raw)));
greader.get("/reader/api/0/stream/items/contents", (c) => itemsContents(c, new URLSearchParams(new URL(c.req.url).search)));

greader.get("/reader/api/0/stream/items/ids", (c) => {
  const userId = c.get("userId");
  const o = streamOpts(c as any, c.req.query("s") || READING_LIST);
  const { clause, params } = streamWhere(userId, o);
  const rows = db
    .query<{ id: number; published_at: number | null; fetched_at: number; feed_url: string }, any[]>(
      `SELECT a.id, a.published_at, a.fetched_at, f.feed_url ${FROM} ${clause}
       ORDER BY a.published_at ${o.order}, a.id ${o.order} LIMIT ? OFFSET ?`,
    )
    .all(userId, userId, ...params, o.limit + 1, o.offset);
  const hasMore = rows.length > o.limit;
  // `id` is the spec's "short" signed base-10 form; clients convert it to the long form
  // themselves before calling stream/items/contents. Emitting the long form here breaks Capy.
  const itemRefs = (hasMore ? rows.slice(0, o.limit) : rows).map((r) => ({
    id: String(r.id),
    timestampUsec: String((r.published_at ?? r.fetched_at) * 1000),
    directStreamIds: ["feed/" + r.feed_url],
  }));
  return c.json({ itemRefs, ...(hasMore ? { continuation: String(o.offset + o.limit) } : {}) });
});

// --- article state ------------------------------------------------------

greader.post("/reader/api/0/edit-tag", async (c) => {
  const userId = c.get("userId");
  const p = await form(c.req.raw);
  const ids = p
    .getAll("i")
    .map(parseItemId)
    .filter((n): n is number => n !== null);
  const add = splitAll(p, "a");
  const remove = splitAll(p, "r");
  const read = add.includes(READ) || add.includes(TRACKING_READ) ? true : remove.includes(READ) || remove.includes(TRACKING_READ) ? false : undefined;
  const starred = add.includes(STARRED) ? true : remove.includes(STARRED) ? false : undefined;
  for (const id of ids) {
    const failure = setArticleState(userId, id, { read, starred });
    if (failure) return c.text(failure.error, failure.status);
  }
  return c.text("OK");
});

greader.post("/reader/api/0/mark-all-as-read", async (c) => {
  const userId = c.get("userId");
  const p = await form(c.req.raw);
  const s = p.get("s") ?? "";
  const ts = p.get("ts") ? timestampMs(Number(p.get("ts"))) : null;
  const feedUrl = s.startsWith("feed/") ? s.slice("feed/".length) : null;
  const label = s.includes("/label/") ? labelName(s) : null;
  db.query(
    `INSERT INTO article_state (user_id, article_id, read, read_at)
     SELECT ?1, a.id, 1, ?2
     FROM article a JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?1
     WHERE (?3 IS NULL OR a.feed_id = (SELECT id FROM feed WHERE feed_url = ?3))
       AND (?4 IS NULL OR sub.category_id = (SELECT id FROM category WHERE user_id = ?1 AND name = ?4))
       AND (?5 IS NULL OR a.published_at <= ?5)
     ON CONFLICT(user_id, article_id) DO UPDATE SET read = 1, read_at = excluded.read_at`,
  ).run(userId, now(), feedUrl, label, ts);
  return c.text("OK");
});
