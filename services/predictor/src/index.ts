import Cadenza from "@cadenza.io/service";
import { randomUUID } from "node:crypto";
import {
  IOT_DB_INTENTS,
  IOT_INTENTS,
  IOT_SIGNALS,
  type PredictionResult,
  type DeviceReadings,
  type AnomalyResult,
} from "./contracts.js";

const publicOrigin =
  process.env.PUBLIC_ORIGIN ?? "http://predictor.localhost";
const internalOrigin = `http://${process.env.CADENZA_SERVER_URL ?? "predictor"}:${
  process.env.HTTP_PORT ?? "3005"
}`;
const META_ACTOR_SESSION_STATE_HYDRATE_INTENT = "meta-actor-session-state-hydrate";
const META_ACTOR_SESSION_STATE_PERSIST_INTENT = "meta-actor-session-state-persist";
const PREDICTION_SESSION_PERSIST_TIMEOUT_MS = 10_000;
const PREDICTION_SESSION_FLUSH_DEBOUNCE_MS = 2_000;
const PREDICTION_SESSION_RETRY_BASE_MS = 1_000;
const PREDICTION_SESSION_RETRY_MAX_MS = 30_000;
const PREDICTION_SESSION_ACTOR_NAME = "PredictionSessionActor";
const PREDICTION_SESSION_ACTOR_VERSION = 1;

type PredictionSessionState = {
  lastProbability: number;
  lastPredictedEta: string | null;
  lastRiskFactors: PredictionResult["riskFactors"] | null;
  lastAnomalyScore: number;
  computeCount: number;
  lastComputedAt: string | null;
};

type PredictionSessionRuntimeState = PredictionSessionState & {
  __hydrated: boolean;
  __durableVersion: number;
  __persistenceDeferred: boolean;
  __lastPersistenceError: string | null;
};

