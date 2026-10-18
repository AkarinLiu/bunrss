<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DOMPurify from "dompurify";
import { api, type ArticleFilter, type ArticleTag, type WatchNotification } from "../api";
import { useArticles, useAuth, useFeeds, useUi } from "../store";
import { locale, t } from "../i18n";
import FeedIcon from "../components/FeedIcon.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const feeds = useFeeds();
const articles = useArticles();
const ui = useUi();

const addUrl = ref("");
const addCategory = ref<number | null>(null);
const search = ref("");
const adding = ref(false);
const extracting = ref(false);
const sidebarOpen = ref(false);
const notifications = ref<WatchNotification[]>([]);
const notifyUnread = ref(0);
const notifyOpen = ref(false);

const filter = computed<ArticleFilter>(() => {
  if (route.params.feedId) return { feedId: Number(route.params.feedId) };
  if (route.params.categoryId) return { categoryId: Number(route.params.categoryId) };
  if (route.params.tagId) return { tagId: Number(route.params.tagId) };
  if (route.path === "/starred") return { starred: true };
  if (route.path === "/unread") return { unread: true };
  if (route.path === "/search") return { q: String(route.query.q ?? "") };
  return {};
});

const viewTitle = computed(() => {
  if (route.params.feedId) return feeds.feeds.find((f) => f.feed_id === Number(route.params.feedId))?.title ?? t("nav.subscription");
  if (route.params.categoryId) return feeds.categories.find((c) => c.id === Number(route.params.categoryId))?.name ?? t("nav.category");
  if (route.params.tagId) return feeds.tags.find((t2) => t2.id === Number(route.params.tagId))?.name ?? t("nav.tag");
  if (route.path === "/starred") return t("nav.starred");
  if (route.path === "/unread") return t("nav.unread");
  if (route.path === "/search") return t("nav.search", { q: route.query.q ?? "" });
  return t("nav.all");
});

const grouped = computed(() => ({
  cats: feeds.categories.map((c) => ({ ...c, feeds: feeds.feeds.filter((f) => f.category_id === c.id) })),
  uncat: feeds.feeds.filter((f) => f.category_id === null),
}));

const currentFeed = computed(() => feeds.feeds.find((f) => f.feed_id === articles.current?.feed_id) ?? null);

const catUnread = (id: number) => feeds.byCategory.find((b) => b.category_id === id)?.unread ?? 0;

const html = computed(() =>
  DOMPurify.sanitize(articles.current?.content || articles.current?.summary || ""),
);

function relative(ts: number | null): string {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return t("time.justNow");
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t("time.daysAgo", { n: d });
  return new Date(ts).toLocaleDateString(locale.value);
}

async function select(id: number) {
  await articles.select(id);
}

/** Mobile secondary navigation: leave the article and return to the list. */
function closeReader() {
  articles.current = null;
}

