<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type AdminOverview, type AdminSettings, type AdminUser, type ApiToken, formatUptime } from "../api";
import { locale, t } from "../i18n";

const overview = ref<AdminOverview | null>(null);
const users = ref<AdminUser[]>([]);
const limits = ref<AdminSettings>({ maxSubscriptions: 0, maxStarred: 0, maxUsers: 0, allowRegistration: true });
const tokenUser = ref<AdminUser | null>(null);
const tokens = ref<ApiToken[]>([]);
const newEmail = ref("");
const newUsername = ref("");
const newPassword = ref("");
const newIsAdmin = ref(false);
const creatingUser = ref(false);
const origin = window.location.origin;
const error = ref("");
const note = ref("");
const busy = ref(false);

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const showLimit = (n: number) => (n > 0 ? String(n) : t("common.unlimited"));
const date = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString(locale.value) : "");

async function load() {
  error.value = "";
  try {
    const [o, u, l] = await Promise.all([api.admin.overview(), api.admin.users(), api.admin.settings()]);
    overview.value = o;
    users.value = u;
    limits.value = l;
  } catch (e) {
    error.value = msg(e);
  }
}

async function saveLimits() {
  error.value = "";
  busy.value = true;
  try {
    limits.value = await api.admin.updateSettings(limits.value);
    note.value = t("common.saved");
    setTimeout(() => (note.value = ""), 2000);
    overview.value = await api.admin.overview();
  } catch (e) {
    error.value = msg(e);
  } finally {
    busy.value = false;
  }
}

async function addUser() {
  error.value = "";
  creatingUser.value = true;
  try {
    await api.admin.createUser(newEmail.value, newUsername.value, newPassword.value, newIsAdmin.value);
    newEmail.value = newUsername.value = newPassword.value = "";
    newIsAdmin.value = false;
    note.value = t("common.added");
    setTimeout(() => (note.value = ""), 2000);
    await load();
  } catch (e) {
    error.value = msg(e);
  } finally {
    creatingUser.value = false;
  }
}

async function setAdmin(u: AdminUser, isAdmin: boolean) {
  error.value = "";
  try {
    await api.admin.setAdmin(u.id, isAdmin);
    await load();
  } catch (e) {
    error.value = msg(e);
  }
}

async function removeUser(u: AdminUser) {
  if (!confirm(t("admin.deleteUserConfirm", { email: u.email }))) return;
  error.value = "";
  try {
    await api.admin.deleteUser(u.id);
    if (tokenUser.value?.id === u.id) tokenUser.value = null;
    await load();
  } catch (e) {
    error.value = msg(e);
  }
}

async function openTokens(u: AdminUser) {
  error.value = "";
  tokenUser.value = u;
  try {
    tokens.value = await api.admin.tokens(u.id);
  } catch (e) {
    error.value = msg(e);
  }
}

async function createToken() {
  if (!tokenUser.value) return;
  error.value = "";
  const label = prompt(t("settings.tokenLabel")) ?? "";
  try {
    const created = await api.admin.createToken(tokenUser.value.id, label || undefined);
    tokens.value.unshift(created);
    prompt(t("settings.tokenCreated"), created.token);
  } catch (e) {
    error.value = msg(e);
  }
}

async function revokeToken(token: ApiToken) {
  if (!confirm(t("settings.revokeTokenConfirm"))) return;
  await api.admin.deleteToken(token.id);
  tokens.value = tokens.value.filter((x) => x.id !== token.id);
}

onMounted(load);
</script>

