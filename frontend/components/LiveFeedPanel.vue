<script setup lang="ts">
import { formatDisplayDate } from "../lib/cadenza/query";
import type { LiveEvent } from "../lib/cadenza/contracts";

withDefaults(
  defineProps<{
    title?: string;
    events: LiveEvent[];
    emptyMessage?: string;
  }>(),
  {
    title: "Live distributed signals",
    emptyMessage: "Waiting for live signals from the demo services.",
  },
);

function severityClass(severity: LiveEvent["severity"]) {
  return `severity-chip severity-chip--${severity}`;
}
</script>

<template>
  <section class="panel">
    <div class="section-label">{{ title }}</div>
    <div v-if="events.length === 0" class="empty-state">
      {{ emptyMessage }}
    </div>
    <div v-else class="feed-list">
      <article v-for="event in events" :key="event.id" class="feed-item">
        <div class="feed-item__row">
          <div class="feed-item__title">{{ event.headline }}</div>
          <span :class="severityClass(event.severity)">{{ event.severity }}</span>
        </div>
        <div class="feed-item__detail">{{ event.detail }}</div>
        <div class="feed-item__row muted">
          <NuxtLink class="route-link" :to="`/devices/${event.deviceId}`">
            {{ event.deviceId }}
          </NuxtLink>
          <span class="mono">{{ formatDisplayDate(event.timestamp) }}</span>
        </div>
      </article>
    </div>
  </section>
</template>