type PendingPredictionSessionFlush = {
  deviceId: string;
  durableState: PredictionSessionState;
  durableVersion: number;
  retryDelayMs: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type WeatherData = {
  temperature: number;
  humidity: number;
  condition: string;
};

type WeatherRuntimeState = {
  weatherData: WeatherData | null;
  fetchedAt: string | null;
  cacheHits: number;
  cacheMisses: number;
};

type CadenzaInquiry = (
  inquiryName: string,
  context: Record<string, unknown>,
  options: any,
) => Promise<any>;

const hydratedPredictionSessionKeys = new Set<string>();
const pendingPredictionSessionHydrations = new Map<
  string,
  Promise<PredictionSessionRuntimeState>
>();
const pendingPredictionSessionFlushes = new Map<
  string,
  PendingPredictionSessionFlush
>();
let latestPredictionSessionInquire: CadenzaInquiry | null = null;

const predictionSessionActor = Cadenza.createActor<PredictionSessionRuntimeState>({
  name: "PredictionSessionActor",
  description:
    "Per-device durable prediction session state for latest risk and ETA outputs.",
  defaultKey: "device:unknown",
  keyResolver: (input: any) =>
    typeof input?.deviceId === "string" ? input.deviceId : undefined,
  initState: {
    lastProbability: 0,
    lastPredictedEta: null,
    lastRiskFactors: null,
    lastAnomalyScore: 0,
    computeCount: 0,
    lastComputedAt: null,
    __hydrated: false,
    __durableVersion: 0,
    __persistenceDeferred: false,
    __lastPersistenceError: null,
  },
  session: {
    persistDurableState: false,
  },
});

const weatherRuntimeActor = Cadenza.createActor<
  { provider: string },
  WeatherRuntimeState
>({
  name: "WeatherRuntimeActor",
  description:
    "Runtime-only weather cache and API client state used by prediction computations.",
  defaultKey: "device:unknown",
  keyResolver: (input: any) =>
    typeof input?.deviceId === "string" ? input.deviceId : undefined,
  initState: {
    provider: "openweathermap",
  },
  session: {
    persistDurableState: false,
  },
});

function buildDefaultPredictionSessionState(): PredictionSessionState {
  return {
    lastProbability: 0,
    lastPredictedEta: null,
    lastRiskFactors: null,
    lastAnomalyScore: 0,
    computeCount: 0,
    lastComputedAt: null,
  };
}

function createPredictionSessionRuntimeState(
  state: Partial<PredictionSessionState> | null | undefined,
  durableVersion = 0,
  options: Partial<
    Pick<
      PredictionSessionRuntimeState,
      "__hydrated" | "__persistenceDeferred" | "__lastPersistenceError"
    >
  > = {},
): PredictionSessionRuntimeState {
  const base = buildDefaultPredictionSessionState();

  return {
    ...base,
    ...(state ?? {}),
    lastProbability: Number(state?.lastProbability ?? base.lastProbability),
    lastPredictedEta:
      typeof state?.lastPredictedEta === "string" ? state.lastPredictedEta : null,
    lastRiskFactors:
      state?.lastRiskFactors && typeof state.lastRiskFactors === "object"
        ? (state.lastRiskFactors as PredictionResult["riskFactors"])
        : null,
    lastAnomalyScore: Number(state?.lastAnomalyScore ?? base.lastAnomalyScore),
    computeCount: Number(state?.computeCount ?? base.computeCount),
    lastComputedAt:
      typeof state?.lastComputedAt === "string" ? state.lastComputedAt : null,
    __hydrated: options.__hydrated ?? true,
    __durableVersion: Math.max(0, Number(durableVersion) || 0),
    __persistenceDeferred: options.__persistenceDeferred ?? false,
    __lastPersistenceError: options.__lastPersistenceError ?? null,
  };
}

function stripPredictionSessionRuntimeState(
  state: Partial<PredictionSessionRuntimeState> | null | undefined,
): PredictionSessionState {
  const runtime = createPredictionSessionRuntimeState(
    state ?? null,
    state?.__durableVersion ?? 0,
  );

  return {
    lastProbability: runtime.lastProbability,
    lastPredictedEta: runtime.lastPredictedEta,
    lastRiskFactors: runtime.lastRiskFactors,
    lastAnomalyScore: runtime.lastAnomalyScore,
    computeCount: runtime.computeCount,
    lastComputedAt: runtime.lastComputedAt,
  };
}

function shouldTreatPredictionSessionAsHydrated(
  state: Partial<PredictionSessionRuntimeState> | null | undefined,
): boolean {
  return state?.__hydrated === true;
}

function describeInquiryError(error: unknown): string[] {
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
  return values.length > 0 ? values : [String(error)];
}

function isManagedPredictionSessionPersistenceRecoveryError(error: unknown): boolean {
  const values = describeInquiryError(error).join(" | ");

  return (
    values.includes("No routeable internal transport available") ||
    values.includes("Waiting for authority route updates before retrying") ||
    values.includes("ECONNREFUSED") ||
    values.includes("ENOTFOUND") ||
    values.includes("timed out") ||
    values.includes("failed, reason:")
  );
}

function schedulePredictionSessionFlush(
  pending: PendingPredictionSessionFlush,
  delayMs: number,
): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    pending.timer = null;
    void flushPredictionSession(pending.deviceId);
  }, delayMs);
  pending.timer.unref?.();
}

async function flushPredictionSession(deviceId: string): Promise<void> {
  const pending = pendingPredictionSessionFlushes.get(deviceId);
  if (!pending || pending.inFlight) {
    return;
  }

  const inquire = latestPredictionSessionInquire;
  if (!inquire) {
    schedulePredictionSessionFlush(pending, pending.retryDelayMs);
    return;
  }

  const snapshotVersion = pending.durableVersion;
  const snapshotState = pending.durableState;
  pending.inFlight = true;

  try {
    const result = await inquire(
      META_ACTOR_SESSION_STATE_PERSIST_INTENT,
      {
        actor_name: PREDICTION_SESSION_ACTOR_NAME,
        actor_key: deviceId,
        actor_version: PREDICTION_SESSION_ACTOR_VERSION,
        durable_state: snapshotState,
        durable_version: snapshotVersion,
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: PREDICTION_SESSION_PERSIST_TIMEOUT_MS,
      },
    );

    if (
      result &&
      typeof result === "object" &&
      (result.errored === true || result.failed === true || result.__success === false)
    ) {
      throw result;
    }

    const current = pendingPredictionSessionFlushes.get(deviceId);
    if (!current) {
      return;
    }

    current.inFlight = false;
    current.retryDelayMs = PREDICTION_SESSION_RETRY_BASE_MS;

    if (current.durableVersion <= snapshotVersion) {
      pendingPredictionSessionFlushes.delete(deviceId);
      return;
    }

    schedulePredictionSessionFlush(current, PREDICTION_SESSION_FLUSH_DEBOUNCE_MS);
  } catch (error) {
    const current = pendingPredictionSessionFlushes.get(deviceId);
    if (!current) {
      return;
    }

    current.inFlight = false;
    current.retryDelayMs = Math.min(
      Math.max(current.retryDelayMs, PREDICTION_SESSION_RETRY_BASE_MS) * 2,
      PREDICTION_SESSION_RETRY_MAX_MS,
    );

    if (!isManagedPredictionSessionPersistenceRecoveryError(error)) {
      current.retryDelayMs = PREDICTION_SESSION_RETRY_MAX_MS;
    }

    schedulePredictionSessionFlush(current, current.retryDelayMs);
  }
}

