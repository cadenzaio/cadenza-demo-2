<script setup lang="ts">
import type { DeviceSummary } from "../lib/cadenza/contracts";
import { formatDisplayDate } from "../lib/cadenza/query";

defineProps<{
  devices: DeviceSummary[];
}>();

function statusClass(status: DeviceSummary["status"]) {
  return `severity-chip status-chip--${status}`;
}

function formatProbability(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatReading(value: number | null, suffix: string) {
  return value === null ? "n/a" : `${value.toFixed(1)}${suffix}`;
}
</script>

<template>
  <section class="panel">
    <div class="section-label">Fleet drilldown</div>
    <table class="table">
      <thead>
        <tr>
          <th>Device</th>
          <th>Type</th>
          <th>Last seen</th>
          <th>Telemetry</th>
          <th>Risk</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="device in devices" :key="device.deviceId">
          <td>
            <NuxtLink class="route-link" :to="`/devices/${device.deviceId}`">
              {{ device.deviceId }}
            </NuxtLink>
          </td>
          <td>{{ device.type }}</td>
          <td>{{ formatDisplayDate(device.lastSeen) }}</td>
          <td class="muted">
            {{ formatReading(device.temperature, "C") }} ·
            {{ formatReading(device.humidity, "%") }} ·
            {{ formatReading(device.battery, "%") }}
          </td>
          <td class="muted">
            {{ formatProbability(device.failureProbability) }} · alerts {{ device.openAlertCount }}
          </td>
          <td>
            <span :class="statusClass(device.status)">{{ device.status }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
