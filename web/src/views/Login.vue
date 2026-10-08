<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../store";
import { t } from "../i18n";
import LocaleSelect from "../components/LocaleSelect.vue";

const auth = useAuth();
const router = useRouter();
const route = useRoute();

const identifier = ref("");
const username = ref("");
const password = ref("");
const mode = ref<"login" | "register">("login");
const error = ref("");
const notice = ref("");
const busy = ref(false);

function switchMode() {
  mode.value = mode.value === "login" ? "register" : "login";
  error.value = "";
  notice.value = "";
}

async function submit() {
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    if (mode.value === "login") await auth.login(identifier.value, password.value);
    else await auth.register(identifier.value, username.value, password.value);
    if (auth.pendingEmail) {
      notice.value = t("auth.verifySent", { email: auth.pendingEmail });
      return;
    }
    router.push((route.query.next as string) || "/");
  } catch (e) {
    if ((e as { code?: string }).code === "email_unverified") {
      // we can only resend to an email, not a bare username
      if (identifier.value.includes("@")) auth.pendingEmail = identifier.value;
      notice.value = t("auth.verifySent", { email: identifier.value });
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    busy.value = false;
  }
}

async function resend() {
  error.value = "";
  const email = auth.pendingEmail || identifier.value;
  try {
    await auth.resend(email);
    notice.value = t("auth.verifySent", { email });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="wrap">
    <form class="card" @submit.prevent="submit">
      <h1>bunrss</h1>
      <p class="dim small">{{ mode === "login" ? t("auth.loginSubtitle") : t("auth.registerSubtitle") }}</p>
      <input v-if="mode === 'register'" v-model="username" :placeholder="t('auth.usernamePlaceholder')" required autocomplete="username" />
      <input
        v-model="identifier"
        :type="mode === 'login' ? 'text' : 'email'"
        :placeholder="mode === 'login' ? t('auth.identifier') : t('common.email')"
        required
        :autocomplete="mode === 'login' ? 'username' : 'email'"
      />
      <input
        v-model="password"
        type="password"
        :placeholder="t('auth.passwordPlaceholder')"
        required
        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
      />
      <p v-if="error" class="error small">{{ error }}</p>
      <p v-if="notice" class="ok small">{{ notice }}</p>
      <button v-if="auth.pendingEmail" type="button" class="link" @click="resend">{{ t("auth.resend") }}</button>
      <button class="primary" type="submit" :disabled="busy">
        {{ mode === "login" ? t("auth.login") : t("auth.register") }}
      </button>
      <button type="button" class="link" v-if="auth.allowRegistration" @click="switchMode">
        {{ mode === "login" ? t("auth.toRegister") : t("auth.toLogin") }}
      </button>
      <LocaleSelect />
    </form>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  display: grid;
  place-items: center;
  background: var(--bg-alt);
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 28px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgb(0 0 0 / 8%);
}
h1 {
  margin: 0;
  font-size: 22px;
}
p {
  margin: 0;
}
.error {
  color: var(--danger);
}
.ok {
  color: var(--accent);
}
button.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0;
}
</style>