function queuePredictionSessionFlush(
  deviceId: string,
  state: PredictionSessionRuntimeState,
  inquire: CadenzaInquiry,
): PredictionSessionRuntimeState {
  latestPredictionSessionInquire = inquire;

  const durableState = stripPredictionSessionRuntimeState(state);
  const durableVersion = state.__durableVersion;
  const existing = pendingPredictionSessionFlushes.get(deviceId);

  if (existing) {
    existing.durableState = durableState;
    existing.durableVersion = durableVersion;

    if (!existing.inFlight) {
      existing.retryDelayMs = PREDICTION_SESSION_RETRY_BASE_MS;
      schedulePredictionSessionFlush(existing, PREDICTION_SESSION_FLUSH_DEBOUNCE_MS);
    }
  } else {
    const pending: PendingPredictionSessionFlush = {
      deviceId,
      durableState,
      durableVersion,
      retryDelayMs: PREDICTION_SESSION_RETRY_BASE_MS,
      inFlight: false,
      timer: null,
    };
    pendingPredictionSessionFlushes.set(deviceId, pending);
    schedulePredictionSessionFlush(pending, PREDICTION_SESSION_FLUSH_DEBOUNCE_MS);
  }

  return {
    ...state,
    __persistenceDeferred: true,
    __lastPersistenceError: null,
  };
}

async function loadDurablePredictionSessionState(
  deviceId: string,
  inquire: CadenzaInquiry,
): Promise<PredictionSessionRuntimeState> {
  if (hydratedPredictionSessionKeys.has(deviceId)) {
    return createPredictionSessionRuntimeState(undefined, 0, { __hydrated: false });
  }

  const existing = pendingPredictionSessionHydrations.get(deviceId);
  if (existing) {
    return existing;
  }

  const hydration = (async () => {
    try {
      const result = await inquire(
        META_ACTOR_SESSION_STATE_HYDRATE_INTENT,
        {
          actor_name: PREDICTION_SESSION_ACTOR_NAME,
          actor_key: deviceId,
          actor_version: PREDICTION_SESSION_ACTOR_VERSION,
        },
        {
          requireComplete: true,
          rejectOnTimeout: true,
          timeout: PREDICTION_SESSION_PERSIST_TIMEOUT_MS,
        },
      );

      if (
        result &&
        typeof result === "object" &&
        result.__success === true &&
        result.hydrated === true
      ) {
        return createPredictionSessionRuntimeState(
          result.durable_state as Partial<PredictionSessionState>,
          Number(result.durable_version ?? 0),
        );
      }
    } catch (error) {
      return createPredictionSessionRuntimeState(undefined, 0, {
        __persistenceDeferred: true,
        __lastPersistenceError: describeInquiryError(error)[0] ?? null,
      });
    } finally {
      pendingPredictionSessionHydrations.delete(deviceId);
    }

    return createPredictionSessionRuntimeState(undefined, 0);
  })();

  pendingPredictionSessionHydrations.set(deviceId, hydration);
  return hydration;
}

function clamp(value: number, min = 0, max = 1): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toSeverity(probability: number): "low" | "medium" | "high" {
  if (probability >= 0.8) return "high";
  if (probability >= 0.5) return "medium";
  return "low";
}