async function toggleStar(a: { id: number; starred: number }) {
  try {
    await articles.setStarred(a, !a.starred);
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}

/** Tags not yet on the open article, for the "add tag" dropdown. */
const taggable = computed(() => {
  const have = new Set(articles.current?.tags.map((t) => t.id) ?? []);
  return feeds.tags.filter((t) => !have.has(t.id));
});

async function addTag(tagId: number) {
  if (!articles.current) return;
  await articles.addTag(articles.current.id, { tagId });
  await feeds.load(); // refresh per-tag counts
}

function onPickTag(e: Event) {
  const el = e.target as HTMLSelectElement;
  const id = Number(el.value);
  el.value = "";
  if (id) void addTag(id);
}

async function removeTag(tag: ArticleTag) {
  if (!articles.current) return;
  await articles.removeTag(articles.current.id, tag.id);
  await feeds.load();
}

async function createAndTag() {
  if (!articles.current) return;
  const name = prompt(t("reader.newTagName"));
  if (!name?.trim()) return;
  try {
    await articles.addTag(articles.current.id, { name: name.trim() });
    await feeds.load();
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}

async function subscribe() {
  const url = addUrl.value.trim();
  if (!url) return;
  adding.value = true;
  try {
    await feeds.subscribe(url, addCategory.value);
    addUrl.value = "";
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  } finally {
    adding.value = false;
  }
}

async function runSearch() {
  router.push({ path: "/search", query: { q: search.value } });
}

async function loadNotifications() {
  const res = await api.notifications().catch(() => null);
  if (!res) return;
  notifications.value = res.items;
  notifyUnread.value = res.unread;
}

function toggleNotifications() {
  notifyOpen.value = !notifyOpen.value;
  if (notifyOpen.value) void loadNotifications();
}

async function openNotification(n: WatchNotification) {
  if (!n.read) {
    n.read = 1;
    notifyUnread.value = Math.max(0, notifyUnread.value - 1);
    await api.readNotifications([n.id]).catch(() => {});
  }
  notifyOpen.value = false;
  // Jump into the reader; the watcher below opens the article once the list is loaded.
  router.push({ path: `/feed/${n.feed_id}`, query: { article: String(n.article_id) } });
}

async function readAllNotifications() {
  await api.readNotifications().catch(() => {});
  notifications.value.forEach((n) => (n.read = 1));
  notifyUnread.value = 0;
}

async function markAllRead() {
  await api.markAllRead(filter.value);
  await Promise.all([articles.load(filter.value), feeds.load()]);
}

async function extract() {
  if (!articles.current) return;
  extracting.value = true;
  try {
    await api.extract(articles.current.id);
    await articles.select(articles.current.id);
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  } finally {
    extracting.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
  const list = articles.list;
  const idx = list.findIndex((a) => a.id === articles.current?.id);
  const item = list[idx];
  if (e.key === "j" && idx < list.length - 1) select(list[idx + 1]!.id);
  else if (e.key === "k" && idx > 0) select(list[idx - 1]!.id);
  else if (e.key === "m" && item) articles.setRead(item, !item.read);
  else if (e.key === "s" && item) toggleStar(item);
  else if (e.key === "o" && item?.link) window.open(item.link, "_blank");
}

watch(
  filter,
  async () => {
    articles.current = null;
    await articles.load(filter.value);
  },
  { immediate: true, deep: true },
);

// A notification links to /feed/<id>?article=<id>: open that article as soon as it is in the list.
watch(
  [() => articles.list, () => route.query.article],
  () => {
    const id = Number(route.query.article);
    if (!id || articles.current?.id === id) return;
    if (articles.list.some((a) => a.id === id)) void select(id);
  },
);

// narrow screens: the sidebar is a drawer, so any navigation closes it
watch(
  () => route.fullPath,
  () => {
    sidebarOpen.value = false;
    notifyOpen.value = false;
  },
);

// ---- auto-sync: keep feeds, unread counts and read state fresh ----
const POLL_MS = 60_000; // reload local data (picks up read state set by other clients)
const FETCH_MS = 5 * 60_000; // ask the server to fetch feeds that are >5 min stale
let pollTimer: number | undefined;
let fetchTimer: number | undefined;

async function reloadData() {
  if (document.hidden) return;
  await Promise.all([feeds.load(), articles.load(filter.value), loadNotifications()]);
  const cur = articles.current;
  if (cur) {
    const item = articles.list.find((a) => a.id === cur.id);
    if (item) {
      cur.read = item.read;
      cur.starred = item.starred;
    }
  }
}

async function fetchNew() {
  if (document.hidden) return;
  await api.refreshStale().catch(() => {});
  await reloadData();
}

function startAutoSync() {
  stopAutoSync();
  if (!ui.autoRefresh) return;
  pollTimer = window.setInterval(reloadData, POLL_MS);
  fetchTimer = window.setInterval(fetchNew, FETCH_MS);
}
function stopAutoSync() {
  if (pollTimer) window.clearInterval(pollTimer);
  if (fetchTimer) window.clearInterval(fetchTimer);
  pollTimer = fetchTimer = undefined;
}
function onVisibility() {
  if (!document.hidden) void reloadData();
}

watch(() => ui.autoRefresh, startAutoSync);

onMounted(async () => {
  await feeds.load();
  void loadNotifications();
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  startAutoSync();
  void fetchNew();
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("visibilitychange", onVisibility);
  stopAutoSync();
});

async function logout() {
  await auth.logout();
  router.push("/login");
}
</script>

<template>
  <div class="app" :class="{ 'show-reader': !!articles.current }">
    <!-- ---------------------------------------------------- sidebar -->
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <header>
        <strong>bunrss</strong>
        <span class="spacer" />
        <button class="icon" :class="{ spin: feeds.refreshing }" :title="t('reader.refreshAll')" @click="feeds.refresh()"><i class="fa-solid fa-rotate" /></button>
        <button class="icon bell" :title="t('reader.notifications')" @click="toggleNotifications">
          <i class="fa-solid fa-bell" />
          <span v-if="notifyUnread" class="bell-count">{{ notifyUnread > 99 ? "99+" : notifyUnread }}</span>
        </button>
        <button class="icon" :title="ui.dark ? t('reader.lightMode') : t('reader.darkMode')" @click="ui.toggle()">
          <i :class="ui.dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon'" />
        </button>
        <router-link to="/settings" class="icon" :title="t('settings.title')"><i class="fa-solid fa-gear" /></router-link>
      </header>

      <div v-if="notifyOpen" class="notify-panel">
        <div class="notify-head">
          <strong>{{ t("reader.notifications") }}</strong>
          <span class="spacer" />
          <button v-if="notifyUnread" class="small" @click="readAllNotifications">{{ t("reader.markAllRead") }}</button>
        </div>
        <ul>
          <li v-for="n in notifications" :key="n.id" :class="{ unread: !n.read }">
            <button class="notify-item" @click="openNotification(n)">
              <span class="ellipsis" :title="n.title ?? n.feed_title">{{ n.title || t("common.untitled") }}</span>
              <span class="dim small">{{ n.feed_title }} · {{ t("reader.matched", { words: n.matched }) }} · {{ relative(n.created_at) }}</span>
            </button>
          </li>
        </ul>
        <p v-if="!notifications.length" class="dim small empty">{{ t("reader.noNotifications") }}</p>
      </div>

      <nav class="views">
        <router-link to="/" class="item"><span>{{ t("nav.all") }}</span></router-link>
        <router-link to="/unread" class="item"><span>{{ t("nav.unread") }}</span><span class="badge">{{ feeds.unreadTotal }}</span></router-link>
        <router-link to="/starred" class="item"><span>{{ t("nav.starred") }}</span></router-link>
      </nav>

      <div class="scroll">
        <div v-if="feeds.categories.length || grouped.uncat.length" class="side-head">{{ t("nav.category") }}</div>
        <section v-for="cat in grouped.cats" :key="cat.id">
          <router-link :to="`/category/${cat.id}`" class="item group">
            <span>{{ cat.name }}</span>
            <span v-if="catUnread(cat.id)" class="badge">{{ catUnread(cat.id) }}</span>
          </router-link>
          <router-link v-for="f in cat.feeds" :key="f.feed_id" :to="`/feed/${f.feed_id}`" class="item child">
            <FeedIcon :feed="f" />
            <span class="ellipsis" :title="f.title">{{ f.title }}</span>
            <span v-if="f.unread" class="badge">{{ f.unread }}</span>
            <i v-if="f.last_error" class="fa-solid fa-triangle-exclamation err" :title="t('reader.fetchFailed')" />
          </router-link>
        </section>
        <section>
          <router-link v-for="f in grouped.uncat" :key="f.feed_id" :to="`/feed/${f.feed_id}`" class="item">
            <FeedIcon :feed="f" />
            <span class="ellipsis" :title="f.title">{{ f.title }}</span>
            <span v-if="f.unread" class="badge">{{ f.unread }}</span>
            <i v-if="f.last_error" class="fa-solid fa-triangle-exclamation err" :title="t('reader.fetchFailed')" />
          </router-link>
        </section>
        <section v-if="feeds.tags.length" class="tags">
          <div class="side-head">{{ t("nav.tag") }}</div>
          <router-link v-for="tag in feeds.tags" :key="tag.id" :to="`/tag/${tag.id}`" class="item">
            <span class="ellipsis">{{ tag.name }}</span>
            <span v-if="tag.unread" class="badge">{{ tag.unread }}</span>
          </router-link>
        </section>
      </div>

      <form class="add" @submit.prevent="subscribe">
        <input v-model="addUrl" :placeholder="t('reader.addFeedUrl')" :disabled="feeds.atSubscriptionLimit" />
        <div class="row">
          <select v-model="addCategory" :disabled="feeds.atSubscriptionLimit">
            <option :value="null">{{ t("common.uncategorized") }}</option>
            <option v-for="c in feeds.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="primary" type="submit" :disabled="adding || feeds.atSubscriptionLimit">
            {{ adding ? t("common.adding") : t("reader.subscribe") }}
          </button>
        </div>
        <p v-if="feeds.limits && feeds.limits.maxSubscriptions > 0" class="small quota">
          <span v-if="feeds.atSubscriptionLimit" class="err">{{ t("reader.subscriptionLimit", { n: feeds.limits.maxSubscriptions }) }}</span>
          <span v-else class="dim">{{ t("reader.subscriptionQuota", { subs: feeds.limits.subscriptions, max: feeds.limits.maxSubscriptions }) }}</span>
        </p>
      </form>

      <footer>
        <span class="dim small ellipsis" :title="auth.user?.email">{{ auth.user?.username || auth.user?.email }}</span>
        <button class="icon" :title="t('common.logout')" @click="logout"><i class="fa-solid fa-right-from-bracket" /></button>
      </footer>
    </aside>

    <div v-if="sidebarOpen" class="overlay" @click="sidebarOpen = false" />

    <!-- ---------------------------------------------------- list -->
    <section class="list">
      <header>
        <button class="icon only-mobile" :title="t('reader.feedList')" @click="sidebarOpen = true"><i class="fa-solid fa-bars" /></button>
        <strong class="ellipsis">{{ viewTitle }}</strong>
        <span class="spacer" />
        <button class="small" @click="markAllRead">{{ t("reader.markAllRead") }}</button>
      </header>
      <form class="search" @submit.prevent="runSearch">
        <input v-model="search" :placeholder="t('reader.searchPlaceholder')" />
      </form>
      <div class="items">
        <article
          v-for="a in articles.list"
          :key="a.id"
          class="entry"
          :class="{ active: a.id === articles.current?.id, read: a.read }"
          @click="select(a.id)"
        >
          <div class="row">
            <span class="dot" />
            <span class="ellipsis title">{{ a.title || t("common.untitled") }}</span>
            <button
              class="icon star"
              :class="{ on: a.starred }"
              :title="a.starred ? t('reader.unstar') : t('reader.star')"
              @click.stop="toggleStar(a)"
            >
              <i :class="a.starred ? 'fa-solid fa-star' : 'fa-regular fa-star'" />
            </button>
          </div>
          <div class="dim small ellipsis">{{ a.feed_title }} · {{ relative(a.published_at) }}</div>
        </article>
        <p v-if="!articles.loading && !articles.list.length" class="dim small empty">{{ t("reader.noArticles") }}</p>
      </div>
    </section>

    <!-- ---------------------------------------------------- reader -->
    <main class="reader">
      <template v-if="articles.current">
        <header class="reader-head">
          <button class="icon only-mobile back" @click="closeReader"><i class="fa-solid fa-arrow-left" /> {{ t("common.back") }}</button>
          <h1>{{ articles.current.title || t("common.untitled") }}</h1>
          <div class="dim small">
            <FeedIcon v-if="currentFeed" class="inline-icon" :feed="currentFeed" />
            {{ articles.current.feed_title }}
            <template v-if="articles.current.author"> · {{ articles.current.author }}</template>
            · {{ relative(articles.current.published_at) }}
          </div>
          <div class="row actions">
            <button class="small" @click="toggleStar(articles.current)">
              <i :class="articles.current.starred ? 'fa-solid fa-star' : 'fa-regular fa-star'" />
              {{ articles.current.starred ? t("reader.starOn") : t("reader.starOff") }}
            </button>
            <button class="small" @click="articles.setRead(articles.current, !articles.current.read)">
              {{ articles.current.read ? t("reader.markUnread") : t("reader.markRead") }}
            </button>
            <button class="small" :disabled="extracting" @click="extract">
              {{ extracting ? t("reader.extracting") : t("reader.extract") }}
            </button>
            <a v-if="articles.current.link" :href="articles.current.link" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" /> {{ t("reader.original") }}</a>
            <span v-for="tag in articles.current.tags" :key="tag.id" class="chip">
              {{ tag.name }}
              <button class="icon" :title="t('reader.removeTag')" @click="removeTag(tag)"><i class="fa-solid fa-xmark" /></button>
            </span>
            <select v-if="taggable.length" class="tag-add" @change="onPickTag">
              <option value="">{{ t("reader.addTag") }}</option>
              <option v-for="tag in taggable" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
            </select>
            <button class="small" @click="createAndTag"><i class="fa-solid fa-plus" /> {{ t("reader.newTag") }}</button>
          </div>
        </header>
        <!-- sanitized with DOMPurify -->
        <div class="content" v-html="html" />
      </template>
      <p v-else class="dim empty"><i class="fa-regular fa-file" /> {{ t("reader.selectArticle") }}</p>
    </main>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: grid;
  grid-template-columns: 240px 340px 1fr;
}
.sidebar,
.list,
.reader {
  min-width: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
}
.sidebar {
  background: var(--bg-alt);
  position: relative;
}
.bell {
  position: relative;
}
.bell-count {
  position: absolute;
  top: -3px;
  right: -3px;
  background: var(--danger);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: 999px;
}
.notify-panel {
  position: absolute;
  z-index: 15;
  top: 40px;
  left: 6px;
  right: 6px;
  max-height: 60%;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 15%);
}
.notify-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.notify-panel ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.notify-panel li {
  border-bottom: 1px solid var(--border);
}
.notify-panel li.unread {
  background: var(--accent-soft);
}
.notify-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 0;
  padding: 8px 10px;
}
.notify-item:hover {
  background: var(--bg-hover);
}
.notify-item .ellipsis {
  max-width: 100%;
}
.sidebar header,
.list header,
.sidebar footer,
.add,
.search {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 6px;
}
.sidebar footer {
  border-top: 1px solid var(--border);
  border-bottom: none;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.items {
  flex: 1;
  overflow-y: auto;
}
.views {
  padding: 6px;
  border-bottom: 1px solid var(--border);
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--text);
  text-decoration: none;
}
.item:hover {
  background: var(--bg-hover);
  text-decoration: none;
}
.item.child {
  padding-left: 18px;
}
.item.router-link-active {
  background: var(--accent-soft);
}
.group {
  font-weight: 600;
}
.side-head {
  padding: 8px 8px 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.tags {
  margin-top: 6px;
  border-top: 1px solid var(--border);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 1px 3px 1px 8px;
  font-size: 12px;
}
.chip button {
  padding: 0 3px;
}
.tag-add {
  width: auto;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.err {
  color: var(--danger);
  font-weight: 700;
}
.add {
  flex-direction: column;
  align-items: stretch;
}
.add input,
.add select {
  width: 100%;
}
.add .row select {
  flex: 1;
  min-width: 0;
}
.add .row button {
  flex-shrink: 0;
  white-space: nowrap;
}
.quota {
  margin: 0;
}

.search input {
  width: 100%;
}

.entry {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.entry:hover {
  background: var(--bg-alt);
}
.entry.active {
  background: var(--accent-soft);
}
.entry .title {
  font-weight: 500;
}
.entry.read .title {
  color: var(--text-dim);
  font-weight: 400;
}
.dot {
  display: none;
}
.entry:not(.read) .dot {
  display: block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: 0 0 auto;
}
.empty {
  padding: 20px;
  text-align: center;
}
.star.on {
  color: var(--star);
}

.reader {
  border-right: none;
  overflow-y: auto;
}
.reader-head {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
}
.reader-head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  line-height: 1.3;
}
.inline-icon {
  vertical-align: -3px;
}
.actions {
  margin-top: 10px;
  flex-wrap: wrap;
}
.content {
  padding: 20px 24px 60px;
  max-width: 760px;
  line-height: 1.7;
  overflow-wrap: break-word;
}
.content :deep(img),
.content :deep(video) {
  max-width: 100%;
  height: auto;
}
.content :deep(pre) {
  overflow-x: auto;
  background: var(--bg-alt);
  padding: 10px;
  border-radius: 6px;
}
.content :deep(blockquote) {
  margin: 0;
  padding-left: 12px;
  border-left: 3px solid var(--border);
  color: var(--text-dim);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.back {
  margin-bottom: 6px;
  font-size: 13px;
}
.only-mobile,
.overlay {
  display: none;
}

/* ---- mobile: drawer sidebar + list/reader secondary navigation ---- */
@media (max-width: 768px) {
  .only-mobile {
    display: inline-flex;
    align-items: center;
  }
  .app {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: fixed;
    z-index: 30;
    top: 0;
    bottom: 0;
    left: 0;
    width: 86%;
    max-width: 330px;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    border-right: 1px solid var(--border);
  }
  .sidebar.open {
    transform: translateX(0);
  }
  .overlay {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 20;
    background: rgb(0 0 0 / 40%);
  }
  .list,
  .reader {
    grid-column: 1;
    grid-row: 1;
  }
  .reader {
    display: none;
  }
  .app.show-reader .list {
    display: none;
  }
  .app.show-reader .reader {
    display: flex;
  }
  .item {
    padding: 9px 8px;
  }
  .entry {
    padding: 10px 12px;
  }
  .reader-head {
    padding: 12px 14px;
  }
  .reader-head h1 {
    font-size: 19px;
  }
  .content {
    padding: 16px 14px 60px;
  }
}
</style>
