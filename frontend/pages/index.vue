<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { formatDisplayDate } from "../lib/cadenza/query";

const { data, pending, error, refresh } = await useDashboardPageData();
const projectionState = useCadenzaProjectionState();
const runtimeReady = useCadenzaRuntimeReady();
let refreshIntervalId: number | null = null;

if (import.meta.client) {
  watch(
    runtimeReady,
    async (isReady) => {
      if (refreshIntervalId !== null) {
        window.clearInterval(refreshIntervalId);
        refreshIntervalId = null;
      }

      if (!isReady) {
        return;
      }

      refreshIntervalId = window.setInterval(() => {
        refresh();
      }, 10000);
    },
    {
      immediate: true,
    },
  );
}

onBeforeUnmount(() => {
  if (refreshIntervalId !== null) {
    window.clearInterval(refreshIntervalId);
  }
});

const feedEvents = computed(() => {
  const current = projectionState.value.projectionState.liveFeed;
  if (Array.isArray(current) && current.length > 0) {
    return current;
  }
  return data.value?.liveFeedSeed ?? [];
});

const runnerSummary = computed(() => {
  const runner = data.value?.runnerStatus;
  if (!runner) {
    return "Runner status is only available during SSR or after a full page refresh.";
  }

  return `mode ${runner.trafficMode} · tick ${runner.tickCount} · burst ${runner.lastBurstCount} · next ${Math.round(
    runner.lastDelayMs / 1000,
  )}s · total ${runner.totalEventsEmitted}`;
});
</script>

<template>
  <div class="page-grid">
    <section class="hero-panel">
      <div class="hero-panel__eyebrow">Direct browser runtime</div>
      <h1 class="hero-panel__title">Observe the full IoT flow without a relay.</h1>
      <p class="hero-panel__summary">
        This frontend SSR-loads the initial snapshot from the Nuxt server, then the browser
        connects directly to the Cadenza system for inquiries, live signal subscriptions, and
        manual telemetry injection.
      </p>
      <div class="hero-panel__footer">
        <span class="hero-panel__badge">{{ runnerSummary }}</span>
        <span v-if="data?.recentAlerts?.[0]" class="hero-panel__badge">
          Latest alert {{ formatDisplayDate(data.recentAlerts[0].timestamp) }}
        </span>
      </div>
    </section>

    <div v-if="pending" class="empty-state">Loading fleet snapshot...</div>
    <div v-else-if="error" class="empty-state">
      Failed to load the dashboard. {{ error.message }}
    </div>
    <template v-else-if="data">
      <div class="kpi-grid">
        <KpiCard
          v-for="kpi in data.kpis"
          :key="kpi.label"
          :label="kpi.label"
          :value="kpi.value"
          :hint="kpi.hint"
        />
      </div>

      <div class="content-grid">
        <DeviceSummaryTable :devices="data.devices" />
        <LiveFeedPanel :events="feedEvents" />
      </div>

      <div class="content-grid">
        <section class="panel">
          <div class="section-label">Recent alerts</div>
          <table class="table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Reason</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="alert in data.recentAlerts" :key="`${alert.device_id}:${alert.timestamp}:${alert.type}`">
                <td>
                  <NuxtLink class="route-link" :to="`/devices/${alert.device_id}`">
                    {{ alert.device_id }}
                  </NuxtLink>
                </td>
                <td>{{ alert.type }}</td>
                <td>
                  <span :class="`severity-chip severity-chip--${alert.severity}`">
                    {{ alert.severity }}
                  </span>
                </td>
                <td class="muted">{{ alert.reason }}</td>
                <td class="mono">{{ formatDisplayDate(alert.timestamp) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="page-grid">
          <TelemetryControlPanel @ingested="refresh()" />
          <section class="panel">
            <div class="section-label">Recent predictions</div>
            <div v-if="data.recentHealthMetrics.length === 0" class="empty-state">
              No prediction rows yet.
            </div>
            <div v-else class="stack-list">
              <article
                v-for="metric in data.recentHealthMetrics.slice(0, 6)"
                :key="`${metric.device_id}:${metric.timestamp}`"
                class="stack-item"
              >
                <div class="stack-item__row">
                  <NuxtLink class="route-link stack-item__title" :to="`/devices/${metric.device_id}`">
                    {{ metric.device_id }}
                  </NuxtLink>
                  <span
                    :class="`severity-chip severity-chip--${
                      metric.failure_probability >= 0.8
                        ? 'high'
                        : metric.failure_probability >= 0.5
                          ? 'medium'
                          : 'low'
                    }`"
                  >
                    {{ (metric.failure_probability * 100).toFixed(1) }}%
                  </span>
                </div>
                <div class="stack-item__detail">
                  anomaly {{ Number(metric.anomaly_score).toFixed(2) }} · ETA
                  {{ metric.predicted_eta ?? "n/a" }}
                </div>
                <div class="muted mono">{{ formatDisplayDate(metric.timestamp) }}</div>
              </article>
            </div>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
