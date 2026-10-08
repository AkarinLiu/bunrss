import { Hono } from "hono";
import { db } from "./db";
import { adminCreateUser, currentUser, login, logout, needsSetup, register, setUsername, setupAdmin, type User } from "./auth";
import { err, json, readJson } from "./http";
import { discoverFeeds, extractFullText, refreshAll, refreshFeed, refreshStale } from "./fetcher";
import {
  addArticleTag,
  articleTags,
  countStarred,
  countSubscriptions,
  createTag,
  deleteTag,
  listTags,
  removeArticleTag,
  renameTag,
  setArticleState,
  subscribe,
} from "./library";
import { adminSettings, allowRegistration, limits, setAdminSettings } from "./settings";
import { exportArticles, importArchive, importArticles, importOpml } from "./importexport";
import { greader } from "./greader";
import { localeFrom, translate } from "./i18n";
import { join, resolve } from "node:path";

const requireUser = (req: Request): User | Response => currentUser(req) ?? err(401, "unauthorized");

const requireAdmin = (req: Request): User | Response => {
  const u = currentUser(req);
  if (!u) return err(401, "unauthorized");
  return u.is_admin ? u : err(403, "admin only");
};

// ---------------------------------------------------------------- feeds

function listFeeds(userId: number) {
  return db
    .query<any, [number]>(
      `SELECT sub.id AS subscription_id, f.id AS feed_id,
              COALESCE(sub.custom_title, f.title, f.feed_url) AS title,
              f.feed_url, f.site_url, f.description, f.icon_url, sub.category_id AS category_id,
              f.last_error, f.last_fetched_at,
              (SELECT COUNT(*) FROM article a
                 LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = sub.user_id
                 WHERE a.feed_id = f.id AND COALESCE(s.read, 0) = 0) AS unread
       FROM subscription sub JOIN feed f ON f.id = sub.feed_id
       WHERE sub.user_id = ?
       ORDER BY title COLLATE NOCASE`,
    )
    .all(userId);
}

// ---------------------------------------------------------------- articles

