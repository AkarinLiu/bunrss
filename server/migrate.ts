import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "migrations");

/** Applies every migrations/*.sql not yet recorded, in filename order, each in a transaction. */
export function applyMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    db.query<{ name: string }, []>("SELECT name FROM _migrations").all().map((r) => r.name),
  );
  const record = db.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file, Date.now());
    })();
    console.log(`[migrate] applied ${file}`);
  }
}

if (import.meta.main) {
  const { db } = await import("./db");
  applyMigrations(db);
  console.log("[migrate] up to date");
}
