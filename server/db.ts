import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyMigrations } from "./migrate";

const path = resolve(process.env.DATABASE_URL ?? "./data/bunrss.db");
mkdirSync(dirname(path), { recursive: true });

export const db = new Database(path, { create: true });
// foreign_keys is OFF by default in SQLite -> relations/cascades are dead without it
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

// schema must exist before any module prepares statements against it (FTS triggers reference article_fts)
applyMigrations(db);
