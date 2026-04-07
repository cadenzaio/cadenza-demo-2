<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  ingested: [];
}>();

const runtime = useCadenzaRuntime();

const deviceId = ref("device-1");
const trafficMode = ref<"low" | "high">("high");
const temperature = ref(92);
const humidity = ref(14);
const battery = ref(18);
const submitting = ref(false);
const statusMessage = ref("Dispatch a manual telemetry event directly from the browser runtime.");
const errorMessage = ref("");

const presets = [
  {
    label: "Temperature spike",
    apply: () => {
      trafficMode.value = "high";
      temperature.value = 97;
      humidity.value = 22;
      battery.value = 41;
    },
  },
  {
    label: "Humidity drop",
    apply: () => {
      trafficMode.value = "low";
      temperature.value = 31;
      humidity.value = 8;
      battery.value = 53;
    },
  },
  {
    label: "Battery drain",
    apply: () => {
      trafficMode.value = "high";
      temperature.value = 74;
      humidity.value = 38;
      battery.value = 5;
    },
  },
];

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message =
      record.__error ?? record.error ?? record.message ?? record.statusMessage;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }

    try {
      return JSON.stringify(record);
    } catch {
      return String(record);
    }
  }

  return String(error ?? "Unknown error");
}

async function submit() {
  submitting.value = true;
  errorMessage.value = "";

  try {
    const result = await runtime.commands.ingestTelemetry({
      deviceId: deviceId.value.trim(),
      trafficMode: trafficMode.value,
      readings: {
        temperature: Number(temperature.value),
        humidity: Number(humidity.value),
        battery: Number(battery.value),
      },
    });
    if (
      result &&
      typeof result === "object" &&
      (result.errored === true || result.failed === true || result.__success === false)
    ) {
      throw new Error(formatRuntimeError(result));
    }
    statusMessage.value = `Telemetry dispatched for ${deviceId.value}.`;
    emit("ingested");
  } catch (error) {
    errorMessage.value = formatRuntimeError(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <div class="section-label">Manual controls</div>
    <div class="form-grid">
      <div class="preset-row">
        <button
          v-for="preset in presets"
          :key="preset.label"
          class="preset-button"
          type="button"
          @click="preset.apply()"
        >
          {{ preset.label }}
        </button>
      </div>
      <div class="form-row">
        <label class="field-label" for="device-id">Device</label>
        <input id="device-id" v-model="deviceId" class="field-input" />
      </div>
      <div class="form-row form-row--triple">
        <div>
          <label class="field-label" for="temperature">Temperature</label>
          <input id="temperature" v-model.number="temperature" class="field-input" type="number" />
        </div>
        <div>
          <label class="field-label" for="humidity">Humidity</label>
          <input id="humidity" v-model.number="humidity" class="field-input" type="number" />
        </div>
        <div>
          <label class="field-label" for="battery">Battery</label>
          <input id="battery" v-model.number="battery" class="field-input" type="number" />
        </div>
      </div>
      <div class="form-row">
        <label class="field-label" for="traffic-mode">Traffic mode</label>
        <select id="traffic-mode" v-model="trafficMode" class="field-select">
          <option value="low">low</option>
          <option value="high">high</option>
        </select>
      </div>
      <div class="button-row">
        <button class="button" type="button" :disabled="submitting" @click="submit">
          {{ submitting ? "Dispatching..." : "Emit telemetry intent" }}
        </button>
      </div>
      <div class="status-line">{{ statusMessage }}</div>
      <div v-if="errorMessage" class="status-line" style="color: var(--danger)">
        {{ errorMessage }}
      </div>
    </div>
  </section>
</template>
