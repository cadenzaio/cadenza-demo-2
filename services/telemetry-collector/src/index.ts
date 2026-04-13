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
const META_ACTOR_SESSION_STATE_HYDRATE_INTENT = "meta-actor-session-state-hydrate";
const META_ACTOR_SESSION_STATE_PERSIST_INTENT = "meta-actor-session-state-persist";
const TELEMETRY_SESSION_PERSIST_TIMEOUT_MS = 10_000;
const TELEMETRY_SESSION_FLUSH_DEBOUNCE_MS = 2_000;
const TELEMETRY_SESSION_RETRY_BASE_MS = 1_000;
const TELEMETRY_SESSION_RETRY_MAX_MS = 30_000;
const TELEMETRY_SESSION_ACTOR_NAME = "TelemetrySessionActor";
const TELEMETRY_SESSION_ACTOR_VERSION = 1;

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

type TelemetrySessionRuntimeState = TelemetrySessionState & {
  __hydrated: boolean;
  __durableVersion: number;
  __persistenceDeferred: boolean;
  __lastPersistenceError: string | null;
};

type PendingTelemetrySessionFlush = {
  deviceId: string;
  durableState: TelemetrySessionState;
  durableVersion: number;
  retryDelayMs: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type CadenzaInquiry = (
  inquiryName: string,
  context: Record<string, unknown>,
  options: any,
) => Promise<any>;

const hydratedTelemetrySessionKeys = new Set<string>();
const pendingTelemetrySessionHydrations = new Map<
  string,
  Promise<TelemetrySessionRuntimeState>
>();
const pendingTelemetrySessionFlushes = new Map<string, PendingTelemetrySessionFlush>();
let latestTelemetrySessionInquire: CadenzaInquiry | null = null;

const telemetrySessionActor = Cadenza.createActor<TelemetrySessionRuntimeState>({
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
    __hydrated: false,
    __durableVersion: 0,
    __persistenceDeferred: false,
    __lastPersistenceError: null,
  },
  session: {
    persistDurableState: false,
  },
});

function buildDefaultTelemetrySessionState(): TelemetrySessionState {
  return {
    lastTelemetry: null,
    validationCount: 0,
    outlierCount: 0,
    lastAnomaly: null,
    lastPrediction: null,
    lastIngestedAt: null,
  };
}

function sanitizeTelemetryPayload(payload: unknown): TelemetryIngestPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, any>;
  const readings = value.readings ?? {};

  const deviceId =
    typeof value.deviceId === "string" ? value.deviceId : "";
  const timestamp =
    typeof value.timestamp === "string" ? value.timestamp : "";
  const temperature = Number(readings.temperature);
  const humidity = Number(readings.humidity);
  const battery = Number(readings.battery);

  if (
    !deviceId ||
    !timestamp ||
    !Number.isFinite(temperature) ||
    !Number.isFinite(humidity) ||
    !Number.isFinite(battery)
  ) {
    return null;
  }

  return {
    deviceId,
    timestamp,
    readings: {
      temperature,
      humidity,
      battery,
    },
    source: "scheduler",
    trafficMode: value.trafficMode === "high" ? "high" : "low",
  };
}

function sanitizeAnomalyResult(result: unknown): AnomalyResult | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const value = result as Record<string, any>;

  return {
    deviceId: String(value.deviceId ?? ""),
    timestamp: String(value.timestamp ?? ""),
    anomalyDetected: Boolean(value.anomalyDetected),
    anomalyScore: Number(value.anomalyScore ?? 0),
    reason: String(value.reason ?? "No anomaly"),
    metrics: {
      temperature: {
        score: Number(value.metrics?.temperature?.score ?? 0),
        zScore: Number(value.metrics?.temperature?.zScore ?? 0),
        anomalous: Boolean(value.metrics?.temperature?.anomalous),
      },
      humidity: {
        score: Number(value.metrics?.humidity?.score ?? 0),
        zScore: Number(value.metrics?.humidity?.zScore ?? 0),
        anomalous: Boolean(value.metrics?.humidity?.anomalous),
      },
    },
  };
}

