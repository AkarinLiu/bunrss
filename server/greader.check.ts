// Self-check for the Google Reader API compatibility quirks that broke native clients:
//  - itemRefs ids use the spec's "short" (decimal) form, while stream/items/contents and
//    edit-tag accept both that and the `tag:google.com,2005:reader/item/<hex>` long form;
//  - `ot`/`nt` bound the stream by time (`ot` is the oldest item of interest, a lower bound);
//  - `r=o` sorts oldest-first and `n` may go up to 10,000;
//  - RSS Guard fetches article bodies via POST stream/items/contents;
//  - stream/contents/<streamId> is a path route (mounted under /api/greader).
// Runs against a throwaway DB, no server needed: bun run server/greader.check.ts
process.env.DATABASE_URL = (process.env.TEMP || ".") + "/bunrss-greader-check-" + Date.now() + ".db";

import { Hono } from "hono";

const { db } = await import("./db");
const { greader } = await import("./greader");

const now = Date.now();
db.query("INSERT INTO user (email, password_hash, created_at) VALUES (?, ?, ?)").run("u@x", "x", now);
const uid = db.query<{ id: number }, []>("SELECT id FROM user WHERE email = 'u@x'").get()!.id;
const token = "checktoken";
db.query("INSERT INTO api_token (token, user_id, created_at) VALUES (?, ?, ?)").run(token, uid, now);
db.query("INSERT INTO feed (feed_url, title, site_url) VALUES (?, ?, ?)").run("https://ex.com/feed", "Ex", "https://ex.com");
const fid = db.query<{ id: number }, []>("SELECT id FROM feed WHERE feed_url = 'https://ex.com/feed'").get()!.id;
db.query("INSERT INTO subscription (user_id, feed_id, created_at) VALUES (?, ?, ?)").run(uid, fid, now);
db.query(
  "INSERT INTO article (feed_id, guid, title, link, content, summary, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).run(fid, "g1", "Hello", "https://ex.com/1", "<p>Body</p>", "snippet", now, now);
const aid = db.query<{ id: number }, []>("SELECT id FROM article WHERE guid = 'g1'").get()!.id;
const itemId = "tag:google.com,2005:reader/item/" + aid.toString(16).padStart(16, "0");

const auth = { authorization: `GoogleLogin auth=${token}` };
const form = { "content-type": "application/x-www-form-urlencoded" };
const call = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) =>
  greader.fetch(new Request("http://x" + path, { method, headers: { ...auth, ...headers }, body }));

let failed = 0;
const check = (cond: unknown, msg: string) => {
  console.log((cond ? "ok - " : "FAIL - ") + msg);
  if (!cond) failed++;
};

// 0. the whole sub-app is reachable under the /api/greader mount
const mounted = new Hono();
mounted.route("/api/greader", greader);
const login = await mounted.fetch(
  new Request("http://x/api/greader/accounts/ClientLogin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `Email=u%40x&Passwd=${token}`,
  }),
);
check(login.status === 200 && (await login.text()).includes("Auth=" + token), "/api/greader mount + ClientLogin");

// 1. itemRefs ids are the spec's short (decimal) form, and carry direct stream ids
let res = await call("/reader/api/0/stream/items/ids?s=" + encodeURIComponent("feed/https://ex.com/feed"));
let j: any = await res.json();
check(j.itemRefs.length === 1 && j.itemRefs[0].id === String(aid), "stream/items/ids returns the short (decimal) id");
check(j.itemRefs[0].directStreamIds.includes("feed/https://ex.com/feed"), "itemRefs carry directStreamIds");

// 2. bodies by id (RSS Guard's path) — the long form still resolves
res = await call("/reader/api/0/stream/items/contents", form, "POST", "i=" + encodeURIComponent(itemId));
j = await res.json();
check(j.items.length === 1 && j.items[0].id === itemId, "stream/items/contents resolves the comma-containing id");
check(j.items[0].summary.content.includes("Body") && j.items[0].canonical[0].href === "https://ex.com/1", "contents carry body + canonical href");

// 2b. so does the short (decimal) form clients send back after itemRefs
res = await call("/reader/api/0/stream/items/contents", form, "POST", "i=" + aid);
j = await res.json();
check(j.items.length === 1 && j.items[0].id === itemId, "stream/items/contents resolves the short (decimal) id");

// 3. path-form stream scoped to the feed (mount prefix must not eat the stream id)
res = await call("/reader/api/0/stream/contents/" + encodeURIComponent("feed/https://ex.com/feed"));
j = await res.json();
check(j.items.length === 1 && j.items[0].id === itemId, "stream/contents/<id> path route");

// 4. edit-tag marks read using the full id
res = await call(
  "/reader/api/0/edit-tag",
  form,
  "POST",
  `i=${encodeURIComponent(itemId)}&a=${encodeURIComponent("user/-/state/com.google/read")}`,
);
const state = db.query<{ read: number }, [number, number]>("SELECT read FROM article_state WHERE user_id = ? AND article_id = ?").get(uid, aid);
check(res.status === 200 && state?.read === 1, "edit-tag marks the article read");

// 5. read state must come back as a category tag (clients render read/starred from it)
res = await call("/reader/api/0/stream/items/contents", form, "POST", "i=" + encodeURIComponent(itemId));
j = await res.json();
check(j.items[0].categories.includes("user/-/state/com.google/read"), "read state is reported as a category");

