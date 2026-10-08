// In-process checks for the first-run setup gate and the instance limits,
// on a throwaway database so dev data is never touched.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const file = join(tmpdir(), `bunrss-check-${Date.now()}.db`);
process.env.DATABASE_URL = file;

const { adminCreateUser, login, needsSetup, setUsername, setupAdmin, register } = await import("./auth");
const {
  addArticleTag,
  articleTags,
  countStarred,
  createTag,
  deleteTag,
  listTags,
  removeArticleTag,
  renameTag,
  setArticleState,
  subscribe,
} = await import("./library");
const { setLimits, setAdminSettings } = await import("./settings");
const { exportArticles, importArchive, importArticles } = await import("./importexport");
const { db } = await import("./db");

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
}

/** Builds a real (deflated) ZIP containing the given text members, for the archive reader check. */
function makeZip(files: { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.text);
    const comp = deflateRawSync(raw);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, 8, true); // deflate
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, raw.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, comp);

    const cd = new Uint8Array(46 + name.length);
    const dv2 = new DataView(cd.buffer);
    dv2.setUint32(0, 0x02014b50, true);
    dv2.setUint16(4, 20, true);
    dv2.setUint16(6, 20, true);
    dv2.setUint16(10, 8, true);
    dv2.setUint32(20, comp.length, true);
    dv2.setUint32(24, raw.length, true);
    dv2.setUint16(28, name.length, true);
    dv2.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + comp.length;
  }
  const eocd = new Uint8Array(22);
  const dv3 = new DataView(eocd.buffer);
  dv3.setUint32(0, 0x06054b50, true);
  dv3.setUint16(8, files.length, true);
  dv3.setUint16(10, files.length, true);
  dv3.setUint32(12, central.reduce((n, c) => n + c.length, 0), true);
  dv3.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const userId = (email: string) => db.query<{ id: number }, [string]>("SELECT id FROM user WHERE email = ?").get(email)!.id;