function sanitizePredictionResult(result: unknown): PredictionResult | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const value = result as Record<string, any>;

  return {
    deviceId: String(value.deviceId ?? ""),
    timestamp: String(value.timestamp ?? ""),
    failureProbability: Number(value.failureProbability ?? 0),
    maintenanceNeeded: Boolean(value.maintenanceNeeded),
    predictedEta: String(value.predictedEta ?? ""),
    riskFactors: {
      anomalyScore: Number(value.riskFactors?.anomalyScore ?? 0),
      weatherCondition: String(value.riskFactors?.weatherCondition ?? "unknown"),
      weatherMultiplier: Number(value.riskFactors?.weatherMultiplier ?? 1),
    },
  };
}

function createTelemetrySessionRuntimeState(
  state: Partial<TelemetrySessionState> | null | undefined,
  durableVersion = 0,
  options: Partial<
    Pick<
      TelemetrySessionRuntimeState,
      "__hydrated" | "__persistenceDeferred" | "__lastPersistenceError"
    >
  > = {},
): TelemetrySessionRuntimeState {
  const base = buildDefaultTelemetrySessionState();

  return {
    ...base,
    ...(state ?? {}),
    lastTelemetry: sanitizeTelemetryPayload(state?.lastTelemetry) ?? null,
    lastAnomaly: sanitizeAnomalyResult(state?.lastAnomaly) ?? null,
    lastPrediction: sanitizePredictionResult(state?.lastPrediction) ?? null,
    validationCount: Number(state?.validationCount ?? base.validationCount),
    outlierCount: Number(state?.outlierCount ?? base.outlierCount),
    lastIngestedAt:
      typeof state?.lastIngestedAt === "string" ? state.lastIngestedAt : null,
    __hydrated: options.__hydrated ?? true,
    __durableVersion: Math.max(0, Number(durableVersion) || 0),
    __persistenceDeferred: options.__persistenceDeferred ?? false,
    __lastPersistenceError: options.__lastPersistenceError ?? null,
  };
}

function stripTelemetrySessionRuntimeState(
  state: Partial<TelemetrySessionRuntimeState> | null | undefined,
): TelemetrySessionState {
  const runtime = createTelemetrySessionRuntimeState(state ?? null, state?.__durableVersion ?? 0);

  return {
    lastTelemetry: runtime.lastTelemetry,
    validationCount: runtime.validationCount,
    outlierCount: runtime.outlierCount,
    lastAnomaly: runtime.lastAnomaly,
    lastPrediction: runtime.lastPrediction,
    lastIngestedAt: runtime.lastIngestedAt,
  };
}

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

function isManagedTelemetrySessionPersistenceRecoveryError(error: unknown): boolean {
  const details = describeInquiryError(error);
  const values = details.values.join(" | ");

  return (
    values.includes("No routeable internal transport available") ||
    values.includes("Waiting for authority route updates before retrying") ||
    values.includes("ECONNREFUSED") ||
    values.includes("ENOTFOUND") ||
    values.includes("timed out") ||
    values.includes("failed, reason:")
  );
}

function scheduleTelemetrySessionFlush(
  pending: PendingTelemetrySessionFlush,
  delayMs: number,
): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    pending.timer = null;
    void flushTelemetrySession(pending.deviceId);
  }, delayMs);
  pending.timer.unref?.();
}