const normalizePredictionInputTask = Cadenza.createTask(
  "Normalize prediction compute input",
  (ctx: any) => {
    const deviceId = typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";
    const timestamp =
      typeof ctx.timestamp === "string" && ctx.timestamp.length > 0
        ? ctx.timestamp
        : new Date().toISOString();

    if (!deviceId) {
      throw new Error("deviceId is required for iot-prediction-compute");
    }

    const readings = ctx.readings ?? {};
    const normalizedReadings: DeviceReadings = {
      temperature: Number(readings.temperature ?? 0),
      humidity: Number(readings.humidity ?? 0),
      battery: Number(readings.battery ?? 100),
    };

    const anomalyResult = (ctx.anomalyResult ?? {
      anomalyDetected: false,
      anomalyScore: 0,
    }) as Partial<AnomalyResult>;

    const anomalyScore = clamp(Number(anomalyResult.anomalyScore ?? 0));

    return {
      ...ctx,
      deviceId,
      timestamp,
      readings: normalizedReadings,
      anomalyScore,
      anomalyDetected: Boolean(anomalyResult.anomalyDetected),
    };
  },
  "Normalizes canonical prediction input and safeguards optional anomaly context.",
);

const preparePredictionSessionContextTask = Cadenza.createTask(
  "Prepare prediction session context",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const deviceId = typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";

    if (!deviceId) {
      throw new Error("deviceId is required for prediction session state");
    }

    if (hydratedPredictionSessionKeys.has(deviceId)) {
      return {
        ...ctx,
        deviceId,
      };
    }

    return {
      ...ctx,
      deviceId,
      hydratedPredictionSessionState: await loadDurablePredictionSessionState(
        deviceId,
        inquire,
      ),
    };
  },
  "Hydrates durable prediction session state once per device without blocking later outages.",
);

const preparePredictionSessionReadContextTask = Cadenza.createTask(
  "Prepare prediction session read context",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const deviceId = typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";

    if (!deviceId) {
      throw new Error("deviceId is required for prediction session state");
    }

    if (hydratedPredictionSessionKeys.has(deviceId)) {
      return {
        ...ctx,
        deviceId,
      };
    }

    return {
      ...ctx,
      deviceId,
      hydratedPredictionSessionState: await loadDurablePredictionSessionState(
        deviceId,
        inquire,
      ),
    };
  },
  "Hydrates durable prediction session state for read requests without blocking later outages.",
);