interface ArticleQuery {
  feedId?: number;
  categoryId?: number;
  tagId?: number;
  unread?: boolean;
  starred?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

function listArticles(userId: number, o: ArticleQuery) {
  const joins = [
    "JOIN feed f ON f.id = a.feed_id",
    "JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?",
  ];
  const where: string[] = [];
  const params: (string | number)[] = [userId]; // sub.user_id

  if (o.feedId) (where.push("a.feed_id = ?"), params.push(o.feedId));
  if (o.categoryId) (where.push("sub.category_id = ?"), params.push(o.categoryId));
  if (o.tagId)
    (where.push("EXISTS (SELECT 1 FROM article_tag at WHERE at.article_id = a.id AND at.user_id = ? AND at.tag_id = ?)"),
      params.push(userId, o.tagId));
  if (o.unread) where.push("COALESCE(s.read, 0) = 0");
  if (o.starred) where.push("COALESCE(s.starred, 0) = 1");

  const q = o.q?.trim();
  if (q && q.length >= 3) {
    joins.push("JOIN article_fts ON article_fts.rowid = a.id");
    where.push("article_fts MATCH ?");
    params.push(`"${q.replace(/"/g, '""')}"`);
  } else if (q) {
    where.push("(a.title LIKE ? OR a.summary LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
  const sql = `SELECT a.id, a.feed_id, a.title, a.link, a.author, a.summary, a.published_at,
                      COALESCE(s.read, 0) AS read, COALESCE(s.starred, 0) AS starred,
                      COALESCE(sub.custom_title, f.title, f.feed_url) AS feed_title
               FROM article a
               ${joins.join("\n               ")}
               LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = ?
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY a.published_at DESC
               LIMIT ? OFFSET ?`;
  // param order: joins (sub.user_id), left-join (s.user_id), where..., limit, offset
  return db.query<any, any[]>(sql).all(userId, ...params, limit, o.offset ?? 0);
}

// ---------------------------------------------------------------- admin

function adminOverview() {
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  return {
    users: count("SELECT COUNT(*) n FROM user"),
    admins: count("SELECT COUNT(*) n FROM user WHERE is_admin = 1"),
    feeds: count("SELECT COUNT(*) n FROM feed"),
    subscriptions: count("SELECT COUNT(*) n FROM subscription"),
    articles: count("SELECT COUNT(*) n FROM article"),
    starred: count("SELECT COUNT(*) n FROM article_state WHERE starred = 1"),
    limits: limits(),
    bun: Bun.version,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

function adminListUsers() {
  return db
    .query<any, []>(
      `SELECT u.id, u.email, u.username, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM subscription s WHERE s.user_id = u.id) AS subscriptions,
              (SELECT COUNT(*) FROM article_state st WHERE st.user_id = u.id AND st.starred = 1) AS starred,
              (SELECT COUNT(*) FROM article a
                 JOIN subscription s2 ON s2.feed_id = a.feed_id AND s2.user_id = u.id
                 LEFT JOIN article_state st2 ON st2.article_id = a.id AND st2.user_id = u.id
                 WHERE COALESCE(st2.read, 0) = 0) AS unread,
              (SELECT l.ip FROM login_log l WHERE l.user_id = u.id ORDER BY l.id DESC LIMIT 1) AS last_login_ip,
              (SELECT l.created_at FROM login_log l WHERE l.user_id = u.id ORDER BY l.id DESC LIMIT 1) AS last_login_at
       FROM user u ORDER BY u.created_at`,
    )
    .all();
}

// ---------------------------------------------------------------- opml

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

function exportOpml(userId: number): string {
  const cats = db
    .query<{ id: number; name: string }, [number]>("SELECT id, name FROM category WHERE user_id = ? ORDER BY sort_order, name")
    .all(userId);
  const subs = db
    .query<{ title: string; feed_url: string; site_url: string | null; category_id: number | null }, [number]>(
      `SELECT COALESCE(sub.custom_title, f.title, f.feed_url) AS title, f.feed_url, f.site_url, sub.category_id
       FROM subscription sub JOIN feed f ON f.id = sub.feed_id WHERE sub.user_id = ?`,
    )
    .all(userId);
  const outline = (rows: typeof subs) =>
    rows
      .map(
        (s) =>
          `    <outline type="rss" text="${escapeXml(s.title)}" title="${escapeXml(s.title)}" xmlUrl="${escapeXml(
            s.feed_url,
          )}"${s.site_url ? ` htmlUrl="${escapeXml(s.site_url)}"` : ""} />`,
      )
      .join("\n");
  const body = [
    outline(subs.filter((s) => s.category_id === null)),
    ...cats.map(
      (c) =>
        `  <outline text="${escapeXml(c.name)}" title="${escapeXml(c.name)}">\n${outline(
          subs.filter((s) => s.category_id === c.id),
        )}\n  </outline>`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>bunrss subscriptions</title></head>\n<body>\n${body}\n</body>\n</opml>\n`;
}

// ---------------------------------------------------------------- server

const PORT = Number(process.env.PORT ?? 3000);

const app = new Hono();

// Google Reader–compatible API for native clients (auth via API token).
// Base URL is /api/greader; clients hit /accounts/ClientLogin and /reader/api/0/* under it.
app.route("/api/greader", greader);

// first-run setup wizard (public; single-shot, guarded in setupAdmin)
app.get("/api/setup/status", (c) => json({ needsSetup: needsSetup(), allowRegistration: allowRegistration() }));
app.post("/api/setup", async (c) => {
  const b = await readJson<{ email?: string; username?: string; password?: string }>(c.req.raw);
  if (!b?.email || !b.username || !b.password) return err(400, "email/username/password required");
  return setupAdmin(b.email, b.username, b.password, clientIp(c.req.raw), localeFrom(c.req.raw));
});

app.post("/api/auth/register", async (c) => {
  const b = await readJson<{ email?: string; username?: string; password?: string }>(c.req.raw);
  if (!b?.email || !b.username || !b.password) return err(400, "email/username/password required");
  return register(b.email, b.username, b.password, clientIp(c.req.raw), localeFrom(c.req.raw));
});
app.post("/api/auth/login", async (c) => {
  const b = await readJson<{ email?: string; password?: string }>(c.req.raw);
  if (!b?.email || !b.password) return err(400, "email/password required");
  return login(b.email, b.password, clientIp(c.req.raw), localeFrom(c.req.raw));
});
app.post("/api/auth/logout", (c) => logout(c.req.raw));
app.get("/api/auth/me", (c) => {
  const u = requireUser(c.req.raw);
  return u instanceof Response ? u : json(u);
});
app.patch("/api/auth/me", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ username?: string }>(c.req.raw);
  if (!b?.username) return err(400, "username required");
  return setUsername(u.id, b.username, localeFrom(c.req.raw));
});

app.get("/api/feeds", (c) => {
  const u = requireUser(c.req.raw);
  return u instanceof Response ? u : json(listFeeds(u.id));
});
// bookmarklet quick-subscribe: discover the feeds a page advertises
app.get("/api/discover", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const locale = localeFrom(c.req.raw);
  const raw = new URL(c.req.url).searchParams.get("url")?.trim();
  if (!raw) return err(400, "url required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(400, translate(locale, "feed.invalidUrl"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return err(400, translate(locale, "feed.invalidUrl"));
  try {
    return json(await discoverFeeds(url.toString()));
  } catch {
    return err(502, translate(locale, "feed.unreachable"));
  }
});
app.post("/api/feeds", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ url?: string; categoryId?: number | null }>(c.req.raw);
  const url = b?.url?.trim();
  if (!url) return err(400, "url required");
  const added = subscribe(u.id, url, b.categoryId ?? null, null, localeFrom(c.req.raw));
  if ("error" in added) return err(added.status, added.error);
  const fr = db.query<{ id: number; feed_url: string; etag: string | null; last_modified: string | null }, [number]>(
    "SELECT id, feed_url, etag, last_modified FROM feed WHERE id = ?",
  ).get(added.feedId)!;
  void refreshFeed(fr).catch(console.error);
  return json(listFeeds(u.id).find((f: any) => f.feed_id === added.feedId) ?? { feed_id: added.feedId });
});
app.patch("/api/feeds/:id", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const feedId = Number(c.req.param("id"));
  const b = await readJson<{ customTitle?: string | null; categoryId?: number | null }>(c.req.raw);
  if (b && "customTitle" in b)
    db.query("UPDATE subscription SET custom_title = ? WHERE user_id = ? AND feed_id = ?").run(b.customTitle ?? null, u.id, feedId);
  if (b && "categoryId" in b)
    db.query("UPDATE subscription SET category_id = ? WHERE user_id = ? AND feed_id = ?").run(b.categoryId ?? null, u.id, feedId);
  return json({ ok: true });
});
app.delete("/api/feeds/:id", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const feedId = Number(c.req.param("id"));
  db.query("DELETE FROM subscription WHERE user_id = ? AND feed_id = ?").run(u.id, feedId);
  db.query("DELETE FROM feed WHERE id = ? AND NOT EXISTS (SELECT 1 FROM subscription WHERE feed_id = ?)").run(feedId, feedId);
  return json({ ok: true });
});

app.get("/api/categories", (c) => {
  const u = requireUser(c.req.raw);
  return u instanceof Response ? u : json(
    db.query("SELECT id, name, sort_order FROM category WHERE user_id = ? ORDER BY sort_order, name").all(u.id),
  );
});
app.post("/api/categories", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ name?: string }>(c.req.raw);
  if (!b?.name?.trim()) return err(400, "name required");
  const row = db
    .query<{ id: number }, [number, string, number]>(
      "INSERT INTO category (user_id, name, sort_order) VALUES (?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET name = name RETURNING id",
    )
    .get(u.id, b.name.trim(), Date.now());
  return json({ id: row!.id, name: b.name.trim() });
});
app.patch("/api/categories/:id", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ name?: string; sortOrder?: number }>(c.req.raw);
  if (b?.name?.trim())
    db.query("UPDATE category SET name = ? WHERE id = ? AND user_id = ?").run(b.name.trim(), Number(c.req.param("id")), u.id);
  if (typeof b?.sortOrder === "number")
    db.query("UPDATE category SET sort_order = ? WHERE id = ? AND user_id = ?").run(b.sortOrder, Number(c.req.param("id")), u.id);
  return json({ ok: true });
});
app.delete("/api/categories/:id", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  db.query("DELETE FROM category WHERE id = ? AND user_id = ?").run(Number(c.req.param("id")), u.id);
  return json({ ok: true });
});

app.get("/api/articles", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const sp = new URL(c.req.url).searchParams;
  const num = (k: string) => (sp.get(k) ? Number(sp.get(k)) : undefined);
  return json(
    listArticles(u.id, {
      feedId: num("feedId"),
      categoryId: num("categoryId"),
      tagId: num("tagId"),
      unread: sp.get("unread") === "1",
      starred: sp.get("starred") === "1",
      q: sp.get("q") ?? undefined,
      limit: num("limit"),
      offset: num("offset"),
    }),
  );
});
app.post("/api/articles/mark-all-read", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ feedId?: number; categoryId?: number }>(c.req.raw);
  db.query(
    `INSERT INTO article_state (user_id, article_id, read, read_at)
     SELECT ?1, a.id, 1, ?2
     FROM article a JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?1
     WHERE (?3 IS NULL OR a.feed_id = ?3) AND (?4 IS NULL OR sub.category_id = ?4)
     ON CONFLICT(user_id, article_id) DO UPDATE SET read = 1, read_at = excluded.read_at`,
  ).run(u.id, Date.now(), b?.feedId ?? null, b?.categoryId ?? null);
  return json({ ok: true });
});
app.get("/api/articles/:id", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const row = db
    .query<any, [number, number]>(
      `SELECT a.*, COALESCE(s.read, 0) AS read, COALESCE(s.starred, 0) AS starred,
              COALESCE(sub.custom_title, f.title, f.feed_url) AS feed_title
       FROM article a
       JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
       JOIN feed f ON f.id = a.feed_id
       LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = ?
       WHERE a.id = ?`,
    )
    .get(u.id, u.id, Number(c.req.param("id")));
  return row ? json({ ...row, tags: articleTags(u.id, row.id) }) : err(404, "not found");
});
app.patch("/api/articles/:id", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ read?: boolean; starred?: boolean }>(c.req.raw);
  if (!b) return err(400, "body required");
  const failure = setArticleState(u.id, Number(c.req.param("id")), b, localeFrom(c.req.raw));
  return failure ? err(failure.status, failure.error) : json({ ok: true });
});
app.post("/api/articles/:id/extract", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const articleId = Number(c.req.param("id"));
  const owns = db
    .query<{ n: number }, [number, number]>(
      "SELECT COUNT(*) n FROM article a JOIN subscription sub ON sub.feed_id=a.feed_id AND sub.user_id=? WHERE a.id=?",
    )
    .get(u.id, articleId);
  if (!owns?.n) return err(404, "not found");
  const ok = await extractFullText(articleId);
  return ok ? json({ ok: true }) : err(502, "extract failed");
});

// ---------------------------------------------------------------- tags
app.get("/api/tags", (c) => {
  const u = requireUser(c.req.raw);
  return u instanceof Response ? u : json(listTags(u.id));
});
app.post("/api/tags", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ name?: string }>(c.req.raw);
  const tag = createTag(u.id, b?.name ?? "", localeFrom(c.req.raw));
  return "error" in tag ? err(tag.status, tag.error) : json(tag);
});
app.patch("/api/tags/:id", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ name?: string }>(c.req.raw);
  const failure = renameTag(u.id, Number(c.req.param("id")), b?.name ?? "", localeFrom(c.req.raw));
  return failure ? err(failure.status, failure.error) : json({ ok: true });
});
app.delete("/api/tags/:id", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  deleteTag(u.id, Number(c.req.param("id")));
  return json({ ok: true });
});

// attach (by id, or by name to create-on-demand) / detach a tag on one article
app.post("/api/articles/:id/tags", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ tagId?: number; name?: string }>(c.req.raw);
  const ref = typeof b?.tagId === "number" ? { tagId: b.tagId } : { name: b?.name ?? "" };
  const tag = addArticleTag(u.id, Number(c.req.param("id")), ref, localeFrom(c.req.raw));
  return "error" in tag ? err(tag.status, tag.error) : json(tag);
});
app.delete("/api/articles/:id/tags/:tagId", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  removeArticleTag(u.id, Number(c.req.param("id")), Number(c.req.param("tagId")));
  return json({ ok: true });
});

app.get("/api/unread", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const rows = db
    .query<any, [number, number]>(
      `SELECT COALESCE(sub.category_id, 0) AS category_id, COUNT(*) AS unread
       FROM article a
       JOIN subscription sub ON sub.feed_id = a.feed_id AND sub.user_id = ?
       LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = ?
       WHERE COALESCE(s.read, 0) = 0
       GROUP BY sub.category_id`,
    )
    .all(u.id, u.id);
  const total = rows.reduce((n: number, r: any) => n + r.unread, 0);
  return json({ total, byCategory: rows });
});

app.post("/api/refresh", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  // `?stale=1` refreshes only feeds not fetched recently (used by the client's auto-sync)
  if (new URL(c.req.url).searchParams.get("stale") === "1") await refreshStale(5 * 60 * 1000);
  else await refreshAll();
  return json({ ok: true });
});

app.get("/api/opml", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  return new Response(exportOpml(u.id), {
    headers: { "content-type": "text/x-opml", "content-disposition": 'attachment; filename="bunrss.opml"' },
  });
});
app.post("/api/opml", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const result = importOpml(u.id, await c.req.text(), localeFrom(c.req.raw));
  void refreshAll().catch(console.error);
  return json(result);
});

// article data migration (read/starred state + labels) in the neutral Google Reader
// JSON format; subscriptions stay on OPML. See server/importexport.ts.
app.get("/api/data", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  return new Response(JSON.stringify(exportArticles(u.id, u.username ?? u.email)), {
    headers: {
      "content-type": "application/json",
      "content-disposition": 'attachment; filename="bunrss-articles.json"',
    },
  });
});
app.post("/api/data", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  // ZIP magic ("PK\x03\x04"): FreshRSS's combined export and tt-rss data_migration archives.
  const result =
    bytes[0] === 0x50 && bytes[1] === 0x4b
      ? importArchive(u.id, bytes, localeFrom(c.req.raw))
      : importArticles(u.id, new TextDecoder().decode(bytes), localeFrom(c.req.raw));
  if ("error" in result) return err(result.status, result.error);
  void refreshAll().catch(console.error);
  return json(result);
});

app.get("/api/limits", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  return json({ ...limits(), subscriptions: countSubscriptions(u.id), starred: countStarred(u.id) });
});

// ------------------------------------------------------------ admin console
app.get("/api/admin/overview", (c) => {
  const a = requireAdmin(c.req.raw);
  return a instanceof Response ? a : json(adminOverview());
});
app.get("/api/admin/users", (c) => {
  const a = requireAdmin(c.req.raw);
  return a instanceof Response ? a : json(adminListUsers());
});
app.post("/api/admin/users", async (c) => {
  const a = requireAdmin(c.req.raw);
  if (a instanceof Response) return a;
  const b = await readJson<{ email?: string; username?: string; password?: string; isAdmin?: boolean }>(c.req.raw);
  if (!b?.email || !b.username || !b.password) return err(400, "email/username/password required");
  return adminCreateUser(b.email, b.username, b.password, b.isAdmin ?? false, localeFrom(c.req.raw));
});
app.patch("/api/admin/users/:id", async (c) => {
  const a = requireAdmin(c.req.raw);
  if (a instanceof Response) return a;
  const id = Number(c.req.param("id"));
  const b = await readJson<{ isAdmin?: boolean }>(c.req.raw);
  if (typeof b?.isAdmin !== "boolean") return err(400, "isAdmin required");
  const target = db.query<{ is_admin: number }, [number]>("SELECT is_admin FROM user WHERE id = ?").get(id);
  if (!target) return err(404, "not found");
  if (!b.isAdmin && target.is_admin) {
    const admins = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM user WHERE is_admin = 1").get()!.n;
    if (admins <= 1) return err(400, translate(localeFrom(c.req.raw), "admin.lastAdminDemote"));
  }
  db.query("UPDATE user SET is_admin = ? WHERE id = ?").run(b.isAdmin ? 1 : 0, id);
  return json({ ok: true });
});
app.delete("/api/admin/users/:id", (c) => {
  const a = requireAdmin(c.req.raw);
  if (a instanceof Response) return a;
  const id = Number(c.req.param("id"));
  if (id === a.id) return err(400, translate(localeFrom(c.req.raw), "admin.deleteSelf"));
  const target = db.query<{ is_admin: number }, [number]>("SELECT is_admin FROM user WHERE id = ?").get(id);
  if (!target) return err(404, "not found");
  const admins = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM user WHERE is_admin = 1").get()!.n;
  if (target.is_admin && admins <= 1) return err(400, translate(localeFrom(c.req.raw), "admin.lastAdminDelete"));
  // cascades to session / subscription / category / article_state
  db.query("DELETE FROM user WHERE id = ?").run(id);
  // drop feeds nobody is subscribed to any more, so the scheduler stops fetching them
  db.query("DELETE FROM feed WHERE NOT EXISTS (SELECT 1 FROM subscription WHERE feed_id = feed.id)").run();
  return json({ ok: true });
});
app.get("/api/admin/settings", (c) => {
  const a = requireAdmin(c.req.raw);
  return a instanceof Response ? a : json(adminSettings());
});
app.patch("/api/admin/settings", async (c) => {
  const a = requireAdmin(c.req.raw);
  if (a instanceof Response) return a;
  const b = await readJson<{ maxSubscriptions?: number; maxStarred?: number; maxUsers?: number; allowRegistration?: boolean }>(c.req.raw);
  if (!b) return err(400, "body required");
  return json(setAdminSettings(b));
});

// ------------------------------------------------- api tokens (for GReader clients)
// Per-user bearer secrets. Users mint their own in Settings; admins can mint for anyone.
// Listing masks the value (shown once at create), so a leaked list isn't a leaked credential.
const maskToken = (t: string) => t.slice(0, 8) + "…";

function listTokens(userId: number) {
  return db
    .query<any, [number]>(
      "SELECT id, token, label, created_at, last_used_at FROM api_token WHERE user_id = ? ORDER BY id DESC",
    )
    .all(userId)
    .map((r) => ({ ...r, token: maskToken(r.token) }));
}

function createToken(userId: number, label: string | null) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const row = db
    .query<{ id: number; created_at: number }, [string, number, string | null, number]>(
      "INSERT INTO api_token (token, user_id, label, created_at) VALUES (?, ?, ?, ?) RETURNING id, created_at",
    )
    .get(token, userId, label, Date.now())!;
  return { id: row.id, token, label, created_at: row.created_at, last_used_at: null };
}

// self-service (any logged-in user)
app.get("/api/tokens", (c) => {
  const u = requireUser(c.req.raw);
  return u instanceof Response ? u : json(listTokens(u.id));
});
app.post("/api/tokens", async (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  const b = await readJson<{ label?: string }>(c.req.raw);
  return json(createToken(u.id, b?.label ?? null));
});
app.delete("/api/tokens/:id", (c) => {
  const u = requireUser(c.req.raw);
  if (u instanceof Response) return u;
  db.query("DELETE FROM api_token WHERE id = ? AND user_id = ?").run(Number(c.req.param("id")), u.id);
  return json({ ok: true });
});

// admin console (manage any user's tokens)
app.get("/api/admin/users/:id/tokens", (c) => {
  const a = requireAdmin(c.req.raw);
  return a instanceof Response ? a : json(listTokens(Number(c.req.param("id"))));
});
app.post("/api/admin/users/:id/tokens", async (c) => {
  const a = requireAdmin(c.req.raw);
  if (a instanceof Response) return a;
  const id = Number(c.req.param("id"));
  const exists = db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM user WHERE id = ?").get(id)!.n;
  if (!exists) return err(404, "not found");
  const b = await readJson<{ label?: string }>(c.req.raw);
  return json(createToken(id, b?.label ?? null));
});
app.delete("/api/admin/tokens/:id", (c) => {
  const a = requireAdmin(c.req.raw);
  if (a instanceof Response) return a;
  db.query("DELETE FROM api_token WHERE id = ?").run(Number(c.req.param("id")));
  return json({ ok: true });
});

// serve the built SPA; fall back to index.html for client-side routes
app.notFound(async (c) => {
  const { pathname } = new URL(c.req.url);
  if (pathname.startsWith("/api/")) return err(404, "not found");

  const dist = resolve(import.meta.dir, "../web/dist");
  const target = resolve(dist, "." + pathname);
  if (!target.startsWith(dist)) return err(404, "not found");
  let file = Bun.file(target);
  if (!(await file.exists())) file = Bun.file(join(dist, "index.html"));
  if (await file.exists()) return new Response(file);
  return new Response("bunrss API is running. Frontend dev server: http://localhost:5173", { status: 200 });
});

const server = Bun.serve({ port: PORT, fetch: app.fetch });

/**
 * Best-effort client address: the first X-Forwarded-For hop when a reverse proxy is in front,
 * otherwise the socket peer. XFF is client-controlled when nothing proxies the request, so treat
 * this as an audit hint, not a security control.
 */
function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  try {
    return server.requestIP(req)?.address ?? null;
  } catch {
    return null;
  }
}

// Background maintenance: refresh stale feeds and clean up old rows every 15 min.
// setInterval instead of Bun.cron so the schedule doesn't depend on platform cron support.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  db.query("DELETE FROM session WHERE expires_at < ?").run(Date.now());
  db.query("DELETE FROM login_log WHERE created_at < ?").run(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // ponytail: no in-flight lock, so two ticks (or clients) can overlap on the same feed; upserts make it safe, just redundant I/O
  void refreshStale(REFRESH_INTERVAL_MS).catch(console.error);
}, REFRESH_INTERVAL_MS);

console.log(`bunrss listening on http://localhost:${server.port}`);
