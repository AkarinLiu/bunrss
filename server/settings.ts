import { db } from "./db";

export interface Limits {
  maxSubscriptions: number;
  maxStarred: number;
  maxUsers: number;
}

const selectValue = db.query<{ value: string }, [string]>("SELECT value FROM setting WHERE key = ?");
const upsertValue = db.query(
  "INSERT INTO setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

/** 0 (or unset/garbage) means unlimited. */
export function getLimit(key: "max_subscriptions" | "max_starred" | "max_users"): number {
  const row = selectValue.get(key);
  const n = row ? Number(row.value) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function limits(): Limits {
  return {
    maxSubscriptions: getLimit("max_subscriptions"),
    maxStarred: getLimit("max_starred"),
    maxUsers: getLimit("max_users"),
  };
}

export function setLimits(patch: Partial<Limits>): Limits {
  const clamp = (v: number) => String(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  if (typeof patch.maxSubscriptions === "number") upsertValue.run("max_subscriptions", clamp(patch.maxSubscriptions));
  if (typeof patch.maxStarred === "number") upsertValue.run("max_starred", clamp(patch.maxStarred));
  if (typeof patch.maxUsers === "number") upsertValue.run("max_users", clamp(patch.maxUsers));
  return limits();
}

export interface AdminSettings extends Limits {
  allowRegistration: boolean;
}

/** Registration is open unless an admin explicitly closed it (default preserves pre-switch behavior). */
export function allowRegistration(): boolean {
  return selectValue.get("allow_registration")?.value !== "0";
}

export function adminSettings(): AdminSettings {
  return { ...limits(), allowRegistration: allowRegistration() };
}

export function setAdminSettings(patch: Partial<AdminSettings>): AdminSettings {
  setLimits(patch);
  if (typeof patch.allowRegistration === "boolean")
    upsertValue.run("allow_registration", patch.allowRegistration ? "1" : "0");
  return adminSettings();
}
