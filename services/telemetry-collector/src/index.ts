import Cadenza from "@cadenza.io/service";
import { randomUUID } from "node:crypto";
import {
  IOT_DB_INTENTS,
  IOT_INTENTS,
  IOT_SIGNALS,
  type PredictionResult,
  type TelemetryIngestPayload,
  type AnomalyResult,
} from "./contracts.js";

const publicOrigin =
  process.env.PUBLIC_ORIGIN ?? "http://telemetry-collector.localhost";
const internalOrigin = `http://${process.env.CADENZA_SERVER_URL ?? "telemetry-collector"}:${
  process.env.HTTP_PORT ?? "3003"
}`;

type TelemetrySessionState = {
  lastTelemetry: TelemetryIngestPayload | null;
  validationCount: number;
  outlierCount: number;
  lastAnomaly: AnomalyResult | null;
  lastPrediction: PredictionResult | null;
  lastIngestedAt: string | null;
};

type InquiryErrorDetails = {
  values: string[];
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
    // Durable actor hydration is not available yet, so persisted rows from
    // previous runs can reject fresh writes after restart via stale versions.
    persistDurableState: false,
    persistenceTimeoutMs: 30000,
  },
});

const TELEMETRY_SESSION_INGEST_PERSIST_SIGNAL =
  "meta.demo.telemetry.session_ingest_persist_requested";
const TELEMETRY_SESSION_ANALYSIS_PERSIST_SIGNAL =
  "meta.demo.telemetry.session_analysis_persist_requested";

function describeInquiryError(error: unknown): InquiryErrorDetails {
  const values: string[] = [];
  const seen = new Set<unknown>();

  const collect = (value: unknown, depth = 3) => {
    if (depth < 0 || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      values.push(value);
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      values.push(String(value));
      return;
    }

    if (typeof value !== "object" || seen.has(value)) {
      return;
    }

    seen.add(value);

    for (const nested of Object.values(value as Record<string, unknown>)) {
      collect(nested, depth - 1);
    }
  };

  collect(error);

  if (values.length === 0) {
    values.push(String(error));
  }

  return { values };
}

function isManagedIotDbRecoveryError(error: unknown): boolean {
  const details = describeInquiryError(error);
  const values = details.values.join(" | ");

  return (
    values.includes("No routeable internal transport available") &&
    values.includes("Waiting for authority route updates before retrying")
  );
}

function isManagedPredictionRecoveryError(error: unknown): boolean {
  const details = describeInquiryError(error);
  const values = details.values.join(" | ");

  return (
    values.includes(IOT_INTENTS.predictionCompute) ||
    values.includes("PredictorService") ||
    values.includes("No routeable internal transport available") ||
    values.includes("Waiting for authority route updates before retrying") ||
    values.includes("ECONNREFUSED")
  );
}

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
        ...input,
        validationCount: nextValidationCount,
        outlierCount: nextOutlierCount,
      };
    },
    { mode: "write" },
  ),
  "Updates durable telemetry session actor with current ingest payload counters.",
);

const requestTelemetryIngestSessionPersistenceTask = Cadenza.createTask(
  "Request telemetry ingest session persistence",
  (ctx: any, emit: any) => {
    emit(TELEMETRY_SESSION_INGEST_PERSIST_SIGNAL, ctx);
    return ctx;
  },
  "Detaches telemetry ingest session persistence from the inquiry-critical path.",
);

const prepareTelemetryInsertTask = Cadenza.createTask(
  "Prepare telemetry insert payload",
  (ctx: any) => {
    const payload: TelemetryIngestPayload = ctx.telemetryPayload;
    const insertData = {
      uuid: randomUUID(),
      device_id: payload.deviceId,
      timestamp: payload.timestamp,
      temperature: payload.readings.temperature,
      humidity: payload.readings.humidity,
      battery: payload.readings.battery,
      raw_json: payload,
    };

    return {
      ...ctx,
      data: insertData,
      queryData: {
        ...(ctx.queryData ?? {}),
        data: insertData,
        onConflict: {
          target: ["device_id", "timestamp"],
          action: {
            do: "nothing",
          },
        },
      },
    };
  },
  "Maps telemetry payload to iot-db telemetry table contract.",
);

