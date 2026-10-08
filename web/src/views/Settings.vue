<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api, type ApiToken } from "../api";
import { useAuth, useFeeds, useUi, type Theme } from "../store";
import { locale, t } from "../i18n";
import FeedIcon from "../components/FeedIcon.vue";
import LocaleSelect from "../components/LocaleSelect.vue";

const router = useRouter();
const auth = useAuth();
const feeds = useFeeds();
const ui = useUi();

const newCat = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const dataInput = ref<HTMLInputElement | null>(null);
const importingData = ref(false);
const tokens = ref<ApiToken[]>([]);
const origin = window.location.origin;
const newUsername = ref(auth.user?.username ?? "");
const accountMsg = ref("");

const showMax = (n: number) => (n > 0 ? String(n) : t("common.unlimited"));

function setTheme(e: Event) {
  ui.setTheme((e.target as HTMLSelectElement).value as Theme);
}

// Drag-to-bookmarks-bar bookmarklet: opens the quick-subscribe page for the current tab.
const bookmarklet = computed(
  () => `javascript:(function(){window.open('${origin}/subscribe?url='+encodeURIComponent(location.href),'_blank');})()`,
);

onMounted(async () => {
  await feeds.load();
  tokens.value = await api.tokens().catch(() => []);
});

async function saveUsername() {
  accountMsg.value = "";
  try {
    await auth.setUsername(newUsername.value);
    accountMsg.value = t("common.saved");
    setTimeout(() => (accountMsg.value = ""), 2000);
  } catch (e) {
    accountMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function createToken() {
  const label = prompt(t("settings.tokenLabel")) ?? "";
  const t2 = await api.createToken(label || undefined);
  tokens.value.unshift(t2);
  prompt(t("settings.tokenCreated"), t2.token);
}

async function revokeToken(token: ApiToken) {
  if (!confirm(t("settings.revokeTokenConfirm"))) return;
  await api.revokeToken(token.id);
  tokens.value = tokens.value.filter((x) => x.id !== token.id);
}

async function addCategory() {
  if (!newCat.value.trim()) return;
  await api.createCategory(newCat.value.trim());
  newCat.value = "";
  await feeds.load();
}

async function rename(id: number, current: string) {
  const name = prompt(t("settings.renameCategory"), current);
  if (!name) return;
  await api.renameCategory(id, name);
  await feeds.load();
}

async function removeCategory(id: number) {
  if (!confirm(t("settings.deleteCategoryConfirm"))) return;
  await api.deleteCategory(id);
  await feeds.load();
}

const newTag = ref("");
async function addTag() {
  const name = newTag.value.trim();
  if (!name) return;
  try {
    await feeds.createTag(name);
    newTag.value = "";
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}
async function renameTag(id: number, current: string) {
  const name = prompt(t("settings.renameTag"), current);
  if (!name) return;
  try {
    await feeds.renameTag(id, name);
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}
async function removeTag(id: number) {
  if (!confirm(t("settings.deleteTagConfirm"))) return;
  await feeds.deleteTag(id);
}

async function setFeedCategory(feedId: number, value: string) {
  await api.updateFeed(feedId, { categoryId: value ? Number(value) : null });
  await feeds.load();
}

async function unsubscribe(feedId: number, title: string) {
  if (!confirm(t("settings.unsubscribeConfirm", { title }))) return;
  await feeds.unsubscribe(feedId);
}

async function importOpml(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const res = await api.importOpml(await file.text());
    alert(t("settings.imported", { n: res.imported }));
    await feeds.load();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    importing.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}

async function importData(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importingData.value = true;
  try {
    const res = await api.importData(file);
    alert(t("settings.importedData", { feeds: res.feeds, articles: res.articles, states: res.states, tags: res.tags }));
    await feeds.load();
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    importingData.value = false;
    if (dataInput.value) dataInput.value.value = "";
  }
}

async function logout() {
  await auth.logout();
  router.push("/login");
}
</script>

<template>
  <div class="page">
    <header>
      <router-link to="/">{{ t("common.backToReader") }}</router-link>
      <strong>{{ t("settings.title") }}</strong>
      <span class="spacer" />
      <span class="dim small">
        {{ auth.user?.email }}
        <span v-if="auth.user?.is_admin" class="admin">{{ t("common.admin") }}</span>
      </span>
      <router-link v-if="auth.user?.is_admin" to="/admin"><button class="small">{{ t("settings.adminConsole") }}</button></router-link>
      <button class="small" @click="logout">{{ t("common.logout") }}</button>
    </header>

    <section>
      <h2>{{ t("settings.language") }}</h2>
      <LocaleSelect />
    </section>

    <section>
      <h2>{{ t("settings.account") }}</h2>
      <p class="dim small">{{ t("settings.accountNote") }}</p>
      <p v-if="auth.user?.username" class="small">{{ t("settings.usernameIs") }}<code>{{ auth.user.username }}</code></p>
      <form v-else class="row" @submit.prevent="saveUsername">
        <input v-model="newUsername" :placeholder="t('settings.setUsernamePlaceholder')" />
        <button class="primary" type="submit">{{ t("common.set") }}</button>
        <span v-if="accountMsg" class="small">{{ accountMsg }}</span>
      </form>
      <p class="dim small">{{ t("settings.emailIs") }}{{ auth.user?.email }}</p>
    </section>

    <section>
      <h2>{{ t("settings.appearance") }}</h2>
      <label class="row">
        {{ t("settings.themeLabel") }}
        <select :value="ui.theme" @change="setTheme">
          <option value="light">{{ t("settings.themeLight") }}</option>
          <option value="dark">{{ t("settings.themeDark") }}</option>
          <option value="system">{{ t("settings.themeSystem") }}</option>
        </select>
      </label>
    </section>

    <section>
      <h2>{{ t("settings.autoRefresh") }}</h2>
      <label class="row">
        <input type="checkbox" :checked="ui.autoRefresh" @change="ui.toggleAutoRefresh()" />
        {{ t("settings.autoRefreshLabel") }}
      </label>
      <p class="dim small">{{ t("settings.autoRefreshNote") }}</p>
    </section>

    <section>
      <h2>{{ t("settings.quota") }}</h2>
      <p class="dim small">
        {{ t("settings.quotaLine", {
          subs: feeds.limits?.subscriptions ?? 0,
          maxSubs: showMax(feeds.limits?.maxSubscriptions ?? 0),
          starred: feeds.limits?.starred ?? 0,
          maxStarred: showMax(feeds.limits?.maxStarred ?? 0),
        }) }}
      </p>
      <p v-if="!auth.user?.is_admin" class="dim small">{{ t("settings.quotaNote") }}</p>
    </section>

    <section>
      <h2>{{ t("settings.categories") }}</h2>
      <form class="row" @submit.prevent="addCategory">
        <input v-model="newCat" :placeholder="t('settings.newCategory')" />
        <button class="primary" type="submit">{{ t("common.add") }}</button>
      </form>
      <ul>
        <li v-for="c in feeds.categories" :key="c.id">
          <span class="ellipsis">{{ c.name }}</span>
          <button class="small" @click="rename(c.id, c.name)">{{ t("common.rename") }}</button>
          <button class="small" @click="removeCategory(c.id)">{{ t("common.delete") }}</button>
        </li>
      </ul>
      <p v-if="!feeds.categories.length" class="dim small">{{ t("settings.noCategories") }}</p>
    </section>

    <section>
      <h2>{{ t("settings.tagsCount", { n: feeds.tags.length }) }}</h2>
      <form class="row" @submit.prevent="addTag">
        <input v-model="newTag" :placeholder="t('settings.newTag')" />
        <button class="primary" type="submit">{{ t("common.add") }}</button>
      </form>
      <ul>
        <li v-for="tag in feeds.tags" :key="tag.id">
          <span class="ellipsis">{{ tag.name }}</span>
          <span class="dim small">{{ t("settings.articleCount", { n: tag.count }) }}</span>
          <button class="small" @click="renameTag(tag.id, tag.name)">{{ t("common.rename") }}</button>
          <button class="small" @click="removeTag(tag.id)">{{ t("common.delete") }}</button>
        </li>
      </ul>
      <p v-if="!feeds.tags.length" class="dim small">{{ t("settings.noTags") }}</p>
    </section>

    <section>
      <h2>{{ t("settings.subscriptionsCount", { n: feeds.feeds.length }) }}</h2>
      <ul>
        <li v-for="f in feeds.feeds" :key="f.feed_id">
          <FeedIcon :feed="f" />
          <span class="ellipsis" :title="f.feed_url">
            {{ f.title }}
            <span v-if="f.last_error" class="err" :title="f.last_error">{{ t("settings.fetchFailed") }}</span>
          </span>
          <select :value="f.category_id ?? ''" @change="setFeedCategory(f.feed_id, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t("common.uncategorized") }}</option>
            <option v-for="c in feeds.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="small" @click="unsubscribe(f.feed_id, f.title)">{{ t("settings.unsubscribe") }}</button>
        </li>
      </ul>
    </section>

    <section>
      <h2>{{ t("settings.opml") }}</h2>
      <div class="row">
        <a href="/api/opml" download="bunrss.opml"><button class="small">{{ t("settings.exportOpml") }}</button></a>
        <button class="small" :disabled="importing" @click="fileInput?.click()">
          {{ importing ? t("settings.importing") : t("settings.importOpml") }}
        </button>
        <input ref="fileInput" type="file" accept=".opml,.xml,text/xml" hidden @change="importOpml" />
      </div>
    </section>

    <section>
      <h2>{{ t("settings.data") }}</h2>
      <p class="dim small">{{ t("settings.dataNote") }}</p>
      <div class="row">
        <a href="/api/data" download="bunrss-articles.json"><button class="small">{{ t("settings.exportData") }}</button></a>
        <button class="small" :disabled="importingData" @click="dataInput?.click()">
          {{ importingData ? t("settings.importing") : t("settings.importData") }}
        </button>
        <input ref="dataInput" type="file" accept=".json,.zip,application/json,application/zip" hidden @change="importData" />
      </div>
    </section>

    <section>
      <h2>{{ t("settings.bookmarklet") }}</h2>
      <p class="dim small">{{ t("settings.bookmarkletIntro") }}</p>
      <p><a class="bookmarklet" :href="bookmarklet" draggable="true">{{ t("settings.bookmarkletDrag") }}</a></p>
    </section>

    <section>
      <h2>{{ t("settings.tokensTitle") }}</h2>
      <p class="dim small">
        {{ t("settings.tokensIntro") }}
      </p>
      <ul class="endpoints">
        <li><span class="dim">{{ t("settings.serverAddress") }}</span><code>{{ origin }}</code></li>
        <li><span class="dim">{{ t("settings.apiBasePath") }}</span><code>{{ origin }}/api/greader</code></li>
        <li><span class="dim">{{ t("common.username") }}</span><code>{{ auth.user?.username || auth.user?.email }}</code></li>
      </ul>
      <p class="dim small">{{ t("settings.passwordHint") }}</p>
      <p class="dim small">
        {{ t("settings.fluentPrefix") }}<code>localhost</code>{{ t("settings.fluentMid") }}<code>127.0.0.1</code>{{ t("settings.fluentSuffix") }}
      </p>
      <div class="row">
        <button class="small primary" @click="createToken">{{ t("settings.generateToken") }}</button>
      </div>
      <ul class="tokens">
        <li v-for="tk in tokens" :key="tk.id">
          <code class="ellipsis">{{ tk.token }}</code>
          <span class="dim small">{{ tk.label ?? t("common.unnamed") }}</span>
          <span class="dim small">{{ t("settings.lastUsed", { date: tk.last_used_at ? new Date(tk.last_used_at).toLocaleDateString(locale) : "—" }) }}</span>
          <button class="small danger" @click="revokeToken(tk)">{{ t("common.revoke") }}</button>
        </li>
      </ul>
      <p v-if="!tokens.length" class="dim small">{{ t("settings.noTokens") }}</p>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 1000px;
  margin: 0 auto;
  padding: 20px 24px;
  height: 100%;
  overflow-y: auto;
}
header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
section {
  margin-top: 24px;
}
h2 {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.ellipsis {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err {
  color: var(--danger);
}
.admin {
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 11px;
  margin-left: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tokens {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}
.tokens li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.tokens code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.danger {
  color: var(--danger);
}
.endpoints {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}
.endpoints li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  border-bottom: none;
}
.endpoints code {
  user-select: all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}
.bookmarklet {
  display: inline-block;
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 5px 12px;
  color: #fff;
  cursor: grab;
}
.bookmarklet:hover {
  filter: brightness(1.08);
  text-decoration: none;
}
@media (max-width: 768px) {
  header {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  header .spacer {
    display: none;
  }
  li {
    flex-wrap: wrap;
  }
  li .ellipsis {
    flex-basis: 100%;
  }
}
</style>
