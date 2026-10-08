<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, type DiscoveredFeed } from "../api";
import { useFeeds } from "../store";
import { t } from "../i18n";

const route = useRoute();
const router = useRouter();
const feeds = useFeeds();

const sourceUrl = String(route.query.url ?? "");
const found = ref<DiscoveredFeed[]>([]);
const chosen = ref<Record<string, boolean>>({});
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const categoryId = ref<number | null>(null);

const selectedCount = computed(() => found.value.filter((f) => chosen.value[f.url]).length);
const allSelected = computed(() => found.value.length > 0 && selectedCount.value === found.value.length);

function toggleAll() {
  const on = !allSelected.value;
  for (const f of found.value) chosen.value[f.url] = on;
}

async function subscribe(urls: string[]) {
  if (!urls.length) return;
  busy.value = true;
  error.value = "";
  try {
    for (const url of urls) await api.subscribe(url, categoryId.value);
    await feeds.load();
    router.push("/");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  void feeds.load();
  if (!sourceUrl) {
    error.value = t("subscribe.missingUrl");
    loading.value = false;
    return;
  }
  try {
    found.value = await api.discover(sourceUrl);
    for (const f of found.value) chosen.value[f.url] = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="wrap">
    <div class="card">
      <h1>{{ t("subscribe.title") }}</h1>
      <p class="dim small ellipsis">{{ t("subscribe.from") }} <code>{{ sourceUrl || "—" }}</code></p>

      <p v-if="loading" class="dim small">{{ t("subscribe.loading") }}</p>
      <p v-if="error" class="error small">{{ error }}</p>

      <template v-if="!loading && found.length">
        <div class="row">
          <strong class="small">{{ t("subscribe.found", { n: found.length }) }}</strong>
          <span class="spacer" />
          <button class="small" type="button" @click="toggleAll">{{ t("subscribe.selectAll") }}</button>
        </div>
        <ul class="feeds">
          <li v-for="f in found" :key="f.url">
            <label class="row">
              <input type="checkbox" v-model="chosen[f.url]" />
              <span class="ellipsis">
                {{ f.title }}
                <span class="dim small url">{{ f.url }}</span>
              </span>
            </label>
          </li>
        </ul>
        <div class="row">
          <select v-model="categoryId">
            <option :value="null">{{ t("common.uncategorized") }}</option>
            <option v-for="c in feeds.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button
            class="primary"
            :disabled="busy || !selectedCount"
            @click="subscribe(found.filter((f) => chosen[f.url]).map((f) => f.url))"
          >
            {{ busy ? t("subscribe.busy") : t("subscribe.submit", { n: selectedCount }) }}
          </button>
        </div>
      </template>

      <template v-else-if="!loading && !error">
        <p class="dim small">{{ t("subscribe.none") }}</p>
        <div class="row">
          <select v-model="categoryId">
            <option :value="null">{{ t("common.uncategorized") }}</option>
            <option v-for="c in feeds.categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="primary" :disabled="busy" @click="subscribe([sourceUrl])">
            {{ busy ? t("subscribe.busy") : t("subscribe.direct") }}
          </button>
        </div>
      </template>

      <router-link to="/" class="small">{{ t("common.backToReader") }}</router-link>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--bg-alt);
  overflow-y: auto;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 520px;
  max-width: calc(100vw - 32px);
  margin: 24px 0;
  padding: 28px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgb(0 0 0 / 8%);
}
h1 {
  margin: 0;
  font-size: 20px;
}
p {
  margin: 0;
}
.error {
  color: var(--danger);
}
.ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feeds {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 45vh;
  overflow-y: auto;
}
.feeds li {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
}
.feeds label {
  cursor: pointer;
}
.url {
  display: block;
}
</style>