async function flushTelemetrySession(deviceId: string): Promise<void> {
  const pending = pendingTelemetrySessionFlushes.get(deviceId);
  if (!pending || pending.inFlight) {
    return;
  }

  const inquire = latestTelemetrySessionInquire;
  if (!inquire) {
    scheduleTelemetrySessionFlush(pending, pending.retryDelayMs);
    return;
  }

  const snapshotVersion = pending.durableVersion;
  const snapshotState = pending.durableState;
  pending.inFlight = true;

  try {
    const result = await inquire(
      META_ACTOR_SESSION_STATE_PERSIST_INTENT,
      {
        actor_name: TELEMETRY_SESSION_ACTOR_NAME,
        actor_key: deviceId,
        actor_version: TELEMETRY_SESSION_ACTOR_VERSION,
        durable_state: snapshotState,
        durable_version: snapshotVersion,
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: TELEMETRY_SESSION_PERSIST_TIMEOUT_MS,
      },
    );

    if (
      result &&
      typeof result === "object" &&
      (result.errored === true || result.failed === true || result.__success === false)
    ) {
      throw result;
    }

    const current = pendingTelemetrySessionFlushes.get(deviceId);
    if (!current) {
      return;
    }

    current.inFlight = false;
    current.retryDelayMs = TELEMETRY_SESSION_RETRY_BASE_MS;

    if (current.durableVersion <= snapshotVersion) {
      pendingTelemetrySessionFlushes.delete(deviceId);
      return;
    }

    scheduleTelemetrySessionFlush(current, TELEMETRY_SESSION_FLUSH_DEBOUNCE_MS);
  } catch (error) {
    const current = pendingTelemetrySessionFlushes.get(deviceId);
    if (!current) {
      return;
    }

    current.inFlight = false;
    current.retryDelayMs = Math.min(
      Math.max(current.retryDelayMs, TELEMETRY_SESSION_RETRY_BASE_MS) * 2,
      TELEMETRY_SESSION_RETRY_MAX_MS,
    );

    if (!isManagedTelemetrySessionPersistenceRecoveryError(error)) {
      current.retryDelayMs = TELEMETRY_SESSION_RETRY_MAX_MS;
    }

    scheduleTelemetrySessionFlush(current, current.retryDelayMs);
  }
}

function queueTelemetrySessionFlush(
  deviceId: string,
  state: TelemetrySessionRuntimeState,
  inquire: CadenzaInquiry,
): TelemetrySessionRuntimeState {
  latestTelemetrySessionInquire = inquire;

  const durableState = stripTelemetrySessionRuntimeState(state);
  const durableVersion = state.__durableVersion;
  const existing = pendingTelemetrySessionFlushes.get(deviceId);

  if (existing) {
    existing.durableState = durableState;
    existing.durableVersion = durableVersion;

    if (!existing.inFlight) {
      existing.retryDelayMs = TELEMETRY_SESSION_RETRY_BASE_MS;
      scheduleTelemetrySessionFlush(existing, TELEMETRY_SESSION_FLUSH_DEBOUNCE_MS);
    }
  } else {
    const pending: PendingTelemetrySessionFlush = {
      deviceId,
      durableState,
      durableVersion,
      retryDelayMs: TELEMETRY_SESSION_RETRY_BASE_MS,
      inFlight: false,
      timer: null,
    };
    pendingTelemetrySessionFlushes.set(deviceId, pending);
    scheduleTelemetrySessionFlush(pending, TELEMETRY_SESSION_FLUSH_DEBOUNCE_MS);
  }

  return {
    ...state,
    __persistenceDeferred: true,
    __lastPersistenceError: null,
  };
}

