<script setup lang="ts">
defineProps<{
  label: string;
  value: string;
  hint: string;
}>();
</script>

<template>
  <article class="kpi-card">
    <div class="kpi-card__label">{{ label }}</div>
    <div class="kpi-card__value">{{ value }}</div>
    <div class="kpi-card__hint">{{ hint }}</div>
  </article>
</template>