const persistTelemetryTask = Cadenza.createTask(
  "Persist telemetry via IoT DB intent",
  async (ctx: any, _emit: any, inquire: any) => {
    const payload =
      ctx.queryData ??
      (ctx.data ? { data: ctx.data } : undefined) ??
      (ctx.telemetryPayload
        ? {
            data: {
              uuid: randomUUID(),
              device_id: ctx.telemetryPayload.deviceId,
              timestamp: ctx.telemetryPayload.timestamp,
              temperature: ctx.telemetryPayload.readings.temperature,
              humidity: ctx.telemetryPayload.readings.humidity,
              battery: ctx.telemetryPayload.readings.battery,
              raw_json: ctx.telemetryPayload,
            },
            onConflict: {
              target: ["device_id", "timestamp"],
              action: {
                do: "nothing",
              },
            },
          }
        : undefined);
    let result: any;

    try {
      result = await inquire(IOT_DB_INTENTS.telemetryInsert, payload, {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      });
    } catch (error) {
      if (isManagedIotDbRecoveryError(error)) {
        return {
          ...ctx,
          iotDbPersistenceDeferred: true,
          deferredReason: "iot_db_route_recovering",
        };
      }

      throw error;
    }

    if (
      result &&
      typeof result === "object" &&
      (result.errored === true || result.failed === true) &&
      isManagedIotDbRecoveryError(result)
    ) {
      return {
        ...ctx,
        iotDbPersistenceDeferred: true,
        deferredReason: "iot_db_route_recovering",
      };
    }

    return {
      ...ctx,
      ...(typeof result === "object" && result ? result : {}),
    };
  },
  "Persists telemetry rows through the generated IoT DB insert intent.",
);

const emitTelemetryIngestedSignalTask = Cadenza.createTask(
  "Emit telemetry ingested signal",
  (ctx: any, emit: any) => {
    if (ctx.iotDbPersistenceDeferred) {
      return ctx;
    }

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
    if (ctx.iotDbPersistenceDeferred) {
      return {
        ...ctx,
        anomalyResult: null,
      };
    }

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
    if (ctx.iotDbPersistenceDeferred) {
      return {
        ...ctx,
        predictionResult: null,
      };
    }

    let predictionResult: PredictionResult & { __success?: boolean };

    try {
      predictionResult = (await inquire(
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
    } catch (error) {
      if (isManagedPredictionRecoveryError(error)) {
        return {
          ...ctx,
          predictionResult: null,
          predictionDeferred: true,
          predictionDeferredReason: "predictor_route_recovering",
        };
      }

      throw error;
    }

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
        ...input,
        lastAnomaly: input.anomalyResult ?? state.lastAnomaly,
        lastPrediction: input.predictionResult ?? state.lastPrediction,
      };
    },
    { mode: "write" },
  ),
  "Persists latest anomaly/prediction outcomes for telemetry session actor.",
);

const requestTelemetryAnalysisSessionPersistenceTask = Cadenza.createTask(
  "Request telemetry analysis session persistence",
  (ctx: any, emit: any) => {
    if (ctx.iotDbPersistenceDeferred) {
      return ctx;
    }

    emit(TELEMETRY_SESSION_ANALYSIS_PERSIST_SIGNAL, ctx);
    return ctx;
  },
  "Detaches telemetry analysis session persistence from the inquiry-critical path.",
);

const finalizeTelemetryIngestTask = Cadenza.createTask(
  "Finalize telemetry ingest response",
  (ctx: any) => {
    if (ctx.iotDbPersistenceDeferred) {
      return {
        __success: true,
        ingested: false,
        deferred: true,
        deferredReason: ctx.deferredReason ?? "iot_db_route_recovering",
        deviceId: ctx.deviceId,
        timestamp: ctx.timestamp,
        anomaly: null,
        prediction: null,
      };
    }

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

normalizeIngestPayloadTask.then(requestTelemetryIngestSessionPersistenceTask);
requestTelemetryIngestSessionPersistenceTask.then(prepareTelemetryInsertTask);
prepareTelemetryInsertTask.then(persistTelemetryTask);
persistTelemetryTask.then(emitTelemetryIngestedSignalTask);
emitTelemetryIngestedSignalTask.then(detectAnomalyTask);
detectAnomalyTask.then(computePredictionTask);
computePredictionTask.then(requestTelemetryAnalysisSessionPersistenceTask);
requestTelemetryAnalysisSessionPersistenceTask.then(finalizeTelemetryIngestTask);
normalizeIngestPayloadTask.respondsTo(IOT_INTENTS.telemetryIngest);

recordTelemetryIngestTask.doOn(TELEMETRY_SESSION_INGEST_PERSIST_SIGNAL);
recordTelemetryAnalysisTask.doOn(TELEMETRY_SESSION_ANALYSIS_PERSIST_SIGNAL);

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
    useSocket: false,
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
      port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    },
    transports: [
      {
        role: "internal",
        origin: internalOrigin,
        protocols: ["rest"],
      },
      {
        role: "public",
        origin: publicOrigin,
        protocols: ["rest"],
      },
    ],
  },
);
