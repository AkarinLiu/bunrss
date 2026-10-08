// Self-check for the Google Reader API compatibility quirks that broke native clients:
//  - item ids are the standard `tag:google.com,2005:reader/item/<hex>` form and contain commas,
//    so the `i` param must NOT be comma-split;
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

// 1. ids come back in full tag form (commas intact)
let res = await call("/reader/api/0/stream/items/ids?s=" + encodeURIComponent("feed/https://ex.com/feed"));
let j: any = await res.json();
check(j.itemRefs.length === 1 && j.itemRefs[0].id === itemId, "stream/items/ids returns the full tag id");

// 2. bodies by id (RSS Guard's path)
res = await call("/reader/api/0/stream/items/contents", form, "POST", "i=" + encodeURIComponent(itemId));
j = await res.json();
check(j.items.length === 1 && j.items[0].id === itemId, "stream/items/contents resolves the comma-containing id");
check(j.items[0].summary.content.includes("Body") && j.items[0].canonical[0].href === "https://ex.com/1", "contents carry body + canonical href");

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

console.log(failed ? `\n${failed} check(s) failed` : "\nall greader checks passed");
process.exit(failed ? 1 : 0);
