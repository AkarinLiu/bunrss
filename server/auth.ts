import { db } from "./db";
import { allowRegistration, getLimit } from "./settings";
import { mailEnabled, sendMail, verificationEmail } from "./mail";
import { translate, type Locale, type MessageKey } from "./i18n";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearCookie,
  err,
  json,
  parseCookies,
  sessionCookie,
} from "./http";

export interface User {
  id: number;
  email: string;
  username: string | null;
  is_admin: number;
  created_at: number;
}

const selectUserBySession = db.query<User, [string, number]>(
  `SELECT u.id, u.email, u.username, u.is_admin, u.created_at
   FROM session s JOIN user u ON u.id = s.user_id
   WHERE s.id = ? AND s.expires_at > ?`,
);

export function currentUser(req: Request): User | null {
  const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!token) return null;
  return selectUserBySession.get(token, Date.now()) ?? null;
}

export function sessionToken(req: Request): string | null {
  return parseCookies(req.headers.get("cookie"))[SESSION_COOKIE] ?? null;
}

/** True while the instance has no users yet — the setup wizard is the only way in. */
export function needsSetup(): boolean {
  return db.query<{ n: number }, []>("SELECT COUNT(*) n FROM user").get()!.n === 0;
}

const recordLogin = db.query("INSERT INTO login_log (user_id, ip, created_at) VALUES (?, ?, ?)");

/** Every new session also records where it came from — register, setup and login all funnel here. */
function newSession(userId: number, ip: string | null): string {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  db.query("INSERT INTO session (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    Date.now() + SESSION_TTL_MS,
  );
  recordLogin.run(userId, ip, Date.now());
  return token;
}

/** Usernames keep their case; 3-32 letters (any case), digits, underscore or hyphen. Uniqueness is case-insensitive. */
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

/**
 * Shared account creation, no session side effects. Returns the persisted (normalized) row or the
 * reason it was refused. `cap` applies the max_users limit; `setupGuard` enforces the one-admin wizard.
 */
async function createAccount(
  email: string,
  username: string,
  password: string,
  isAdmin: 0 | 1,
  verified: boolean,
  { cap, setupGuard }: { cap: boolean; setupGuard: boolean },
): Promise<
  | { id: number; email: string; username: string }
  | { status: number; key: MessageKey }
> {
  email = email.trim().toLowerCase();
  username = username.trim();
  if (!email.includes("@") || password.length < 6) return { status: 400, key: "auth.invalidEmailPassword" };
  if (!USERNAME_RE.test(username)) return { status: 400, key: "auth.usernameRule" };
  const hash = await Bun.password.hash(password);
  let id: number | null = null;
  let reason = "email"; // one of email | username | cap | setup
  db.transaction(() => {
    if (setupGuard && isAdmin && !needsSetup()) return (reason = "setup"); // single-shot: whoever gets here first wins
    const dupEmail = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM user WHERE email = ?").get(email)!;
    if (dupEmail.n > 0) return; // reason stays "email"
    const dupName = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM user WHERE username = ? COLLATE NOCASE")
      .get(username)!;
    if (dupName.n > 0) return (reason = "username");
    if (cap && !isAdmin) {
      const max = getLimit("max_users");
      if (max > 0 && db.query<{ n: number }, []>("SELECT COUNT(*) n FROM user").get()!.n >= max) return (reason = "cap");
    }
    id = db
      .query<{ id: number }, [string, string, string, number, number, number]>(
        "INSERT INTO user (email, username, password_hash, created_at, is_admin, email_verified) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(email, username, hash, Date.now(), isAdmin, verified ? 1 : 0)!.id;
  })();
  if (id === null) {
    const failure: Record<string, { status: number; key: MessageKey }> = {
      setup: { status: 409, key: "auth.setupDone" },
      username: { status: 409, key: "auth.usernameTaken" },
      cap: { status: 403, key: "auth.userCapReached" },
      email: { status: 409, key: "auth.emailTaken" },
    };
    return failure[reason]!;
  }
  return { id, email, username };
}

async function createUser(
  email: string,
  username: string,
  password: string,
  isAdmin: 0 | 1,
  ip: string | null,
  locale: Locale = "zh-CN",
  { verify = false, origin = "" }: { verify?: boolean; origin?: string } = {},
): Promise<Response> {
  const r = await createAccount(email, username, password, isAdmin, !verify, { cap: true, setupGuard: true });
  if ("status" in r) return err(r.status, translate(locale, r.key));
  // Unverified sign-ups get no session and no user payload — just a token mailed to them.
  if (verify) {
    sendVerification(r.id, r.email, origin, locale);
    return json({ pendingVerification: true, email: r.email });
  }
  const token = newSession(r.id, ip);
  return json(
    { id: r.id, email: r.email, username: r.username, is_admin: isAdmin },
    { headers: { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000) } },
  );
}

/**
 * Admin-provisioned account: bypasses the registration switch and the max_users cap (the admin is
 * authoritative), never signs the admin in as the new user, and may grant admin directly.
 */
export async function adminCreateUser(
  email: string,
  username: string,
  password: string,
  isAdmin: boolean,
  locale: Locale = "zh-CN",
): Promise<Response> {
  const r = await createAccount(email, username, password, isAdmin ? 1 : 0, true, { cap: false, setupGuard: false });
  if ("status" in r) return err(r.status, translate(locale, r.key));
  return json({ id: r.id, email: r.email, username: r.username, is_admin: isAdmin ? 1 : 0 });
}