async function loadDurableTelemetrySessionState(
  deviceId: string,
  inquire: CadenzaInquiry,
): Promise<TelemetrySessionRuntimeState> {
  if (hydratedTelemetrySessionKeys.has(deviceId)) {
    return createTelemetrySessionRuntimeState(undefined, 0, { __hydrated: false });
  }

  const existing = pendingTelemetrySessionHydrations.get(deviceId);
  if (existing) {
    return existing;
  }

  const hydration = (async () => {
    try {
      const result = await inquire(
        META_ACTOR_SESSION_STATE_HYDRATE_INTENT,
        {
          actor_name: TELEMETRY_SESSION_ACTOR_NAME,
          actor_key: deviceId,
          actor_version: TELEMETRY_SESSION_ACTOR_VERSION,
        },
        {
          requireComplete: true,
          rejectOnTimeout: true,
          timeout: TELEMETRY_SESSION_PERSIST_TIMEOUT_MS,
        },
      );

      if (
        result &&
        typeof result === "object" &&
        result.__success === true &&
        result.hydrated === true
      ) {
        return createTelemetrySessionRuntimeState(
          result.durable_state as Partial<TelemetrySessionState>,
          Number(result.durable_version ?? 0),
        );
      }
    } catch (error) {
      return createTelemetrySessionRuntimeState(
        undefined,
        0,
        {
          __persistenceDeferred: true,
          __lastPersistenceError: describeInquiryError(error).values[0] ?? null,
        },
      );
    } finally {
      pendingTelemetrySessionHydrations.delete(deviceId);
    }

    return createTelemetrySessionRuntimeState(undefined, 0);
  })();

  pendingTelemetrySessionHydrations.set(deviceId, hydration);
  return hydration;
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

const prepareTelemetrySessionContextTask = Cadenza.createTask(
  "Prepare telemetry session context",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const deviceId =
      typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";

    if (!deviceId) {
      throw new Error("deviceId is required for telemetry session state");
    }

    if (hydratedTelemetrySessionKeys.has(deviceId)) {
      return {
        ...ctx,
        deviceId,
      };
    }

    return {
      ...ctx,
      deviceId,
      hydratedTelemetrySessionState: await loadDurableTelemetrySessionState(deviceId, inquire),
    };
  },
  "Hydrates durable telemetry session state once per device without blocking on later outages.",
);

const prepareTelemetrySessionReadContextTask = Cadenza.createTask(
  "Prepare telemetry session read context",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const deviceId =
      typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";

    if (!deviceId) {
      throw new Error("deviceId is required for telemetry session state");
    }

    if (hydratedTelemetrySessionKeys.has(deviceId)) {
      return {
        ...ctx,
        deviceId,
      };
    }

    return {
      ...ctx,
      deviceId,
      hydratedTelemetrySessionState: await loadDurableTelemetrySessionState(deviceId, inquire),
    };
  },
  "Hydrates durable telemetry session state for read requests without blocking on later outages.",
);

const recordTelemetryIngestTask = Cadenza.createTask(
  "Record telemetry ingest session state",
  telemetrySessionActor.task(
    ({ actor, input, state, setState }) => {
      const baseState = state.__hydrated
        ? state
        : createTelemetrySessionRuntimeState(
            input.hydratedTelemetrySessionState,
            input.hydratedTelemetrySessionState?.__durableVersion ?? 0,
          );
      const nextValidationCount = baseState.validationCount + 1;
      const nextOutlierCount = baseState.outlierCount + (input.isOutlier ? 1 : 0);
      const nextState = createTelemetrySessionRuntimeState(
        {
          ...baseState,
          lastTelemetry: sanitizeTelemetryPayload(input.telemetryPayload),
          validationCount: nextValidationCount,
          outlierCount: nextOutlierCount,
          lastIngestedAt: input.timestamp,
        },
        baseState.__durableVersion + 1,
      );

      hydratedTelemetrySessionKeys.add(actor.key);
      setState(nextState);

      return {
        ...input,
        telemetrySessionState: nextState,
        validationCount: nextValidationCount,
        outlierCount: nextOutlierCount,
      };
    },
    { mode: "write" },
  ),
  "Updates local telemetry session actor state with current ingest payload counters.",
);

