<script setup lang="ts">
import { locale, locales, setLocale, type Locale } from "../i18n";

function change(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as Locale);
}
</script>

<template>
  <select class="locale-select" :value="locale" aria-label="Language" @change="change">
    <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.label }}</option>
  </select>
</template>
