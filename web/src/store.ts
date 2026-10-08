import { defineStore } from "pinia";
import { api, type Article, type ArticleDetail, type ArticleTag, type Category, type Feed, type LimitState, type Tag, type User } from "./api";

export const useAuth = defineStore("auth", {
  state: () => ({
    user: null as User | null,
    needsSetup: false,
    allowRegistration: true,
    ready: false,
    // set while a sign-up (or unverified login) is awaiting email confirmation
    pendingEmail: "",
  }),
  actions: {
    async boot() {
      try {
        const s = await api.setupStatus();
        this.needsSetup = s.needsSetup;
        this.allowRegistration = s.allowRegistration;
        this.user = this.needsSetup ? null : await api.me();
      } catch {
        this.user = null;
      } finally {
        this.ready = true;
      }
    },
    async setup(email: string, username: string, password: string) {
      this.user = await api.setup(email, username, password);
      this.pendingEmail = "";
      this.needsSetup = false;
    },
    async login(identifier: string, password: string) {
      this.user = await api.login(identifier, password);
      this.pendingEmail = "";
    },
    async register(email: string, username: string, password: string) {
      const res = await api.register(email, username, password);
      if ("pendingVerification" in res) {
        this.pendingEmail = res.email;
        return;
      }
      this.pendingEmail = "";
      this.user = res;
    },
    async resend(email: string) {
      await api.resendVerification(email);
      this.pendingEmail = email;
    },
    async setUsername(username: string) {
      const res = await api.setUsername(username);
      if (this.user) this.user.username = res.username;
    },
    async logout() {
      await api.logout().catch(() => {});
      this.user = null;
    },
  },
});

export const useFeeds = defineStore("feeds", {
  state: () => ({
    feeds: [] as Feed[],
    categories: [] as Category[],
    tags: [] as Tag[],
    unreadTotal: 0,
    byCategory: [] as { category_id: number; unread: number }[],
    limits: null as LimitState | null,
    refreshing: false,
  }),
  getters: {
    unreadByFeed: (s) => Object.fromEntries(s.feeds.map((f) => [f.feed_id, f.unread])) as Record<number, number>,
    atSubscriptionLimit: (s) => !!s.limits && s.limits.maxSubscriptions > 0 && s.limits.subscriptions >= s.limits.maxSubscriptions,
  },
  actions: {
    async load() {
      const [feeds, categories, unread, limits, tags] = await Promise.all([
        api.feeds(),
        api.categories(),
        api.unread(),
        api.limits(),
        api.tags(),
      ]);
      this.feeds = feeds;
      this.categories = categories;
      this.unreadTotal = unread.total;
      this.byCategory = unread.byCategory;
      this.limits = limits;
      this.tags = tags;
    },
    async subscribe(url: string, categoryId?: number | null) {
      await api.subscribe(url, categoryId);
      await this.load();
    },
    async unsubscribe(feedId: number) {
      await api.unsubscribe(feedId);
      await this.load();
    },
    async refresh() {
      this.refreshing = true;
      try {
        await api.refresh();
        await this.load();
      } finally {
        this.refreshing = false;
      }
    },
    async createTag(name: string) {
      await api.createTag(name);
      await this.load();
    },
    async renameTag(id: number, name: string) {
      await api.renameTag(id, name);
      await this.load();
    },
    async deleteTag(id: number) {
      await api.deleteTag(id);
      await this.load();
    },
  },
});

export const useArticles = defineStore("articles", {
  state: () => ({
    list: [] as Article[],
    current: null as ArticleDetail | null,
    loading: false,
    exhausted: false,
  }),
  actions: {
    async load(filter: Parameters<typeof api.articles>[0]) {
      this.loading = true;
      try {
        // list is bounded per view; no infinite scroll for now
        this.list = await api.articles({ ...filter, limit: 200 });
        this.exhausted = this.list.length < 200;
      } finally {
        this.loading = false;
      }
    },
    async select(id: number) {
      this.current = await api.article(id);
      const item = this.list.find((a) => a.id === id);
      if (item && !item.read) {
        item.read = 1;
        await api.setArticle(id, { read: true }).catch(() => {});
      }
    },
    async setRead(a: { id: number; read: number }, read: boolean) {
      a.read = read ? 1 : 0;
      await api.setArticle(a.id, { read }).catch(() => {});
    },
    async setStarred(a: { id: number; starred: number }, starred: boolean) {
      const previous = a.starred;
      a.starred = starred ? 1 : 0;
      try {
        await api.setArticle(a.id, { starred });
      } catch (e) {
        a.starred = previous; // e.g. star quota reached — don't pretend it worked
        throw e;
      }
    },
    async addTag(id: number, ref: { tagId: number } | { name: string }) {
      const tag = await api.tagArticle(id, ref);
      if (this.current?.id === id && !this.current.tags.some((t) => t.id === tag.id)) {
        this.current.tags.push(tag);
      }
    },
    async removeTag(id: number, tagId: number) {
      await api.untagArticle(id, tagId);
      if (this.current?.id === id) this.current.tags = this.current.tags.filter((t) => t.id !== tagId);
    },
  },
});

export type Theme = "light" | "dark" | "system";

const prefersDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** Saved theme, migrating the old boolean `bunrss:dark` preference; defaults to following the OS. */
function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem("bunrss:theme");
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
    const legacy = localStorage.getItem("bunrss:dark");
    if (legacy === "1") return "dark";
    if (legacy === "0") return "light";
  } catch {
    // no localStorage (e.g. non-browser test)
  }
  return "system";
}

let themeListenerAttached = false;

export const useUi = defineStore("ui", {
  state: () => ({
    theme: initialTheme(),
    systemDark: prefersDark(),
    autoRefresh: localStorage.getItem("bunrss:autoRefresh") !== "0",
  }),
  getters: {
    dark: (s) => (s.theme === "system" ? s.systemDark : s.theme === "dark"),
  },
  actions: {
    /** Applies the theme and, once, subscribes to OS color-scheme changes. */
    init() {
      this.apply();
      if (themeListenerAttached || typeof matchMedia !== "function") return;
      themeListenerAttached = true;
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        this.systemDark = e.matches;
        this.apply();
      });
    },
    apply() {
      document.documentElement.classList.toggle("dark", this.dark);
      try {
        localStorage.setItem("bunrss:theme", this.theme);
      } catch {
        // ignore
      }
    },
    setTheme(theme: Theme) {
      this.theme = theme;
      this.apply();
    },
    toggle() {
      this.setTheme(this.dark ? "light" : "dark");
    },
    toggleAutoRefresh() {
      this.autoRefresh = !this.autoRefresh;
      localStorage.setItem("bunrss:autoRefresh", this.autoRefresh ? "1" : "0");
    },
  },
});
