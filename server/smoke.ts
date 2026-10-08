// Smoke test. Spawns its own server on a throwaway database so every run starts fresh;
// set BASE to point it at an existing server instead (admin/limit checks are then skipped).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const external = process.env.BASE;
const dbFile = join(tmpdir(), `bunrss-smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
const server = external
  ? null
  : Bun.spawn(["bun", "server/index.ts"], {
      // SMTP_HOST is forced empty (after the spread) so a developer's .env can't turn on
      // forced verification and break the register/login checks below.
      env: { ...process.env, DATABASE_URL: dbFile, PORT: "0", SMTP_HOST: "" },
      stdout: "pipe",
      stderr: "inherit",
    });

async function startupPort(): Promise<number> {
  const reader = server!.stdout.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("server exited before it started listening");
    const m = decoder.decode(value).match(/localhost:(\d+)/);
    if (m) return Number(m[1]);
  }
}

const BASE = external ?? `http://localhost:${server ? await startupPort() : 0}`;

// wait for the server to accept connections
for (let i = 0; ; i++) {
  try {
    await fetch(BASE + "/api/setup/status");
    break;
  } catch {
    if (i > 50) throw new Error(`server not reachable at ${BASE}`);
    await Bun.sleep(100);
  }
}

let cookie = "";
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const raw = typeof body === "string";
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": raw ? "text/xml" : "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie?.()[0];
  if (sc) cookie = sc.split(";")[0]!;
  const text = await res.text();
  const isJson = text.startsWith("{") || text.startsWith("[");
  return { status: res.status, data: isJson ? JSON.parse(text) : text };
}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
}

// Google Reader clients use form bodies + an Authorization header instead of the session cookie.
// All GReader endpoints live under /api/greader.
async function gcall(
  method: string,
  path: string,
  init: { token?: string; form?: Record<string, string> } = {},
): Promise<{ status: number; text: string; data: any }> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.token) headers.authorization = `GoogleLogin auth=${init.token}`;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const res = await fetch(BASE + "/api/greader" + path, { method, headers, body });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON (ClientLogin) stays a string
  }
  return { status: res.status, text, data };
}

