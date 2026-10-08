<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { fallbackIconUrl, feedIconUrl } from "../api";

const props = defineProps<{ feed: { site_url: string | null; feed_url: string; icon_url?: string | null } }>();

// Try the site's declared icon first, then the guessed /favicon.ico, stopping at the first that loads.
const candidates = computed(() =>
  [...new Set([feedIconUrl(props.feed), fallbackIconUrl(props.feed)].filter((u): u is string => !!u))],
);
const index = ref(0);
watch(candidates, () => (index.value = 0));
const src = computed(() => candidates.value[index.value] ?? null);

function onError() {
  index.value++; // past the end => src is null and the image hides
}
</script>

<template>
  <img
    v-if="src"
    class="favicon"
    :src="src"
    alt=""
    width="16"
    height="16"
    loading="lazy"
    referrerpolicy="no-referrer"
    @error="onError"
  />
</template>

<style scoped>
.favicon {
  flex: 0 0 auto;
  border-radius: 3px;
  object-fit: contain;
}
</style>