// 6. tags using a numeric user id (`user/123/...`) are normalized
db.query("UPDATE article_state SET read = 0 WHERE user_id = ? AND article_id = ?").run(uid, aid);
res = await call(
  "/reader/api/0/edit-tag",
  form,
  "POST",
  `i=${encodeURIComponent(itemId)}&a=${encodeURIComponent("user/123/state/com.google/read")}`,
);
const numeric = db.query<{ read: number }, [number, number]>("SELECT read FROM article_state WHERE user_id = ? AND article_id = ?").get(uid, aid);
check(res.status === 200 && numeric?.read === 1, "numeric user id tags are normalized");

// 7. ot is a lower bound (items newer than it), nt an upper bound — client incremental
//    sync sends ot=<last seen time> and must get the newer items back.
const olderPub = now - 7 * 86_400_000;
const newerPub = now + 3_600_000;
const insertArticle = db.query("INSERT INTO article (feed_id, guid, title, link, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)");
insertArticle.run(fid, "g0", "Old", "https://ex.com/0", olderPub, olderPub);
insertArticle.run(fid, "g2", "New", "https://ex.com/2", newerPub, newerPub);
const olderID = db.query<{ id: number }, []>("SELECT id FROM article WHERE guid = 'g0'").get()!.id;
const newerID = db.query<{ id: number }, []>("SELECT id FROM article WHERE guid = 'g2'").get()!.id;
const enc = encodeURIComponent("feed/https://ex.com/feed");
const sinceOt = Math.floor((now + 1000) / 1000);
const untilNt = Math.floor((now - 1000) / 1000);
res = await call(`/reader/api/0/stream/items/ids?s=${enc}&ot=${sinceOt}`);
j = await res.json();
check(j.itemRefs.length === 1 && j.itemRefs[0].id === String(newerID), "ot is a lower bound (returns only newer items)");
res = await call(`/reader/api/0/stream/items/ids?s=${enc}&nt=${untilNt}`);
j = await res.json();
check(j.itemRefs.length === 1 && j.itemRefs[0].id === String(olderID), "nt is an upper bound (returns only older items)");

// 8. r=o reverses the sort; n above the old 200 cap fits in a single page
res = await call(`/reader/api/0/stream/contents/${enc}?r=o`);
j = await res.json();
check(j.items[0].title === "Old", "r=o returns oldest first");
res = await call(`/reader/api/0/stream/items/ids?s=${enc}&n=5000`);
j = await res.json();
check(j.itemRefs.length === 3 && j.continuation === undefined, "n=5000 returns every item in one page");

// 8b. `ot` bounds ingestion time, not the published date: a feed that backfills an
//     older-dated article must still be returned to the client's incremental sync.
db.query("INSERT INTO feed (feed_url, title) VALUES (?, ?)").run("https://back.example/rss", "Backfill");
const bfid = db.query<{ id: number }, []>("SELECT id FROM feed WHERE feed_url = 'https://back.example/rss'").get()!.id;
db.query("INSERT INTO subscription (user_id, feed_id, created_at) VALUES (?, ?, ?)").run(uid, bfid, now);
db.query("INSERT INTO article (feed_id, guid, title, link, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run(bfid, "bf1", "Backfilled", "https://back.example/1", now - 30 * 86_400_000, now + 60_000);
res = await call(`/reader/api/0/stream/contents/${encodeURIComponent("feed/https://back.example/rss")}?ot=${sinceOt}`);
j = await res.json();
check(j.items.length === 1 && j.items[0].title === "Backfilled", "ot bounds ingestion time, so backfilled items still sync");

// 9. subscribing through the GReader API primes the feed immediately, so the client's
//    follow-up sync sees the articles instead of waiting for the background cron.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  if (String(input) === "https://new.example/rss") {
    return new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>New</title><link>https://new.example</link>` +
        `<item><title>Fresh</title><link>https://new.example/1</link><guid>fresh-1</guid><pubDate>${new Date().toUTCString()}</pubDate></item>` +
        `</channel></rss>`,
      { status: 200, headers: { "content-type": "application/rss+xml" } },
    );
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;
res = await call("/reader/api/0/subscription/quickadd", form, "POST", "quickadd=" + encodeURIComponent("https://new.example/rss"));
globalThis.fetch = realFetch;
const newFeed = db.query<{ id: number }, []>("SELECT id FROM feed WHERE feed_url = 'https://new.example/rss'").get();
const primed = newFeed
  ? ((await (await call(`/reader/api/0/stream/items/ids?s=${encodeURIComponent("feed/https://new.example/rss")}`)).json()) as any)
      .itemRefs.length
  : 0;
check(res.status === 200 && !!newFeed && primed === 1, "GReader subscribe fetches the feed immediately");

// 10. the freshly primed article shows up in the unread reading-list the client polls
const newArticle = newFeed ? db.query<{ id: number }, [number]>("SELECT id FROM article WHERE feed_id = ?").get(newFeed.id) : null;
const readingList = (await (
  await call(
    `/reader/api/0/stream/items/ids?s=${encodeURIComponent("user/-/state/com.google/reading-list")}&xt=${encodeURIComponent("user/-/state/com.google/read")}`,
  )
).json()) as any;
check(!!newArticle && readingList.itemRefs.some((r: any) => r.id === String(newArticle.id)), "new feed's article appears in the unread reading-list");

console.log(failed ? `\n${failed} check(s) failed` : "\nall greader checks passed");
process.exit(failed ? 1 : 0);