try {
  // ---------------------------------------------------------------- setup
  check(needsSetup(), "fresh database needs setup");

  const r1 = await setupAdmin("admin@test.local", "Admin", "secret123");
  check(r1.status === 200, "setup creates the first user");
  check(r1.headers.get("set-cookie")?.includes("bunrss_session="), "setup logs the admin in");
  check((await r1.json()).username === "Admin", "setup preserves the username's case");

  const adminId = userId("admin@test.local");
  check(needsSetup() === false, "no longer needs setup");
  check((await setupAdmin("second@test.local", "second", "secret123")).status === 409, "second setup is refused");
  check((await register("member@test.local", "Member", "secret123")).status === 200, "later registration still works");
  const memberId = userId("member@test.local");

  check(
    db.query<{ is_admin: number }, [number]>("SELECT is_admin FROM user WHERE id = ?").get(memberId)!.is_admin === 0,
    "later users are not admin",
  );
  check((await register("other@test.local", "member", "secret123")).status === 409, "duplicate username is refused case-insensitively");
  check((await register("admin@test.local", "admin2", "secret123")).status === 409, "duplicate email refused");
  check((await setupAdmin("bad", "x", "y")).status === 400, "invalid input refused");
  check((await register("short@test.local", "ab", "secret123")).status === 400, "too-short username refused");

  // ---------------------------------------------------------------- registration switch
  setAdminSettings({ allowRegistration: false });
  check((await register("closed@test.local", "closed", "secret123")).status === 403, "registration refused while closed");
  setAdminSettings({ allowRegistration: true });
  check(
    (await register("reopened@test.local", "reopened", "secret123")).status === 200,
    "registration works again once reopened",
  );

  // ---------------------------------------------------------------- user cap
  const usersNow = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM user").get()!.n;
  setLimits({ maxUsers: usersNow });
  check((await register("overflow@test.local", "overflow", "secret123")).status === 403, "registration refused at the user cap");
  check((await register("reopened@test.local", "reopened", "secret123")).status === 409, "duplicate email still wins over the cap");
  setLimits({ maxUsers: 0 });
  check((await register("fits@test.local", "fits", "secret123")).status === 200, "registration allowed again below the cap");

  // ---------------------------------------------------------------- admin-created users
  const made = await adminCreateUser("invited@test.local", "Invited", "secret123", true);
  check(made.status === 200, "admin can create a user");
  check(!made.headers.get("set-cookie"), "admin creation does not sign the admin in as the new user");
  const madeId = userId("invited@test.local");
  check(
    db.query<{ is_admin: number }, [number]>("SELECT is_admin FROM user WHERE id = ?").get(madeId)!.is_admin === 1,
    "admin-created user can be granted admin",
  );
  check((await adminCreateUser("invited@test.local", "other", "secret123", false)).status === 409, "duplicate email refused");
  check((await adminCreateUser("bad", "x", "y", false)).status === 400, "invalid input refused");
  setLimits({ maxUsers: db.query<{ n: number }, []>("SELECT COUNT(*) n FROM user").get()!.n });
  check(
    (await adminCreateUser("over-cap@test.local", "overcap", "secret123", false)).status === 200,
    "admin creation bypasses the registration cap",
  );
  setLimits({ maxUsers: 0 });

  // ---------------------------------------------------------------- login IP log
  const firstLog = db.query<{ ip: string | null }, []>("SELECT ip FROM login_log ORDER BY id LIMIT 1").get();
  check(firstLog?.ip === null, "sessions created without an address record NULL, not a bogus value");

  check((await login("member@test.local", "secret123", "203.0.113.7")).status === 200, "login succeeds");
  const lastLog = db.query<{ ip: string | null }, []>("SELECT ip FROM login_log ORDER BY id DESC LIMIT 1").get();
  check(lastLog?.ip === "203.0.113.7", "login records the client IP");
  check(
    db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM login_log WHERE user_id = ?").get(memberId)!.n === 2,
    "one log row per session (register + login)",
  );
  check((await login("member@test.local", "wrong-password", "203.0.113.7")).status === 401, "failed login is rejected");
  check(
    db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM login_log WHERE user_id = ?").get(memberId)!.n === 2,
    "failed login records nothing",
  );

  // ---------------------------------------------------------------- username login, case & immutability
  check((await login("Member", "secret123")).status === 200, "login works with the username");
  check((await login("mEmBeR", "secret123")).status === 200, "username login is case-insensitive");

  // a legacy row (predating the column) may claim a username exactly once
  db.query("INSERT INTO user (email, password_hash, created_at, is_admin) VALUES (?, ?, ?, 0)").run(
    "legacy@test.local",
    "unusable",
    Date.now(),
  );
  const legacyId = userId("legacy@test.local");
  check(setUsername(legacyId, "Member").status === 409, "claiming a taken username is refused case-insensitively");
  check(setUsername(legacyId, "Legacy").status === 200, "a username-less account can claim one");
  check(setUsername(legacyId, "Other").status === 409, "the claimed username is then immutable");
  check(setUsername(adminId, "root").status === 409, "an existing username cannot be changed");

  // ---------------------------------------------------------------- subscription limit
  setLimits({ maxSubscriptions: 2, maxStarred: 0 });

  const s1 = subscribe(adminId, "https://one.example/feed", null);
  const s2 = subscribe(adminId, "https://two.example/feed", null);
  const s3 = subscribe(adminId, "https://three.example/feed", null);
  check("error" in s1 === false && "error" in s2 === false, "subscriptions under the limit are allowed");
  check("error" in s3 && s3.status === 409, "subscription limit rejects the third feed");

  const again = subscribe(adminId, "https://one.example/feed", null);
  check("error" in again === false && again.created === false, "re-subscribing is a no-op, not a limit hit");

  // ---------------------------------------------------------------- star limit
  const starFeed = subscribe(memberId, "https://star.example/feed", null);
  check("error" in starFeed === false, "member subscribes within the limit");
  const feedId = "error" in starFeed ? 0 : starFeed.feedId;

  const now = Date.now();
  const insertArticle = db.query("INSERT INTO article (feed_id, guid, title, published_at, fetched_at) VALUES (?, ?, ?, ?, ?)");
  insertArticle.run(feedId, "g1", "one", now, now);
  insertArticle.run(feedId, "g2", "two", now, now);
  const [a1, a2] = db.query<{ id: number }, []>("SELECT id FROM article ORDER BY id").all().map((r) => r.id);

  setLimits({ maxStarred: 1 });
  check(setArticleState(memberId, a1!, { starred: true }) === null, "first star is allowed");
  check(countStarred(memberId) === 1, "star is recorded");

  const overLimit = setArticleState(memberId, a2!, { starred: true });
  check(overLimit !== null && overLimit.status === 409, "star limit rejects the second star");
  check(countStarred(memberId) === 1, "rejected star was not recorded");

  check(setArticleState(memberId, a1!, { starred: true }) === null, "re-starring the same article is not a limit hit");
  check(setArticleState(memberId, a1!, { starred: false }) === null, "unstarring is allowed at the limit");
  check(setArticleState(memberId, 999999, { starred: true })?.status === 404, "unknown article is 404, not a limit error");
  check(setArticleState(adminId, a1!, { read: true })?.status === 404, "article from another user's feed is 404");

  // ---------------------------------------------------------------- tags
  const tech = createTag(memberId, "Tech");
  check("error" in tech === false, "create a tag");
  const techId = "error" in tech ? 0 : tech.id;
  const techAgain = createTag(memberId, "tech");
  check("error" in techAgain === false && techAgain.id === techId, "same tag in any case returns the existing one");
  check("error" in addArticleTag(memberId, a1!, { tagId: techId }) === false, "attach an existing tag");
  check("error" in addArticleTag(memberId, a1!, { name: "News" }) === false, "attach-by-name creates the tag");
  check(articleTags(memberId, a1!).length === 2, "article carries both tags");
  check("error" in addArticleTag(memberId, a2!, { tagId: techId }) === false, "attach the same tag to a second article");

  const techRow = listTags(memberId).find((t) => t.id === techId)!;
  check(techRow.count === 2 && techRow.unread === 2, "tag counts articles and unread");
  check(listTags(memberId).find((t) => t.name === "News")!.count === 1, "on-demand tag is listed");

  const foreign = addArticleTag(adminId, a1!, { tagId: techId });
  check("error" in foreign && foreign.status === 404, "cannot tag an article you do not own");
  check(renameTag(memberId, techId, "news")?.status === 409, "rename refuses a case-insensitive clash");
  check(renameTag(memberId, techId, "  ")?.status === 400, "blank tag name refused");
  check(renameTag(memberId, techId, "Tech News") === null, "rename succeeds");

  removeArticleTag(memberId, a1!, techId);
  check(articleTags(memberId, a1!).length === 1, "detach removes just that tag");
  deleteTag(memberId, techId);
  check(listTags(memberId).every((t) => t.id !== techId), "deleting a tag removes it from the list");
  check(articleTags(memberId, a1!).every((t) => t.id !== techId), "deleting a tag detaches it from articles");

  // ---------------------------------------------------------------- article data migration
  setLimits({ maxSubscriptions: 0, maxStarred: 0 });
  const importJson = JSON.stringify({
    items: [
      {
        guid: "imp-1",
        title: "Imported one",
        author: "Alice",
        content: "<p>hello import</p>",
        published: 1700000000,
        origin: { feedUrl: "https://import.example/feed.xml", title: "Import Feed" },
        categories: [
          "user/-/state/com.google/reading-list",
          "user/-/state/com.google/read",
          "user/-/state/com.google/starred",
          "user/-/label/Imported",
        ],
      },
      {
        guid: "imp-2",
        title: "Imported unread",
        url: "https://import.example/two",
        updated: "2024-01-02T03:04:05Z",
        origin: { streamId: "feed/https://import.example/feed.xml" },
        categories: ["user/-/state/com.google/unread"],
      },
      { title: "no feed or guid" },
    ],
  });
  const imported = importArticles(memberId, importJson);
  if ("error" in imported) throw new Error("FAIL: import should succeed: " + imported.error);
  check(imported.articles === 2, "import writes missing articles");
  check(imported.feeds === 1, "import subscribes the missing feed");
  check(imported.states === 2 && imported.tags === 1, "import applies read/starred/label state");
  check(imported.skipped === 1, "import skips rows with no feed/guid");
  check("error" in importArticles(memberId, "not json"), "import rejects a non-JSON file");

  const impArticle = db
    .query<{ id: number }, [string]>(
      "SELECT a.id FROM article a JOIN feed f ON f.id = a.feed_id WHERE f.feed_url = ? AND a.guid = 'imp-1'",
    )
    .get("https://import.example/feed.xml")!;
  const impState = db
    .query<{ read: number; starred: number }, [number, number]>(
      "SELECT read, starred FROM article_state WHERE user_id = ? AND article_id = ?",
    )
    .get(memberId, impArticle.id);
  check(impState?.read === 1 && impState?.starred === 1, "imported state is persisted");
  check(articleTags(memberId, impArticle.id).some((t) => t.name === "Imported"), "imported label becomes a tag");

  const exported = exportArticles(memberId, "Member");
  const exportedItem: any = exported.items.find((i: any) => i.guid === "imp-1");
  check(
    exportedItem &&
      exportedItem.categories.includes("user/-/state/com.google/read") &&
      exportedItem.categories.includes("user/-/state/com.google/starred") &&
      exportedItem.categories.includes("user/-/label/Imported") &&
      exportedItem.origin.feedUrl === "https://import.example/feed.xml" &&
      exportedItem.content.content === "<p>hello import</p>",
    "export round-trips read/starred/label/content",
  );
  const unreadItem: any = exported.items.find((i: any) => i.guid === "imp-2");
  check(unreadItem && unreadItem.categories.includes("user/-/state/com.google/unread"), "export reports unread state");

  // ---------------------------------------------------------------- ZIP archive import
  const archive = makeZip([
    {
      name: "feeds.opml.xml",
      text: `<opml><body><outline type="rss" text="Zip" xmlUrl="https://zip.example/feed.xml"/></body></opml>`,
    },
    {
      name: "00000000.json",
      text: JSON.stringify({
        version: 1,
        articles: [
          {
            guid: "zip-1",
            title: "Zip article",
            content: "<p>z</p>",
            feed_url: "https://zip.example/feed.xml",
            feed_title: "Zip Feed",
            unread: 1,
            marked: 1,
            updated: "2024-02-03T04:05:06Z",
            label_cache: JSON.stringify([["x", "ZipLabel"]]),
          },
        ],
      }),
    },
  ]);
  const arch = importArchive(memberId, archive);
  if ("error" in arch) throw new Error("FAIL: archive import should succeed: " + arch.error);
  check(arch.feeds === 1, "zip: OPML member subscribes the feed");
  check(arch.articles === 1 && arch.tags === 1, "zip: tt-rss batch inserts article + label");
  check("error" in importArchive(memberId, new Uint8Array([1, 2, 3])), "zip: non-zip bytes are rejected");
  check(
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) n FROM subscription s JOIN feed f ON f.id = s.feed_id WHERE s.user_id = ? AND f.feed_url = ?",
      )
      .get(memberId, "https://zip.example/feed.xml")!.n === 1,
    "zip feed is subscribed",
  );

  console.log("\ncore checks passed");
} finally {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
}