const persistTelemetryIngestSessionBestEffortTask = Cadenza.createTask(
  "Persist telemetry ingest session state best effort",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    if (!ctx.telemetrySessionState || !ctx.deviceId) {
      return ctx;
    }

    const nextState = queueTelemetrySessionFlush(
      ctx.deviceId,
      ctx.telemetrySessionState as TelemetrySessionRuntimeState,
      inquire,
    );

    return {
      ...ctx,
      telemetrySessionState: nextState,
      sessionPersistenceDeferred: nextState.__persistenceDeferred,
      sessionPersistenceReason: nextState.__persistenceDeferred
        ? "telemetry_session_persist_deferred"
        : null,
    };
  },
  "Queues latest telemetry session snapshot for durable persistence without blocking ingest.",
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
    ({ actor, input, state, setState }) => {
      const baseState = state.__hydrated
        ? state
        : createTelemetrySessionRuntimeState(
            input.hydratedTelemetrySessionState,
            input.hydratedTelemetrySessionState?.__durableVersion ?? 0,
          );
      const nextState = createTelemetrySessionRuntimeState(
        {
          ...baseState,
          lastAnomaly: sanitizeAnomalyResult(input.anomalyResult) ?? baseState.lastAnomaly,
          lastPrediction:
            sanitizePredictionResult(input.predictionResult) ?? baseState.lastPrediction,
        },
        baseState.__durableVersion + 1,
      );

      hydratedTelemetrySessionKeys.add(actor.key);
      setState(nextState);

      return {
        ...input,
        telemetrySessionState: nextState,
        lastAnomaly: nextState.lastAnomaly,
        lastPrediction: nextState.lastPrediction,
      };
    },
    { mode: "write" },
  ),
  "Updates local telemetry session actor with latest anomaly/prediction outcomes.",
);

const persistTelemetryAnalysisSessionBestEffortTask = Cadenza.createTask(
  "Persist telemetry analysis session state best effort",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    if (!ctx.telemetrySessionState || !ctx.deviceId) {
      return ctx;
    }

    const nextState = queueTelemetrySessionFlush(
      ctx.deviceId,
      ctx.telemetrySessionState as TelemetrySessionRuntimeState,
      inquire,
    );

    return {
      ...ctx,
      telemetrySessionState: nextState,
      sessionPersistenceDeferred: nextState.__persistenceDeferred,
      sessionPersistenceReason: nextState.__persistenceDeferred
        ? "telemetry_session_persist_deferred"
        : null,
    };
  },
  "Queues latest telemetry analysis snapshot for durable persistence without blocking ingest.",
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

normalizeIngestPayloadTask.then(prepareTelemetrySessionContextTask);
prepareTelemetrySessionContextTask.then(recordTelemetryIngestTask);
recordTelemetryIngestTask.then(persistTelemetryIngestSessionBestEffortTask);
persistTelemetryIngestSessionBestEffortTask.then(prepareTelemetryInsertTask);
prepareTelemetryInsertTask.then(persistTelemetryTask);
persistTelemetryTask.then(emitTelemetryIngestedSignalTask);
emitTelemetryIngestedSignalTask.then(detectAnomalyTask);
detectAnomalyTask.then(computePredictionTask);
computePredictionTask.then(recordTelemetryAnalysisTask);
recordTelemetryAnalysisTask.then(persistTelemetryAnalysisSessionBestEffortTask);
persistTelemetryAnalysisSessionBestEffortTask.then(finalizeTelemetryIngestTask);
normalizeIngestPayloadTask.respondsTo(IOT_INTENTS.telemetryIngest);

const getTelemetrySessionStateTask = Cadenza.createTask(
  "Get telemetry session state",
  telemetrySessionActor.task(
    ({ actor, input, state, setState }) => {
      const nextState = state.__hydrated
        ? state
        : createTelemetrySessionRuntimeState(
            input.hydratedTelemetrySessionState,
            input.hydratedTelemetrySessionState?.__durableVersion ?? 0,
          );

      if (!state.__hydrated) {
        hydratedTelemetrySessionKeys.add(actor.key);
        setState(nextState);
      }

      return {
        __success: true,
        actorKey: actor.key,
        session: stripTelemetrySessionRuntimeState(nextState),
      };
    },
    { mode: "write" },
  ),
  "Returns persisted telemetry actor session state by device key.",
);

prepareTelemetrySessionReadContextTask.then(getTelemetrySessionStateTask);
prepareTelemetrySessionReadContextTask.respondsTo(IOT_INTENTS.telemetrySessionGet);

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
