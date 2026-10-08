<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth, useFeeds } from "../store";
import { t } from "../i18n";

const auth = useAuth();
const feeds = useFeeds();
const router = useRouter();

const step = ref(1);
const email = ref("");
const username = ref("");
const password = ref("");
const confirm = ref("");
const error = ref("");
const busy = ref(false);

const suggestions = [
  { title: "Hacker News", url: "https://hnrss.org/frontpage" },
  { title: "Cloudflare Blog", url: "https://blog.cloudflare.com/rss/" },
  { title: "The GitHub Blog", url: "https://github.blog/feed/" },
  { title: "阮一峰的网络日志", url: "https://www.ruanyifeng.com/blog/atom.xml" },
  { title: "LWN.net", url: "https://lwn.net/headlines/rss" },
];
const added = ref<string[]>([]);
const customUrl = ref("");

async function createAdmin() {
  error.value = "";
  if (password.value !== confirm.value) {
    error.value = t("setup.passwordMismatch");
    return;
  }
  busy.value = true;
  try {
    await auth.setup(email.value, username.value, password.value);
    step.value = 2;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function add(url: string) {
  if (added.value.includes(url)) return;
  try {
    await feeds.subscribe(url);
    added.value.push(url);
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}

async function addCustom() {
  const url = customUrl.value.trim();
  if (!url) return;
  await add(url);
  customUrl.value = "";
}

function finish() {
  router.push("/");
}
</script>

<template>
  <div class="wrap">
    <div class="card">
      <div class="steps">
        <span :class="{ on: step >= 1 }">{{ t("setup.stepAdmin") }}</span>
        <span :class="{ on: step >= 2 }">{{ t("setup.stepFeeds") }}</span>
      </div>

      <template v-if="step === 1">
        <h1>{{ t("setup.title") }}</h1>
        <p class="dim small">{{ t("setup.intro") }}</p>
        <form @submit.prevent="createAdmin">
          <input v-model="username" :placeholder="t('auth.usernamePlaceholder')" required autocomplete="username" />
          <input v-model="email" type="email" :placeholder="t('common.email')" required autocomplete="email" />
          <input v-model="password" type="password" :placeholder="t('auth.passwordPlaceholder')" required minlength="6" autocomplete="new-password" />
          <input v-model="confirm" type="password" :placeholder="t('auth.confirmPassword')" required autocomplete="new-password" />
          <p v-if="error" class="error small">{{ error }}</p>
          <button class="primary" type="submit" :disabled="busy">{{ busy ? t("common.creating") : t("setup.createAdmin") }}</button>
        </form>
      </template>

      <template v-else>
        <h1>{{ t("setup.addFeedsTitle") }}</h1>
        <p class="dim small">{{ t("setup.addFeedsIntro") }}</p>
        <ul class="suggestions">
          <li v-for="s in suggestions" :key="s.url">
            <span class="ellipsis">
              {{ s.title }}
              <span class="dim small">{{ s.url }}</span>
            </span>
            <button class="small" :disabled="added.includes(s.url)" @click="add(s.url)">
              {{ added.includes(s.url) ? t("common.added") : t("common.add") }}
            </button>
          </li>
        </ul>
        <form class="row" @submit.prevent="addCustom">
          <input v-model="customUrl" :placeholder="t('setup.customUrl')" />
          <button type="submit">{{ t("common.add") }}</button>
        </form>
        <button class="primary" @click="finish">
          {{ added.length ? t("setup.finishCount", { n: added.length }) : t("setup.skip") }}
        </button>
      </template>
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
  width: 400px;
  max-width: calc(100vw - 32px);
  padding: 28px;
  margin: 24px 0;
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
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.steps {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-dim);
}
.steps .on {
  color: var(--accent);
  font-weight: 600;
}
.error {
  color: var(--danger);
}
.suggestions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.suggestions li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.ellipsis {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ellipsis .dim {
  display: block;
}
.row {
  display: flex;
  gap: 8px;
}
.row input {
  flex: 1;
}
</style>
