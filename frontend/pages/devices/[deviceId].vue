<script setup lang="ts">
import { computed } from "vue";
import { formatDisplayDate } from "../../lib/cadenza/query";

const route = useRoute();
const deviceId = computed(() => String(route.params.deviceId ?? ""));

const { data, pending, error, refresh } = await useDevicePageData(deviceId);
const projectionState = useCadenzaProjectionState();
const blockingError = computed(() => (!data.value ? error.value : null));
const backgroundRefreshActive = computed(() => pending.value && !!data.value);
const backgroundRefreshError = computed(() => (data.value ? error.value : null));

const deviceLiveFeed = computed(() => {
  const current = Array.isArray(projectionState.value.projectionState.liveFeed)
    ? projectionState.value.projectionState.liveFeed
    : [];
  const filtered = current.filter((event: any) => event.deviceId === deviceId.value);
  if (filtered.length > 0) {
    return filtered;
  }
  return data.value?.liveFeedSeed ?? [];
});

const sessionCards = computed(() => {
  if (!data.value) {
    return [];
  }

  return [
    {
      label: "Telemetry session",
      detail: data.value.telemetrySession
        ? `validations ${data.value.telemetrySession.validationCount} · outliers ${data.value.telemetrySession.outlierCount}`
        : "No telemetry session state yet.",
    },
    {
      label: "Prediction session",
      detail: data.value.predictionSession
        ? `risk ${(data.value.predictionSession.lastProbability * 100).toFixed(1)}% · computes ${data.value.predictionSession.computeCount}`
        : "No prediction session state yet.",
    },
    {
      label: "Anomaly runtime",
      detail: data.value.anomalyRuntime
        ? `temperatures ${data.value.anomalyRuntime.recentTemperatures.length} · scores ${data.value.anomalyRuntime.recentScores.length}`
        : "No runtime anomaly state yet.",
    },
  ];
});
</script>

<template>
  <div class="page-grid">
    <section class="hero-panel">
      <div class="hero-panel__eyebrow">Device drilldown</div>
      <h1 class="hero-panel__title">{{ data?.device?.name ?? deviceId }}</h1>
      <p class="hero-panel__summary">
        Durable session actors, runtime-only anomaly state, and recent table history for a single
        device.
      </p>
      <div class="hero-panel__footer">
        <span class="hero-panel__badge">Type {{ data?.device?.type ?? "unknown" }}</span>
        <span class="hero-panel__badge">
          Last telemetry {{
            formatDisplayDate(
              data?.telemetrySession?.lastIngestedAt ?? data?.telemetryHistory?.[0]?.timestamp ?? null,
            )
          }}
        </span>
        <span v-if="backgroundRefreshActive" class="hero-panel__badge">
          refreshing snapshot
        </span>
        <span v-else-if="backgroundRefreshError" class="hero-panel__badge">
          snapshot refresh failed
        </span>
      </div>
    </section>

    <div v-if="!data && pending" class="empty-state">Loading device state...</div>
    <div v-else-if="blockingError" class="empty-state">
      Failed to load the device page. {{ blockingError.message }}
    </div>
    <template v-else-if="data">
      <div class="detail-grid">
        <article v-for="card in sessionCards" :key="card.label" class="kpi-card">
          <div class="kpi-card__label">{{ card.label }}</div>
          <div class="kpi-card__hint" style="margin-top: 0.6rem">
            {{ card.detail }}
          </div>
        </article>
      </div>

      <div class="device-layout">
        <div class="page-grid">
          <section class="panel">
            <div class="section-label">Telemetry history</div>
            <table class="table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Temperature</th>
                  <th>Humidity</th>
                  <th>Battery</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.telemetryHistory" :key="row.timestamp">
                  <td class="mono">{{ formatDisplayDate(row.timestamp) }}</td>
                  <td>{{ Number(row.temperature).toFixed(1) }} C</td>
                  <td>{{ Number(row.humidity).toFixed(1) }}%</td>
                  <td>{{ Number(row.battery).toFixed(1) }}%</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="panel">
            <div class="section-label">Health metrics</div>
            <table class="table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Anomaly score</th>
                  <th>Failure probability</th>
                  <th>ETA</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.healthMetricHistory" :key="row.timestamp">
                  <td class="mono">{{ formatDisplayDate(row.timestamp) }}</td>
                  <td>{{ Number(row.anomaly_score).toFixed(2) }}</td>
                  <td>{{ (Number(row.failure_probability) * 100).toFixed(1) }}%</td>
                  <td>{{ row.predicted_eta ?? "n/a" }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="panel">
            <div class="section-label">Alert history</div>
            <table class="table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.alertHistory" :key="`${row.timestamp}:${row.type}`">
                  <td class="mono">{{ formatDisplayDate(row.timestamp) }}</td>
                  <td>{{ row.type }}</td>
                  <td>
                    <span :class="`severity-chip severity-chip--${row.severity}`">
                      {{ row.severity }}
                    </span>
                  </td>
                  <td class="muted">{{ row.reason }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <div class="page-grid">
          <LiveFeedPanel
            title="Device-scoped live signals"
            :events="deviceLiveFeed"
            empty-message="No live events for this device yet."
          />

          <section class="panel">
            <div class="section-label">Alert session actors</div>
            <div class="stack-list">
              <article
                v-for="entry in Object.entries(data.alertSessions)"
                :key="entry[0]"
                class="stack-item"
              >
                <div class="stack-item__row">
                  <div class="stack-item__title">{{ entry[0] }}</div>
                  <span
                    :class="`severity-chip severity-chip--${entry[1]?.lastSeverity ?? 'low'}`"
                  >
                    {{ entry[1]?.lastSeverity ?? "n/a" }}
                  </span>
                </div>
                <div class="stack-item__detail">
                  {{
                    entry[1]
                      ? `open ${entry[1].isOpen} · raises ${entry[1].raiseCount} · dedupes ${entry[1].dedupeCount}`
                      : "No alert session state for this type."
                  }}
                </div>
                <div class="muted">{{ entry[1]?.lastReason ?? "No reason recorded" }}</div>
              </article>
            </div>
          </section>

          <TelemetryControlPanel @ingested="refresh()" />
        </div>
      </div>
    </template>
  </div>
</template>
