import Cadenza from "@cadenza.io/service";
import { IOT_INTENTS, type AnomalyResult, type DeviceReadings } from "./contracts.js";

type AnomalyRuntimeState = {
  recentTemperatures: number[];
  recentHumidities: number[];
  recentScores: number[];
  lastAnomalyAt: string | null;
};

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stdDev(values: number[], center: number): number {
  if (values.length < 2) {
    return 0;
  }

  const variance =
    values.reduce((acc, value) => acc + (value - center) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}

function safeZScore(value: number, values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const center = mean(values);
  const deviation = stdDev(values, center);

  if (!Number.isFinite(deviation) || deviation === 0) {
    return 0;
  }

  return Math.abs((value - center) / deviation);
}

const anomalyRuntimeActor = Cadenza.createActor<
  { enabled: boolean },
  AnomalyRuntimeState
>({
  name: "AnomalyRuntimeActor",
  description:
    "Runtime-only rolling telemetry statistics for anomaly detection history windows.",
  defaultKey: "device:unknown",
  keyResolver: (input: any) =>
    typeof input?.deviceId === "string" ? input.deviceId : undefined,
  initState: {
    enabled: true,
  },
  session: {
    persistDurableState: false,
  },
});

const normalizeAnomalyInputTask = Cadenza.createTask(
  "Normalize anomaly detect input",
  (ctx: any) => {
    const deviceId = typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";
    const timestamp =
      typeof ctx.timestamp === "string" && ctx.timestamp.length > 0
        ? ctx.timestamp
        : new Date().toISOString();

    const readings = ctx.readings ?? {};
    const temperature = Number(readings.temperature);
    const humidity = Number(readings.humidity);
    const battery = Number(readings.battery ?? 100);

    if (!deviceId) {
      throw new Error("deviceId is required for iot-anomaly-detect");
    }

    if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
      throw new Error("readings.temperature and readings.humidity are required numbers");
    }

    const normalizedReadings: DeviceReadings = {
      temperature,
      humidity,
      battery: Number.isFinite(battery) ? battery : 100,
    };

    return {
      ...ctx,
      deviceId,
      timestamp,
      readings: normalizedReadings,
    };
  },
  "Normalizes anomaly-detect input and enforces canonical payload contract.",
);

const detectAnomalyTask = Cadenza.createTask(
  "Detect anomaly from rolling runtime history",
  anomalyRuntimeActor.task(
    ({ input, runtimeState, setRuntimeState }) => {
      const state: AnomalyRuntimeState = runtimeState ?? {
        recentTemperatures: [],
        recentHumidities: [],
        recentScores: [],
        lastAnomalyAt: null,
      };

      const tempHistory = state.recentTemperatures;
      const humidityHistory = state.recentHumidities;

      const tempZScore = safeZScore(input.readings.temperature, tempHistory);
      const humidityZScore = safeZScore(input.readings.humidity, humidityHistory);

      const tempScore = Math.min(tempZScore / 3, 1);
      const humidityScore = Math.min(humidityZScore / 3, 1);
      const anomalyScore = Number(((tempScore + humidityScore) / 2).toFixed(4));

      const temperatureAnomalous = tempZScore > 2;
      const humidityAnomalous = humidityZScore > 2;
      const anomalyDetected =
        anomalyScore >= 0.65 || temperatureAnomalous || humidityAnomalous;

      const reason = anomalyDetected
        ? `Anomaly score ${anomalyScore.toFixed(3)} (tempZ=${tempZScore.toFixed(2)}, humidityZ=${humidityZScore.toFixed(2)})`
        : "No anomaly threshold crossed";

      const nextRuntimeState: AnomalyRuntimeState = {
        recentTemperatures: [...tempHistory, input.readings.temperature].slice(-50),
        recentHumidities: [...humidityHistory, input.readings.humidity].slice(-50),
        recentScores: [...state.recentScores, anomalyScore].slice(-50),
        lastAnomalyAt: anomalyDetected ? input.timestamp : state.lastAnomalyAt,
      };

      setRuntimeState(nextRuntimeState);

      const anomalyResult: AnomalyResult = {
        deviceId: input.deviceId,
        timestamp: input.timestamp,
        anomalyDetected,
        anomalyScore,
        reason,
        metrics: {
          temperature: {
            score: Number(tempScore.toFixed(4)),
            zScore: Number(tempZScore.toFixed(4)),
            anomalous: temperatureAnomalous,
          },
          humidity: {
            score: Number(humidityScore.toFixed(4)),
            zScore: Number(humidityZScore.toFixed(4)),
            anomalous: humidityAnomalous,
          },
        },
      };

      return anomalyResult;
    },
    { mode: "write" },
  ),
  "Computes anomaly result using runtime-only rolling stats and handles empty-series/zero-variance safely.",
);

const finalizeAnomalyResponseTask = Cadenza.createTask(
  "Finalize anomaly response",
  (ctx: any) => {
    return {
      __success: true,
      deviceId: ctx.deviceId,
      timestamp: ctx.timestamp,
      anomalyDetected: Boolean(ctx.anomalyDetected),
      anomalyScore: Number(ctx.anomalyScore ?? 0),
      reason: String(ctx.reason ?? "No anomaly"),
      metrics: ctx.metrics,
    };
  },
  "Builds canonical iot-anomaly-detect response payload.",
);

normalizeAnomalyInputTask
  .then(detectAnomalyTask)
  .then(finalizeAnomalyResponseTask)
  .respondsTo(IOT_INTENTS.anomalyDetect);

Cadenza.createTask(
  "Read anomaly runtime session",
  anomalyRuntimeActor.task(
    ({ actor, runtimeState }) => ({
      __success: true,
      actorKey: actor.key,
      runtimeSession: runtimeState ?? {
        recentTemperatures: [],
        recentHumidities: [],
        recentScores: [],
        lastAnomalyAt: null,
      },
    }),
    { mode: "read" },
  ),
  "Exposes runtime anomaly cache state for debugging.",
).respondsTo("iot-anomaly-runtime-get");

Cadenza.createCadenzaService(
  "AnomalyDetectorService",
  "Computes canonical anomaly results using runtime rolling telemetry history.",
  {
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
      port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    },
  },
);

process.on("SIGTERM", () => {
  Cadenza.log("Anomaly Detector shutting down gracefully.");
  process.exit(0);
});
