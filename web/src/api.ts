import { locale, t } from "./i18n";

export interface User {
  id: number;
  email: string;
  username: string | null;
  is_admin: number;
}
export interface Feed {
  subscription_id: number;
  feed_id: number;
  title: string;
  feed_url: string;
  site_url: string | null;
  icon_url: string | null;
  description: string | null;
  category_id: number | null;
  last_error: string | null;
  unread: number;
}
export interface Category {
  id: number;
  name: string;
  sort_order: number;
}
export interface DiscoveredFeed {
  title: string;
  url: string;
}
export interface Article {
  id: number;
  feed_id: number;
  title: string | null;
  link: string | null;
  author: string | null;
  summary: string | null;
  published_at: number | null;
  read: number;
  starred: number;
  feed_title: string;
}
export interface ArticleDetail extends Article {
  content: string | null;
  tags: ArticleTag[];
}
export interface ArticleTag {
  id: number;
  name: string;
}
export interface Tag extends ArticleTag {
  count: number;
  unread: number;
}
export interface Limits {
  maxSubscriptions: number;
  maxStarred: number;
  maxUsers: number;
}
export interface AdminSettings extends Limits {
  allowRegistration: boolean;
}
export interface LimitState extends Limits {
  subscriptions: number;
  starred: number;
}
export interface AdminOverview {
  users: number;
  admins: number;
  feeds: number;
  subscriptions: number;
  articles: number;
  starred: number;
  limits: Limits;
  bun: string;
  uptimeSeconds: number;
}
export interface AdminUser {
  id: number;
  email: string;
  username: string | null;
  is_admin: number;
  created_at: number;
  subscriptions: number;
  starred: number;
  unread: number;
  last_login_ip: string | null;
  last_login_at: number | null;
}
export interface ApiToken {
  id: number;
  token: string; // full value only in the create response; masked in lists
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** The feed's site icon: the one the site declares, else the guessed /favicon.ico. */
export function feedIconUrl(feed: { site_url: string | null; feed_url: string; icon_url?: string | null }): string | null {
  return feed.icon_url || fallbackIconUrl(feed);
}

/** Last-resort icon: /favicon.ico at the site (or feed) origin. */
export function fallbackIconUrl(feed: { site_url: string | null; feed_url: string }): string | null {
  for (const raw of [feed.site_url, feed.feed_url]) {
    if (!raw) continue;
    try {
      return new URL(raw).origin + "/favicon.ico";
    } catch {
      // not a parseable URL, try the next candidate
    }
  }
  return null;
}

/** Seconds → "1天2小时3分钟4秒", omitting zero units (e.g. 3661 → "1小时1分钟1秒"). */
export function formatUptime(total: number): string {
  const units: [number, string][] = [
    [86400, t("time.day")],
    [3600, t("time.hour")],
    [60, t("time.minute")],
    [1, t("time.second")],
  ];
  let rest = Math.max(0, Math.floor(total));
  const parts = units.flatMap(([n, label]) => {
    const v = Math.floor(rest / n);
    rest -= v * n;
    return v > 0 ? [`${v}${label}`] : [];
  });
  return parts.join("") || `0${t("time.second")}`;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      // server error messages follow the active UI language
      "accept-language": locale.value,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) window.dispatchEvent(new Event("bunrss:unauthorized"));
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data as { error?: string } | null)?.error ?? res.statusText) as Error & {
      status?: number;
      code?: string;
    };
    e.status = res.status;
    e.code = (data as { code?: string } | null)?.code;
    throw e;
  }
  return data as T;
}

export interface ArticleFilter {
  feedId?: number;
  categoryId?: number;
  tagId?: number;
  unread?: boolean;
  starred?: boolean;
  q?: string;
  offset?: number;
  limit?: number;
}

