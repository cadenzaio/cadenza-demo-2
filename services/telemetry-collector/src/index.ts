import Cadenza from "@cadenza.io/service";
import {
  IOT_INTENTS,
  IOT_DB_INTENTS,
  IOT_SIGNALS,
  type PredictionResult,
  type TelemetryIngestPayload,
  type AnomalyResult,
} from "./contracts.js";

type TelemetrySessionState = {
  lastTelemetry: TelemetryIngestPayload | null;
  validationCount: number;
  outlierCount: number;
  lastAnomaly: AnomalyResult | null;
  lastPrediction: PredictionResult | null;
  lastIngestedAt: string | null;
};

const telemetrySessionActor = Cadenza.createActor<TelemetrySessionState>({
  name: "TelemetrySessionActor",
  description:
    "Per-device durable telemetry session state used for demo observability and recovery.",
  defaultKey: "device:unknown",
  keyResolver: (input: any) =>
    typeof input?.deviceId === "string" ? input.deviceId : undefined,
  initState: {
    lastTelemetry: null,
    validationCount: 0,
    outlierCount: 0,
    lastAnomaly: null,
    lastPrediction: null,
    lastIngestedAt: null,
  },
  session: {
    persistDurableState: true,
    persistenceTimeoutMs: 5000,
  },
});

const normalizeIngestPayloadTask = Cadenza.createTask(
  "Normalize telemetry ingest payload",
  (ctx: any) => {
    const deviceId = typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";
    const timestamp =
      typeof ctx.timestamp === "string" && ctx.timestamp.length > 0
        ? ctx.timestamp
        : new Date().toISOString();

    const readings = ctx.readings ?? {};
    const temperature = Number(readings.temperature);
    const humidity = Number(readings.humidity);
    const battery = Number(readings.battery);

    if (!deviceId) {
      throw new Error("deviceId is required for iot-telemetry-ingest");
    }

    if (
      !Number.isFinite(temperature) ||
      !Number.isFinite(humidity) ||
      !Number.isFinite(battery)
    ) {
      throw new Error("telemetry readings.temperature/humidity/battery must be finite numbers");
    }

    const telemetryPayload: TelemetryIngestPayload = {
      deviceId,
      timestamp,
      readings: {
        temperature,
        humidity,
        battery,
      },
      source: "scheduler",
      trafficMode: ctx.trafficMode === "high" ? "high" : "low",
    };

    return {
      ...ctx,
      ...telemetryPayload,
      telemetryPayload,
      isOutlier:
        temperature > 85 ||
        temperature < 0 ||
        humidity > 95 ||
        humidity < 10 ||
        battery < 10,
    };
  },
  "Validates canonical telemetry ingest payload and normalizes to internal context.",
);

const recordTelemetryIngestTask = Cadenza.createTask(
  "Record telemetry ingest session state",
  telemetrySessionActor.task(
    ({ input, state, setState }) => {
      const nextValidationCount = state.validationCount + 1;
      const nextOutlierCount = state.outlierCount + (input.isOutlier ? 1 : 0);

      setState({
        ...state,
        lastTelemetry: input.telemetryPayload,
        validationCount: nextValidationCount,
        outlierCount: nextOutlierCount,
        lastIngestedAt: input.timestamp,
      });

      return {
        validationCount: nextValidationCount,
        outlierCount: nextOutlierCount,
      };
    },
    { mode: "write" },
  ),
  "Updates durable telemetry session actor with current ingest payload counters.",
);

const prepareTelemetryInsertTask = Cadenza.createTask(
  "Prepare telemetry insert payload",
  (ctx: any) => {
    const payload: TelemetryIngestPayload = ctx.telemetryPayload;

    return {
      ...ctx,
      data: {
        device_id: payload.deviceId,
        timestamp: payload.timestamp,
        temperature: payload.readings.temperature,
        humidity: payload.readings.humidity,
        battery: payload.readings.battery,
        raw_json: payload,
      },
    };
  },
  "Maps telemetry payload to iot-db telemetry table contract.",
);

const persistTelemetryTask = Cadenza.createTask(
  "Persist telemetry via iot-db intent",
  async (ctx: any, _emit: any, inquire: any) => {
    await inquire(
      IOT_DB_INTENTS.telemetryInsert,
      { data: ctx.data },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    );

    return ctx;
  },
  "Persists telemetry row through canonical internal iot-db insert intent.",
);

const emitTelemetryIngestedSignalTask = Cadenza.createTask(
  "Emit telemetry ingested signal",
  (ctx: any, emit: any) => {
    emit(IOT_SIGNALS.telemetryIngested, {
      deviceId: ctx.deviceId,
      timestamp: ctx.timestamp,
      readings: ctx.readings,
      source: ctx.telemetryPayload?.source ?? "scheduler",
      trafficMode: ctx.telemetryPayload?.trafficMode ?? "low",
    });

    return ctx;
  },
  "Emits canonical telemetry-ingested signal after persistence.",
).attachSignal(IOT_SIGNALS.telemetryIngested);

