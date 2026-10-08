<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuth, useUi } from "./store";
import { locale } from "./i18n";

const router = useRouter();
const auth = useAuth();
const ui = useUi();

onMounted(() => {
  document.documentElement.lang = locale.value;
  ui.init();
  window.addEventListener("bunrss:unauthorized", () => {
    auth.user = null;
    if (router.currentRoute.value.path !== "/login") router.push("/login");
  });
});
</script>

<template>
  <router-view />
</template>