<template>
  <div class="page">
    <header>
      <router-link to="/">{{ t("common.backToReader") }}</router-link>
      <strong>{{ t("settings.adminConsole") }}</strong>
      <span class="spacer" />
      <span class="dim small">{{ t("admin.uptime", { v: overview?.bun ?? "", uptime: formatUptime(overview?.uptimeSeconds ?? 0) }) }}</span>
    </header>

    <p v-if="error" class="error small">{{ error }}</p>

    <section>
      <h2>{{ t("admin.overview") }}</h2>
      <div class="stats">
        <div><b>{{ overview?.users ?? "–" }}</b><span class="dim small">{{ t("admin.usersStat", { n: overview?.admins ?? 0 }) }}</span></div>
        <div><b>{{ overview?.subscriptions ?? "–" }}</b><span class="dim small">{{ t("admin.subsStat", { n: overview?.feeds ?? 0 }) }}</span></div>
        <div><b>{{ overview?.articles ?? "–" }}</b><span class="dim small">{{ t("admin.articles") }}</span></div>
        <div><b>{{ overview?.starred ?? "–" }}</b><span class="dim small">{{ t("nav.starred") }}</span></div>
      </div>
    </section>

    <section>
      <h2>{{ t("admin.limits") }}</h2>
      <form class="row" @submit.prevent="saveLimits">
        <label>
          {{ t("admin.maxSubscriptions") }}
          <input v-model.number="limits.maxSubscriptions" type="number" min="0" step="1" />
        </label>
        <label>
          {{ t("admin.maxStarred") }}
          <input v-model.number="limits.maxStarred" type="number" min="0" step="1" />
        </label>
        <label>
          {{ t("admin.maxUsers") }}
          <input v-model.number="limits.maxUsers" type="number" min="0" step="1" />
        </label>
        <label class="check">
          <input v-model="limits.allowRegistration" type="checkbox" />
          {{ t("admin.allowRegistration") }}
        </label>
        <button class="primary" type="submit" :disabled="busy">{{ t("common.save") }}</button>
        <span v-if="note" class="ok small">{{ note }}</span>
      </form>
      <p class="dim small">{{ t("admin.limitsNote", { users: showLimit(limits.maxUsers), subs: showLimit(limits.maxSubscriptions), stars: showLimit(limits.maxStarred) }) }}</p>
    </section>

    <section>
      <h2>{{ t("admin.usersCount", { n: users.length }) }}</h2>
      <form class="row addUser" @submit.prevent="addUser">
        <label>
          {{ t("common.email") }}
          <input v-model="newEmail" type="email" required />
        </label>
        <label>
          {{ t("common.username") }}
          <input v-model="newUsername" required />
        </label>
        <label>
          {{ t("admin.password") }}
          <input v-model="newPassword" type="password" required autocomplete="new-password" />
        </label>
        <label class="check">
          <input v-model="newIsAdmin" type="checkbox" />
          {{ t("common.admin") }}
        </label>
        <button class="primary" type="submit" :disabled="creatingUser">
          {{ creatingUser ? t("common.creating") : t("common.add") }}
        </button>
        <span v-if="note" class="ok small">{{ note }}</span>
      </form>
      <table>
        <thead>
          <tr>
            <th>{{ t("common.email") }}</th>
            <th>{{ t("common.username") }}</th>
            <th>{{ t("admin.colRole") }}</th>
            <th class="num">{{ t("admin.colSubs") }}</th>
            <th class="num">{{ t("admin.colStarred") }}</th>
            <th class="num">{{ t("admin.colUnread") }}</th>
            <th>{{ t("admin.colLastLogin") }}</th>
            <th>{{ t("admin.colCreated") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="ellipsis">{{ u.email }}</td>
            <td class="ellipsis">{{ u.username ?? "—" }}</td>
            <td>
              <span v-if="u.is_admin" class="admin">{{ t("common.admin") }}</span>
              <span v-else class="dim">{{ t("common.user") }}</span>
            </td>
            <td class="num">{{ u.subscriptions }}</td>
            <td class="num">{{ u.starred }}</td>
            <td class="num">{{ u.unread }}</td>
            <td class="small">
              <template v-if="u.last_login_ip">
                <span class="ip">{{ u.last_login_ip }}</span>
                <span class="dim"> · {{ date(u.last_login_at) }}</span>
              </template>
              <span v-else class="dim">—</span>
            </td>
            <td class="small dim">{{ date(u.created_at) }}</td>
            <td class="actions">
              <button class="small" @click="openTokens(u)">Token</button>
              <button class="small" @click="setAdmin(u, !u.is_admin)">
                {{ u.is_admin ? t("admin.demote") : t("admin.promote") }}
              </button>
              <button class="small danger" @click="removeUser(u)">{{ t("common.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="tokenUser">
      <h2>{{ t("admin.apiTokenFor", { email: tokenUser.email }) }}</h2>
      <p class="dim small">
        {{ t("settings.tokensIntro") }}
      </p>
      <ul class="endpoints">
        <li><span class="dim">{{ t("settings.serverAddress") }}</span><code>{{ origin }}</code></li>
        <li><span class="dim">{{ t("settings.apiBasePath") }}</span><code>{{ origin }}/api/greader</code></li>
        <li><span class="dim">{{ t("common.username") }}</span><code>{{ tokenUser.email }}</code></li>
      </ul>
      <p class="dim small">{{ t("settings.passwordHint") }}</p>
      <div class="row">
        <button class="small primary" @click="createToken">{{ t("settings.generateToken") }}</button>
        <button class="small" @click="tokenUser = null">{{ t("common.close") }}</button>
      </div>
      <ul class="tokens">
        <li v-for="tk in tokens" :key="tk.id">
          <code class="ellipsis">{{ tk.token }}</code>
          <span class="dim small">{{ tk.label ?? t("common.unnamed") }}</span>
          <span class="dim small">{{ t("settings.lastUsed", { date: tk.last_used_at ? date(tk.last_used_at) : "—" }) }}</span>
          <button class="small danger" @click="revokeToken(tk)">{{ t("common.revoke") }}</button>
        </li>
      </ul>
      <p v-if="!tokens.length" class="dim small">{{ t("settings.noTokens") }}</p>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 1200px;
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
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.stats div {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
}
.stats b {
  font-size: 22px;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.row input {
  width: 120px;
}
.row input[type="checkbox"] {
  width: auto;
}
.addUser {
  margin: 12px 0;
}
.addUser input:not([type="checkbox"]) {
  width: 200px;
}
.row label.check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
th {
  color: var(--text-dim);
  font-weight: 500;
  white-space: nowrap;
}
td.num,
th.num {
  text-align: right;
}
td.ellipsis {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  white-space: nowrap;
}
.actions button {
  white-space: nowrap;
}
.admin {
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 11px;
  white-space: nowrap;
}
.ip {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
}
.error {
  color: var(--danger);
}
.ok {
  color: var(--accent);
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
}
.endpoints code {
  user-select: all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
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
@media (max-width: 768px) {
  header {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  header .spacer {
    display: none;
  }
  section > table {
    display: block;
    overflow-x: auto;
    white-space: nowrap;
  }
  .tokens li {
    flex-wrap: wrap;
  }
  .tokens code {
    flex-basis: 100%;
  }
}
</style>