const fetchWeatherTask = Cadenza.createTask(
  "Fetch weather context",
  weatherRuntimeActor.task(
    async ({ input, runtimeState, setRuntimeState }) => {
      const now = Date.now();
      const cacheTtlMs = 5 * 60 * 1000;
      const state: WeatherRuntimeState = runtimeState ?? {
        weatherData: null,
        fetchedAt: null,
        cacheHits: 0,
        cacheMisses: 0,
      };

      const fetchedAtMs = state.fetchedAt ? Date.parse(state.fetchedAt) : 0;
      const cacheValid =
        state.weatherData !== null &&
        Number.isFinite(fetchedAtMs) &&
        now - fetchedAtMs <= cacheTtlMs;

      if (cacheValid) {
        setRuntimeState({
          ...state,
          cacheHits: state.cacheHits + 1,
        });

        return {
          ...input,
          weatherData: state.weatherData,
          weatherCacheHit: true,
        };
      }

      const fallbackWeather: WeatherData = {
        temperature: 20,
        humidity: 50,
        condition: "neutral",
      };

      let weatherData = fallbackWeather;

      const apiKey = process.env.WEATHER_API_KEY;
      if (apiKey) {
        const lat = 37.7749 + (Math.random() - 0.5) * 1.5;
        const lon = -122.4194 + (Math.random() - 0.5) * 1.5;

        try {
          const response = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`,
          );

          if (response.ok) {
            const data = (await response.json()) as any;
            weatherData = {
              temperature: Number(data?.main?.temp ?? fallbackWeather.temperature),
              humidity: Number(data?.main?.humidity ?? fallbackWeather.humidity),
              condition: String(data?.weather?.[0]?.main ?? fallbackWeather.condition).toLowerCase(),
            };
          }
        } catch (error) {
          Cadenza.log(
            "Weather API request failed; using fallback weather.",
            {
              deviceId: input.deviceId,
              error: String((error as Error)?.message ?? error),
            },
            "warning",
          );
        }
      }

      setRuntimeState({
        weatherData,
        fetchedAt: new Date(now).toISOString(),
        cacheHits: state.cacheHits,
        cacheMisses: state.cacheMisses + 1,
      });

      return {
        ...input,
        weatherData,
        weatherCacheHit: false,
      };
    },
    { mode: "write" },
  ),
  "Resolves weather context via runtime cache and optional OpenWeatherMap API.",
);

const computePredictionTask = Cadenza.createTask(
  "Compute failure prediction",
  (ctx: any) => {
    const weatherData: WeatherData = ctx.weatherData ?? {
      temperature: 20,
      humidity: 50,
      condition: "neutral",
    };

    const weatherMultiplier =
      weatherData.condition === "rain" || weatherData.condition === "thunderstorm"
        ? 1.4
        : 1.0;

    const batteryRisk = clamp((20 - ctx.readings.battery) / 20);
    const temperatureRisk = clamp(Math.abs(ctx.readings.temperature - 45) / 50);
    const humidityRisk = clamp(Math.abs(ctx.readings.humidity - 55) / 50);

    const weightedBaseRisk = clamp(
      ctx.anomalyScore * 0.7 + temperatureRisk * 0.15 + humidityRisk * 0.1 + batteryRisk * 0.05,
    );

    const failureProbability = clamp(weightedBaseRisk * weatherMultiplier);
    const maintenanceNeeded = failureProbability >= 0.72;

    const etaHours = maintenanceNeeded
      ? Math.max(6, Math.round(48 * (1 - failureProbability)))
      : Math.max(24, Math.round(240 * (1 - failureProbability)));

    const predictedEta = new Date(Date.now() + etaHours * 60 * 60 * 1000).toISOString();

    const predictionResult: PredictionResult = {
      deviceId: ctx.deviceId,
      timestamp: ctx.timestamp,
      failureProbability: Number(failureProbability.toFixed(4)),
      maintenanceNeeded,
      predictedEta,
      riskFactors: {
        anomalyScore: Number(ctx.anomalyScore.toFixed(4)),
        weatherCondition: weatherData.condition,
        weatherMultiplier,
      },
    };

    return {
      ...ctx,
      deviceId: predictionResult.deviceId,
      timestamp: predictionResult.timestamp,
      anomalyScore: predictionResult.riskFactors.anomalyScore,
      failureProbability: predictionResult.failureProbability,
      maintenanceNeeded: predictionResult.maintenanceNeeded,
      predictedEta: predictionResult.predictedEta,
      weatherCondition: predictionResult.riskFactors.weatherCondition,
      weatherMultiplier: predictionResult.riskFactors.weatherMultiplier,
      riskFactors: predictionResult.riskFactors,
      predictionResult,
    };
  },
  "Computes prediction probability and ETA with fixed weather multiplier logic.",
);

const persistPredictionSessionTask = Cadenza.createTask(
  "Persist prediction session actor state",
  predictionSessionActor.task(
    ({ actor, input, state, setState }) => {
      const baseState = state.__hydrated
        ? state
        : createPredictionSessionRuntimeState(
            input.hydratedPredictionSessionState,
            input.hydratedPredictionSessionState?.__durableVersion ?? 0,
          );
      const prediction =
        input.predictionResult ??
        (input.deviceId
          ? {
              deviceId: input.deviceId,
              timestamp: input.timestamp,
              failureProbability: input.failureProbability,
              maintenanceNeeded: input.maintenanceNeeded,
              predictedEta: input.predictedEta,
              riskFactors:
                input.riskFactors ??
                (input.anomalyScore !== undefined
                  ? {
                      anomalyScore: input.anomalyScore,
                      weatherCondition: input.weatherCondition ?? "neutral",
                      weatherMultiplier: input.weatherMultiplier ?? 1,
                    }
                  : undefined),
            }
          : undefined);

      if (!prediction) {
        throw new Error("prediction result is required for session persistence");
      }

      const nextState = createPredictionSessionRuntimeState(
        {
          ...baseState,
          lastProbability: prediction.failureProbability,
          lastPredictedEta: prediction.predictedEta,
          lastRiskFactors: prediction.riskFactors,
          lastAnomalyScore: prediction.riskFactors.anomalyScore,
          computeCount: baseState.computeCount + 1,
          lastComputedAt: prediction.timestamp,
        },
        baseState.__durableVersion + 1,
      );

      hydratedPredictionSessionKeys.add(actor.key);
      setState(nextState);

      return {
        ...input,
        anomalyScore: prediction.riskFactors.anomalyScore,
        failureProbability: prediction.failureProbability,
        maintenanceNeeded: prediction.maintenanceNeeded,
        predictedEta: prediction.predictedEta,
        weatherCondition: prediction.riskFactors.weatherCondition,
        weatherMultiplier: prediction.riskFactors.weatherMultiplier,
        predictionResult: prediction,
        predictionSession: nextState,
      };
    },
    { mode: "write" },
  ),
  "Updates local prediction session actor state with the latest computed output.",
);

const persistPredictionSessionBestEffortTask = Cadenza.createTask(
  "Persist prediction session state best effort",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    if (!ctx.predictionSession || !ctx.deviceId) {
      return ctx;
    }

    const nextState = queuePredictionSessionFlush(
      ctx.deviceId,
      ctx.predictionSession as PredictionSessionRuntimeState,
      inquire,
    );

    return {
      ...ctx,
      predictionSession: nextState,
      sessionPersistenceDeferred: nextState.__persistenceDeferred,
      sessionPersistenceReason: nextState.__persistenceDeferred
        ? "prediction_session_persist_deferred"
        : null,
    };
  },
  "Queues the latest prediction session snapshot for durable persistence without blocking compute.",
);

const prepareHealthMetricInsertTask = Cadenza.createTask(
  "Prepare health_metric insert payload",
  (ctx: any) => {
    const prediction =
      ctx.predictionResult ??
      (ctx.deviceId
        ? {
            deviceId: ctx.deviceId,
            timestamp: ctx.timestamp,
            failureProbability: ctx.failureProbability,
            maintenanceNeeded: ctx.maintenanceNeeded,
            predictedEta: ctx.predictedEta,
            riskFactors:
              ctx.riskFactors ??
              (ctx.anomalyScore !== undefined
                ? {
                    anomalyScore: ctx.anomalyScore,
                    weatherCondition: ctx.weatherCondition ?? "neutral",
                    weatherMultiplier: ctx.weatherMultiplier ?? 1,
                  }
                : undefined),
          }
        : undefined);

    if (!prediction) {
      throw new Error("prediction result is required for health_metric persistence");
    }

    const insertData = {
      uuid: randomUUID(),
      device_id: prediction.deviceId,
      timestamp: prediction.timestamp,
      anomaly_score: prediction.riskFactors?.anomalyScore ?? ctx.anomalyScore ?? 0,
      failure_probability: prediction.failureProbability,
      predicted_eta: prediction.predictedEta,
    };

    return {
      ...ctx,
      predictionResult: prediction,
      data: insertData,
      queryData: {
        ...(ctx.queryData ?? {}),
        data: insertData,
      },
    };
  },
  "Maps prediction result to health_metric database table contract.",
);

const persistHealthMetricTask = Cadenza.createTask(
  "Persist health_metric via IoT DB intent",
  async (ctx: any, _emit: any, inquire: any) => {
    const payload =
      ctx.queryData ??
      (ctx.data ? { data: ctx.data } : undefined) ??
      ((ctx.predictionResult ?? ctx.deviceId)
        ? {
            data: {
              uuid: randomUUID(),
              device_id: ctx.predictionResult?.deviceId ?? ctx.deviceId,
              timestamp: ctx.predictionResult?.timestamp ?? ctx.timestamp,
              anomaly_score:
                ctx.predictionResult?.riskFactors?.anomalyScore ??
                ctx.riskFactors?.anomalyScore ??
                ctx.anomalyScore ??
                0,
              failure_probability:
                ctx.predictionResult?.failureProbability ??
                ctx.failureProbability ??
                0,
              predicted_eta: ctx.predictionResult?.predictedEta ?? ctx.predictedEta,
            },
          }
        : undefined);
    const result = await inquire(IOT_DB_INTENTS.healthMetricInsert, payload, {
      requireComplete: true,
      rejectOnTimeout: true,
      timeout: 10000,
    });

    return {
      ...ctx,
      ...(typeof result === "object" && result ? result : {}),
    };
  },
  "Persists health_metric rows through the generated IoT DB insert intent.",
);

const emitPredictionSignalTask = Cadenza.createTask(
  "Emit canonical prediction signal",
  (ctx: any, emit: any) => {
    const prediction =
      ctx.predictionResult ??
      (ctx.deviceId
        ? {
            deviceId: ctx.deviceId,
            timestamp: ctx.timestamp,
            failureProbability: ctx.failureProbability,
            maintenanceNeeded: ctx.maintenanceNeeded,
            predictedEta: ctx.predictedEta,
            riskFactors:
              ctx.riskFactors ??
              (ctx.anomalyScore !== undefined
                ? {
                    anomalyScore: ctx.anomalyScore,
                    weatherCondition: ctx.weatherCondition ?? "neutral",
                    weatherMultiplier: ctx.weatherMultiplier ?? 1,
                  }
                : undefined),
          }
        : undefined);

    if (!prediction) {
      throw new Error("prediction result is required for signal emission");
    }

    const signalName = prediction.maintenanceNeeded
      ? IOT_SIGNALS.predictionMaintenanceNeeded
      : IOT_SIGNALS.predictionReady;

    emit(signalName, {
      ...prediction,
      severity: toSeverity(prediction.failureProbability),
      reason: prediction.maintenanceNeeded
        ? "Failure probability exceeded maintenance threshold"
        : "Prediction computed below maintenance threshold",
    });

    return {
      ...ctx,
      anomalyScore: prediction.riskFactors.anomalyScore,
      failureProbability: prediction.failureProbability,
      maintenanceNeeded: prediction.maintenanceNeeded,
      predictedEta: prediction.predictedEta,
      weatherCondition: prediction.riskFactors.weatherCondition,
      weatherMultiplier: prediction.riskFactors.weatherMultiplier,
      predictionResult: prediction,
    };
  },
  "Emits canonical prediction-ready or maintenance-needed signal after persistence.",
).attachSignal(IOT_SIGNALS.predictionReady, IOT_SIGNALS.predictionMaintenanceNeeded);

const finalizePredictionResponseTask = Cadenza.createTask(
  "Finalize prediction compute response",
  (ctx: any) => {
    const prediction =
      ctx.predictionResult ??
      (ctx.deviceId
        ? {
            deviceId: ctx.deviceId,
            timestamp: ctx.timestamp,
            failureProbability: ctx.failureProbability,
            maintenanceNeeded: ctx.maintenanceNeeded,
            predictedEta: ctx.predictedEta,
            riskFactors:
              ctx.riskFactors ??
              (ctx.anomalyScore !== undefined
                ? {
                    anomalyScore: ctx.anomalyScore,
                    weatherCondition: ctx.weatherCondition ?? "neutral",
                    weatherMultiplier: ctx.weatherMultiplier ?? 1,
                  }
                : undefined),
          }
        : undefined);

    if (!prediction) {
      throw new Error("prediction result is required for finalize response");
    }

    return {
      __success: true,
      ...prediction,
    };
  },
  "Builds canonical iot-prediction-compute response payload.",
);

normalizePredictionInputTask.then(fetchWeatherTask);
fetchWeatherTask.then(computePredictionTask);
computePredictionTask.then(preparePredictionSessionContextTask);
preparePredictionSessionContextTask.then(persistPredictionSessionTask);
persistPredictionSessionTask.then(persistPredictionSessionBestEffortTask);
persistPredictionSessionBestEffortTask.then(prepareHealthMetricInsertTask);
prepareHealthMetricInsertTask.then(persistHealthMetricTask);
persistHealthMetricTask.then(emitPredictionSignalTask);
emitPredictionSignalTask.then(finalizePredictionResponseTask);
normalizePredictionInputTask.respondsTo(IOT_INTENTS.predictionCompute);

const getPredictionSessionStateTask = Cadenza.createTask(
  "Get prediction session state",
  predictionSessionActor.task(
    ({ actor, input, state, setState }) => {
      const nextState = state.__hydrated
        ? state
        : createPredictionSessionRuntimeState(
            input.hydratedPredictionSessionState,
            input.hydratedPredictionSessionState?.__durableVersion ?? 0,
          );

      if (!state.__hydrated && shouldTreatPredictionSessionAsHydrated(nextState)) {
        hydratedPredictionSessionKeys.add(actor.key);
        setState(nextState);
      }

      return {
        __success: true,
        actorKey: actor.key,
        session: stripPredictionSessionRuntimeState(nextState),
      };
    },
    { mode: "write" },
  ),
  "Returns persisted prediction actor session state by device key.",
);

preparePredictionSessionReadContextTask.then(
  getPredictionSessionStateTask,
);
preparePredictionSessionReadContextTask.respondsTo(IOT_INTENTS.predictionSessionGet);

Cadenza.createCadenzaService(
  "PredictorService",
  "Computes canonical failure predictions and persists health_metric outputs.",
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