export const api = {
  setupStatus: () => req<{ needsSetup: boolean; allowRegistration: boolean }>("GET", "/setup/status"),
  setup: (email: string, username: string, password: string) =>
    req<User>("POST", "/setup", { email, username, password }),

  me: () => req<User>("GET", "/auth/me"),
  login: (identifier: string, password: string) => req<User>("POST", "/auth/login", { email: identifier, password }),
  register: (email: string, username: string, password: string) =>
    req<User | { pendingVerification: true; email: string }>("POST", "/auth/register", { email, username, password }),
  verifyEmail: (token: string) => req<{ ok: true }>("POST", "/auth/verify", { token }),
  resendVerification: (email: string) => req<{ ok: true }>("POST", "/auth/resend", { email }),
  setUsername: (username: string) => req<{ ok: true; username: string }>("PATCH", "/auth/me", { username }),
  logout: () => req<{ ok: true }>("POST", "/auth/logout"),

  feeds: () => req<Feed[]>("GET", "/feeds"),
  discover: (url: string) => req<DiscoveredFeed[]>("GET", `/discover?url=${encodeURIComponent(url)}`),
  subscribe: (url: string, categoryId?: number | null) =>
    req<Feed>("POST", "/feeds", { url, categoryId }),
  updateFeed: (feedId: number, patch: { customTitle?: string | null; categoryId?: number | null }) =>
    req<{ ok: true }>("PATCH", `/feeds/${feedId}`, patch),
  unsubscribe: (feedId: number) => req<{ ok: true }>("DELETE", `/feeds/${feedId}`),

  categories: () => req<Category[]>("GET", "/categories"),
  createCategory: (name: string) => req<Category>("POST", "/categories", { name }),
  renameCategory: (id: number, name: string) => req<{ ok: true }>("PATCH", `/categories/${id}`, { name }),
  deleteCategory: (id: number) => req<{ ok: true }>("DELETE", `/categories/${id}`),

  tags: () => req<Tag[]>("GET", "/tags"),
  createTag: (name: string) => req<ArticleTag>("POST", "/tags", { name }),
  renameTag: (id: number, name: string) => req<{ ok: true }>("PATCH", `/tags/${id}`, { name }),
  deleteTag: (id: number) => req<{ ok: true }>("DELETE", `/tags/${id}`),
  tagArticle: (articleId: number, ref: { tagId: number } | { name: string }) =>
    req<ArticleTag>("POST", `/articles/${articleId}/tags`, ref),
  untagArticle: (articleId: number, tagId: number) =>
    req<{ ok: true }>("DELETE", `/articles/${articleId}/tags/${tagId}`),

  articles: (f: ArticleFilter) => {
    const sp = new URLSearchParams();
    if (f.feedId) sp.set("feedId", String(f.feedId));
    if (f.categoryId) sp.set("categoryId", String(f.categoryId));
    if (f.tagId) sp.set("tagId", String(f.tagId));
    if (f.unread) sp.set("unread", "1");
    if (f.starred) sp.set("starred", "1");
    if (f.q) sp.set("q", f.q);
    if (f.limit) sp.set("limit", String(f.limit));
    if (f.offset) sp.set("offset", String(f.offset));
    return req<Article[]>("GET", `/articles?${sp}`);
  },
  article: (id: number) => req<ArticleDetail>("GET", `/articles/${id}`),
  setArticle: (id: number, patch: { read?: boolean; starred?: boolean }) =>
    req<{ ok: true }>("PATCH", `/articles/${id}`, patch),
  extract: (id: number) => req<{ ok: true }>("POST", `/articles/${id}/extract`),
  markAllRead: (f: { feedId?: number; categoryId?: number }) =>
    req<{ ok: true }>("POST", "/articles/mark-all-read", f),

  unread: () => req<{ total: number; byCategory: { category_id: number; unread: number }[] }>("GET", "/unread"),
  limits: () => req<LimitState>("GET", "/limits"),
  refresh: () => req<{ ok: true }>("POST", "/refresh"),
  refreshStale: () => req<{ ok: true }>("POST", "/refresh?stale=1"),

  tokens: () => req<ApiToken[]>("GET", "/tokens"),
  createToken: (label?: string) => req<ApiToken>("POST", "/tokens", { label }),
  revokeToken: (id: number) => req<{ ok: true }>("DELETE", `/tokens/${id}`),

  admin: {
    overview: () => req<AdminOverview>("GET", "/admin/overview"),
    users: () => req<AdminUser[]>("GET", "/admin/users"),
    createUser: (email: string, username: string, password: string, isAdmin: boolean) =>
      req<User>("POST", "/admin/users", { email, username, password, isAdmin }),
    setAdmin: (id: number, isAdmin: boolean) => req<{ ok: true }>("PATCH", `/admin/users/${id}`, { isAdmin }),
    deleteUser: (id: number) => req<{ ok: true }>("DELETE", `/admin/users/${id}`),
    settings: () => req<AdminSettings>("GET", "/admin/settings"),
    updateSettings: (patch: Partial<AdminSettings>) => req<AdminSettings>("PATCH", "/admin/settings", patch),
    tokens: (userId: number) => req<ApiToken[]>("GET", `/admin/users/${userId}/tokens`),
    createToken: (userId: number, label?: string) => req<ApiToken>("POST", `/admin/users/${userId}/tokens`, { label }),
    deleteToken: (id: number) => req<{ ok: true }>("DELETE", `/admin/tokens/${id}`),
  },

  importOpml: (xml: string) =>
    fetch("/api/opml", {
      method: "POST",
      headers: { "content-type": "text/xml", "accept-language": locale.value },
      body: xml,
    }).then((r) => r.json() as Promise<{ imported: number }>),

  importData: async (file: Blob) => {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "accept-language": locale.value },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? res.statusText);
    return data as { feeds: number; articles: number; states: number; tags: number; skipped: number };
  },
};
