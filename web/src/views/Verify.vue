<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api";
import { t } from "../i18n";

const route = useRoute();
const state = ref<"working" | "ok" | "fail">("working");
const message = ref("");

onMounted(async () => {
  const token = String(route.query.token ?? "");
  if (!token) {
    state.value = "fail";
    message.value = t("verify.missing");
    return;
  }
  try {
    await api.verifyEmail(token);
    state.value = "ok";
  } catch (e) {
    state.value = "fail";
    message.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <div class="wrap">
    <div class="card">
      <h1>bunrss</h1>
      <p v-if="state === 'working'" class="dim">{{ t("verify.working") }}</p>
      <template v-else-if="state === 'ok'">
        <p class="ok">{{ t("verify.ok") }}</p>
        <router-link to="/login"><button class="primary">{{ t("auth.login") }}</button></router-link>
      </template>
      <template v-else>
        <p class="error small">{{ message || t("verify.failed") }}</p>
        <router-link to="/login"><button>{{ t("auth.login") }}</button></router-link>
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
</style>