/** Regular sign-up: never admin, and closed entirely when an admin turns registration off. */
export async function register(
  email: string,
  username: string,
  password: string,
  ip: string | null = null,
  locale: Locale = "zh-CN",
  origin = "",
): Promise<Response> {
  if (!allowRegistration()) return err(403, translate(locale, "auth.registrationClosed"));
  return createUser(email, username, password, 0, ip, locale, { verify: mailEnabled(), origin });
}

/** First-run wizard: creates the one admin account, refused once any user exists. */
export const setupAdmin = (
  email: string,
  username: string,
  password: string,
  ip: string | null = null,
  locale: Locale = "zh-CN",
) => createUser(email, username, password, 1, ip, locale);

/**
 * Assigns a username to an account that has none (legacy rows predating the column).
 * Existing usernames are immutable, so this refuses once one is set.
 */
export function setUsername(userId: number, username: string, locale: Locale = "zh-CN"): Response {
  username = username.trim();
  if (!USERNAME_RE.test(username)) return err(400, translate(locale, "auth.usernameRule"));
  const row = db.query<{ username: string | null }, [number]>("SELECT username FROM user WHERE id = ?").get(userId);
  if (!row) return err(404, "not found");
  if (row.username !== null) return err(409, translate(locale, "auth.usernameImmutable"));
  const taken = db
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) n FROM user WHERE username = ? COLLATE NOCASE AND id != ?",
    )
    .get(username, userId)!;
  if (taken.n > 0) return err(409, translate(locale, "auth.usernameTaken"));
  db.query("UPDATE user SET username = ? WHERE id = ?").run(username, userId);
  return json({ ok: true, username });
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_MIN_MS = 60 * 1000;

/** Mints a fresh single-use token (replacing any previous one) and mails the link. */
function sendVerification(userId: number, email: string, origin: string, locale: Locale): void {
  const token = crypto.randomUUID().replace(/-/g, "");
  db.query("UPDATE user SET verify_token = ?, verify_sent_at = ? WHERE id = ?").run(token, Date.now(), userId);
  const link = `${origin.replace(/\/+$/, "")}/verify?token=${token}`;
  const { subject, text, html } = verificationEmail(link, locale);
  // fire-and-forget: a slow/unreachable SMTP server must not stall the request; the user can resend
  void sendMail(email, subject, text, html).catch((e) => console.error("[mail] verification send failed:", e));
}

/** Completes verification for a token; single-use, 24h expiry. */
export function verifyEmail(token: string, locale: Locale = "zh-CN"): Response {
  const row = db
    .query<{ id: number; verify_sent_at: number | null }, [string]>(
      "SELECT id, verify_sent_at FROM user WHERE verify_token = ?",
    )
    .get(token);
  if (!row || !row.verify_sent_at || Date.now() - row.verify_sent_at > VERIFY_TTL_MS) {
    return err(400, translate(locale, "auth.verifyInvalid"));
  }
  db.query("UPDATE user SET email_verified = 1, verify_token = NULL, verify_sent_at = NULL WHERE id = ?").run(row.id);
  return json({ ok: true });
}

/** Resends a verification link. Always reports success so it can't be used to probe which emails exist. */
export async function resendVerification(email: string, locale: Locale = "zh-CN", origin = ""): Promise<Response> {
  if (!mailEnabled()) return json({ ok: true });
  email = email.trim().toLowerCase();
  const row = db
    .query<{ id: number; email: string; email_verified: number; verify_sent_at: number | null }, [string]>(
      "SELECT id, email, email_verified, verify_sent_at FROM user WHERE email = ?",
    )
    .get(email);
  if (row && row.email_verified === 0 && (!row.verify_sent_at || Date.now() - row.verify_sent_at > RESEND_MIN_MS)) {
    sendVerification(row.id, row.email, origin, locale);
  }
  return json({ ok: true });
}

export async function login(
  identifier: string,
  password: string,
  ip: string | null = null,
  locale: Locale = "zh-CN",
): Promise<Response> {
  identifier = identifier.trim().toLowerCase();
  const row = db
    .query<
      { id: number; email: string; username: string | null; is_admin: number; password_hash: string; email_verified: number },
      [string, string]
    >(
      "SELECT id, email, username, is_admin, password_hash, email_verified FROM user WHERE email = ? OR username = ? COLLATE NOCASE",
    )
    .get(identifier, identifier);
  if (!row || !(await Bun.password.verify(password, row.password_hash))) {
    return err(401, translate(locale, "auth.invalidCredentials"));
  }
  // Forced verification: no session until the address is confirmed. Skipped when mail is off, so a
  // half-registered account is never permanently locked out if SMTP is later removed.
  if (mailEnabled() && row.email_verified === 0) {
    return err(403, translate(locale, "auth.emailUnverified"), "email_unverified");
  }
  const token = newSession(row.id, ip);
  return json(
    { id: row.id, email: row.email, username: row.username, is_admin: row.is_admin },
    { headers: { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000) } },
  );
}

export function logout(req: Request): Response {
  const token = sessionToken(req);
  if (token) db.query("DELETE FROM session WHERE id = ?").run(token);
  return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
}