try {
  const email = `smoke_${Date.now()}@test.local`;
  const username = `smoke_${Date.now()}`;
  const adminEmail = `admin_${Date.now()}@test.local`;
  const adminUser = `admin_${Date.now()}`;

  const status = await call("GET", "/api/setup/status");
  check(typeof status.data.needsSetup === "boolean", "setup status");

  // the admin/limit checks below need the first user created here, so they only run on a fresh database
  const setupRan = status.data.needsSetup;
  if (setupRan) {
    const r = await call("POST", "/api/setup", { email: adminEmail, username: adminUser, password: "secret123" });
    check(r.status === 200 && r.data.is_admin === 1, "setup creates the first user as admin");
    check((await call("GET", "/api/auth/me")).data.is_admin === 1, "admin session is active");
    check((await call("POST", "/api/setup", { email: `x_${Date.now()}@test.local`, username: `x_${Date.now()}`, password: "secret123" })).status === 409, "setup is single-shot");
  } else {
    check((await call("POST", "/api/setup", { email: adminEmail, username: adminUser, password: "secret123" })).status === 409, "setup refused when users already exist");
  }

  check((await call("POST", "/api/auth/register", { email, username, password: "secret123" })).status === 200, "register");
  check((await call("GET", "/api/auth/me")).data.username === username, "me returns the username");
  check((await call("GET", "/api/auth/me")).data.is_admin === 0, "registered user is not admin");
  check((await call("POST", "/api/auth/login", { email: username, password: "secret123" })).status === 200, "login by username");
  check((await call("GET", "/api/feeds")).status === 200, "feeds list");

  const selfTok = await call("POST", "/api/tokens", { label: "self" });
  check(typeof selfTok.data.token === "string" && selfTok.data.token.length > 20, "user mints own API token");
  check((await call("GET", "/api/tokens")).data.length === 1, "user lists own tokens");
  check((await call("DELETE", `/api/tokens/${selfTok.data.id}`)).status === 200, "user revokes own token");
  check((await call("GET", "/api/tokens")).data.length === 0, "revoked token is gone");

  const cat = await call("POST", "/api/categories", { name: "SmokeCat" });
  check(cat.data.id > 0, "create category");

  const sub = await call("POST", "/api/feeds", { url: "https://example.invalid/feed.xml", categoryId: cat.data.id });
  check(sub.data.feed_id > 0, "subscribe");

  const feeds = await call("GET", "/api/feeds");
  check(feeds.data.length === 1, "feed appears in list");
  check(feeds.data[0].category_id === cat.data.id, "feed linked to category");

  check(Array.isArray((await call("GET", "/api/articles")).data), "articles list");
  check(Array.isArray((await call("GET", "/api/articles?q=hello&unread=1&starred=1")).data), "articles filtered");
  check(Array.isArray((await call("GET", "/api/articles?q=hi")).data), "articles short-query LIKE path");
  check(
    Array.isArray((await call("GET", `/api/articles?feedId=${sub.data.feed_id}&categoryId=${cat.data.id}&unread=1&q=hello&limit=5`)).data),
    "articles combined filters",
  );
  check((await call("GET", "/api/unread")).data.total === 0, "unread count");
  check((await call("PATCH", "/api/articles/999999", { read: true })).status === 404, "patch unknown article 404");

  const opml = await call("GET", "/api/opml");
  check(typeof opml.data === "string" && opml.data.includes("example.invalid/feed.xml"), "opml export");

  const imported = await call("POST", "/api/opml", `<opml><body><outline text="C"><outline type="rss" xmlUrl="https://example.invalid/other.xml"/></outline></body></opml>`);
  check(imported.data.imported === 1, "opml import");

  check((await call("POST", "/api/feeds", { url: "https://example.invalid/feed.xml" })).status === 200, "resubscribe");
  const after = await call("GET", "/api/feeds");
  check(after.data.length === 2, "no duplicate feed rows");

  await call("DELETE", `/api/feeds/${sub.data.feed_id}`);
  check((await call("GET", "/api/feeds")).data.length === 1, "unsubscribe");

  const tag = await call("POST", "/api/tags", { name: "SmokeTag" });
  check(tag.status === 200 && tag.data.id > 0, "create a tag");
  check((await call("POST", "/api/tags", { name: "smoketag" })).data.id === tag.data.id, "tag names are case-insensitively unique");
  check((await call("GET", "/api/tags")).data.some((t: any) => t.id === tag.data.id), "tag appears in the list");
  check((await call("POST", "/api/articles/999999/tags", { tagId: tag.data.id })).status === 404, "cannot tag an unknown article");
  check((await call("PATCH", `/api/tags/${tag.data.id}`, { name: "SmokeTag2" })).status === 200, "rename a tag");
  check((await call("PATCH", `/api/tags/${tag.data.id}`, { name: "" })).status === 400, "blank rename refused");
  check((await call("DELETE", `/api/tags/${tag.data.id}`)).status === 200, "delete a tag");
  check(!(await call("GET", "/api/tags")).data.some((t: any) => t.id === tag.data.id), "deleted tag is gone");

  if (setupRan) {
    await call("POST", "/api/auth/login", { email: adminEmail, password: "secret123" });
    check((await call("GET", "/api/admin/overview")).data.users >= 2, "admin reads the overview");
    const adminUsers = (await call("GET", "/api/admin/users")).data;
    check(adminUsers.length >= 2, "admin reads the user list");
    check(
      adminUsers.every((u: any) => typeof u.last_login_ip === "string" && u.last_login_ip.length > 0),
      "every user has a recorded login IP (" + adminUsers.map((u: any) => u.last_login_ip).join(", ") + ")",
    );

    // --- Google Reader API (independent API token, created by the admin) ---
    const uid = adminUsers.find((u: any) => u.email === email).id;
    const created = await call("POST", `/api/admin/users/${uid}/tokens`, { label: "smoke" });
    check(typeof created.data.token === "string" && created.data.token.length > 20, "admin mints an API token");
    const gtoken = created.data.token as string;
    check((await call("GET", `/api/admin/users/${uid}/tokens`)).data[0].token.includes("…"), "token list masks the value");

    const bad = await gcall("POST", "/accounts/ClientLogin", { form: { Email: email, Passwd: "wrong" } });
    check(bad.status === 403 && bad.text.includes("BadAuthentication"), "ClientLogin rejects a bad token");
    const login = await gcall("POST", "/accounts/ClientLogin", { form: { Email: email, Passwd: gtoken } });
    check(login.text.includes(`Auth=${gtoken}`), "ClientLogin returns the Auth token");

    const info = await gcall("GET", "/reader/api/0/user-info", { token: gtoken });
    check(info.data.userEmail === email, "greader user-info");
    check((await gcall("GET", "/reader/api/0/subscription/list", { token: gtoken })).data.subscriptions.length === 1, "greader subscription/list");
    check(
      (await gcall("GET", "/reader/api/0/tag/list", { token: gtoken })).data.tags.some((t: any) => t.id.includes("starred")),
      "greader tag/list",
    );
    check(typeof (await gcall("GET", "/reader/api/0/unread-count", { token: gtoken })).data.max === "number", "greader unread-count");
    const stream = await gcall("GET", "/reader/api/0/stream/contents", { token: gtoken });
    check(Array.isArray(stream.data.items), "greader stream/contents");
    check(Array.isArray((await gcall("GET", "/reader/api/0/stream/items/ids", { token: gtoken })).data.itemRefs), "greader stream/items/ids");
    check((await gcall("POST", "/reader/api/0/subscription/quickadd", { token: gtoken, form: { quickadd: "https://example.invalid/greader.xml" } })).data.numResults === 1, "greader quickadd");
    check((await gcall("GET", "/reader/api/0/subscription/list", { token: gtoken })).data.subscriptions.length === 2, "greader quickadd persisted");
    const tok = await gcall("GET", "/reader/api/0/token", { token: gtoken });
    check(tok.text === gtoken, "greader edit token");
    const unauth = await gcall("GET", "/reader/api/0/user-info", {});
    check(unauth.status === 401, "greader rejects missing auth");

    // --- article data migration (read/starred state + labels) ---
    const dataImport = await call(
      "POST",
      "/api/data",
      JSON.stringify({
        items: [
          {
            guid: "smoke-import-1",
            title: "Smoke imported",
            content: "<p>imported body</p>",
            published: 1700000000,
            origin: { feedUrl: "https://example.invalid/data.xml", title: "Data Feed" },
            categories: ["user/-/state/com.google/read", "user/-/state/com.google/starred"],
          },
        ],
      }),
    );
    check(dataImport.data.articles === 1 && dataImport.data.feeds === 1, "data import inserts article + feed");
    const dataExport = await call("GET", "/api/data");
    check(
      dataExport.data?.items?.some(
        (i: any) => i.title === "Smoke imported" && i.categories.includes("user/-/state/com.google/read"),
      ),
      "data export includes imported read state",
    );

    const lowered = await call("PATCH", "/api/admin/settings", { maxSubscriptions: 1, maxStarred: 1 });
    check(lowered.data.maxSubscriptions === 1 && lowered.data.maxStarred === 1, "admin sets the limits");

    await call("POST", "/api/auth/login", { email, password: "secret123" });
    check((await call("GET", "/api/limits")).data.maxSubscriptions === 1, "user sees the limit");
    check(
      (await call("POST", "/api/feeds", { url: "https://example.invalid/over.xml" })).status === 409,
      "subscription limit is enforced over HTTP",
    );

    await call("POST", "/api/auth/login", { email: adminEmail, password: "secret123" });
    await call("PATCH", "/api/admin/settings", { maxSubscriptions: 0, maxStarred: 0 });
    await call("POST", "/api/auth/login", { email, password: "secret123" });
  } else {
    console.log("skip - admin/limit checks need a fresh database (run against a temp DB)");
  }

  check((await call("GET", "/api/admin/overview")).status === 403, "non-admin is refused the admin API");
  check((await call("POST", "/api/auth/logout")).status === 200, "logout");

  console.log("\nall smoke checks passed");
} finally {
  if (server) {
    server.kill();
    await Promise.race([server.exited, Bun.sleep(2000)]);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbFile + suffix, { force: true });
      } catch {
        // a leftover temp file is harmless
      }
    }
  }
}