const detectAnomalyTask = Cadenza.createTask(
  "Detect anomaly via intent",
  async (ctx: any, emit: any, inquire: any) => {
    const anomalyResponse = (await inquire(
      IOT_INTENTS.anomalyDetect,
      {
        deviceId: ctx.deviceId,
        timestamp: ctx.timestamp,
        readings: ctx.readings,
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    )) as Partial<AnomalyResult> & { __success?: boolean };

    const anomalyResult: AnomalyResult = {
      deviceId: String(anomalyResponse.deviceId ?? ctx.deviceId),
      timestamp: String(anomalyResponse.timestamp ?? ctx.timestamp),
      anomalyDetected: Boolean(anomalyResponse.anomalyDetected),
      anomalyScore: Number(anomalyResponse.anomalyScore ?? 0),
      reason: String(anomalyResponse.reason ?? "No anomaly"),
      metrics: {
        temperature: {
          score: Number(anomalyResponse.metrics?.temperature?.score ?? 0),
          zScore: Number(anomalyResponse.metrics?.temperature?.zScore ?? 0),
          anomalous: Boolean(anomalyResponse.metrics?.temperature?.anomalous),
        },
        humidity: {
          score: Number(anomalyResponse.metrics?.humidity?.score ?? 0),
          zScore: Number(anomalyResponse.metrics?.humidity?.zScore ?? 0),
          anomalous: Boolean(anomalyResponse.metrics?.humidity?.anomalous),
        },
      },
    };

    if (anomalyResult.anomalyDetected) {
      emit(IOT_SIGNALS.anomalyDetected, {
        ...anomalyResult,
        readings: ctx.readings,
      });
    }

    return {
      ...ctx,
      anomalyResult,
    };
  },
  "Calls canonical anomaly intent and emits anomaly signal when threshold is crossed.",
).attachSignal(IOT_SIGNALS.anomalyDetected);

const computePredictionTask = Cadenza.createTask(
  "Compute prediction via intent",
  async (ctx: any, _emit: any, inquire: any) => {
    const predictionResult = (await inquire(
      IOT_INTENTS.predictionCompute,
      {
        deviceId: ctx.deviceId,
        timestamp: ctx.timestamp,
        readings: ctx.readings,
        anomalyResult: ctx.anomalyResult,
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    )) as PredictionResult & { __success?: boolean };

    return {
      ...ctx,
      predictionResult,
    };
  },
  "Calls canonical prediction intent for downstream risk computation and persistence.",
);

const recordTelemetryAnalysisTask = Cadenza.createTask(
  "Record telemetry analysis session state",
  telemetrySessionActor.task(
    ({ input, state, setState }) => {
      setState({
        ...state,
        lastAnomaly: input.anomalyResult ?? state.lastAnomaly,
        lastPrediction: input.predictionResult ?? state.lastPrediction,
      });

      return {
        lastAnomaly: input.anomalyResult ?? state.lastAnomaly,
        lastPrediction: input.predictionResult ?? state.lastPrediction,
      };
    },
    { mode: "write" },
  ),
  "Persists latest anomaly/prediction outcomes for telemetry session actor.",
);

const finalizeTelemetryIngestTask = Cadenza.createTask(
  "Finalize telemetry ingest response",
  (ctx: any) => {
    return {
      __success: true,
      ingested: true,
      deviceId: ctx.deviceId,
      timestamp: ctx.timestamp,
      anomaly: ctx.anomalyResult ?? null,
      prediction: ctx.predictionResult ?? null,
    };
  },
  "Builds canonical iot-telemetry-ingest response payload.",
);

normalizeIngestPayloadTask
  .then(recordTelemetryIngestTask)
  .then(prepareTelemetryInsertTask)
  .then(persistTelemetryTask)
  .then(emitTelemetryIngestedSignalTask)
  .then(detectAnomalyTask)
  .then(computePredictionTask)
  .then(recordTelemetryAnalysisTask)
  .then(finalizeTelemetryIngestTask)
  .respondsTo(IOT_INTENTS.telemetryIngest);

Cadenza.createTask(
  "Get telemetry session state",
  telemetrySessionActor.task(
    ({ actor, state }) => ({
      __success: true,
      actorKey: actor.key,
      session: state,
    }),
    { mode: "read" },
  ),
  "Returns persisted telemetry actor session state by device key.",
).respondsTo(IOT_INTENTS.telemetrySessionGet);

Cadenza.createCadenzaService(
  "TelemetryCollectorService",
  "Accepts canonical telemetry ingest requests and orchestrates anomaly/prediction flow.",
  {
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
      port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    },
  },
);

process.on("SIGTERM", () => {
  Cadenza.log("Telemetry Collector shutting down gracefully.");
  process.exit(0);
});
