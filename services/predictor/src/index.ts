import Cadenza from "@cadenza.io/service";
import {
  IOT_INTENTS,
  IOT_DB_INTENTS,
  IOT_SIGNALS,
  type PredictionResult,
  type DeviceReadings,
  type AnomalyResult,
} from "./contracts.js";

type PredictionSessionState = {
  lastProbability: number;
  lastPredictedEta: string | null;
  lastRiskFactors: PredictionResult["riskFactors"] | null;
  lastAnomalyScore: number;
  computeCount: number;
  lastComputedAt: string | null;
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

const predictionSessionActor = Cadenza.createActor<PredictionSessionState>({
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
  },
  session: {
    persistDurableState: true,
    persistenceTimeoutMs: 5000,
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
      predictionResult,
    };
  },
  "Computes prediction probability and ETA with fixed weather multiplier logic.",
);

const persistPredictionSessionTask = Cadenza.createTask(
  "Persist prediction session actor state",
  predictionSessionActor.task(
    ({ input, state, setState }) => {
      const nextState: PredictionSessionState = {
        ...state,
        lastProbability: input.predictionResult.failureProbability,
        lastPredictedEta: input.predictionResult.predictedEta,
        lastRiskFactors: input.predictionResult.riskFactors,
        lastAnomalyScore: input.predictionResult.riskFactors.anomalyScore,
        computeCount: state.computeCount + 1,
        lastComputedAt: input.predictionResult.timestamp,
      };

      setState(nextState);

      return nextState;
    },
    { mode: "write" },
  ),
  "Writes latest prediction output to durable prediction session actor state.",
);

const prepareHealthMetricInsertTask = Cadenza.createTask(
  "Prepare health_metric insert payload",
  (ctx: any) => {
    return {
      ...ctx,
      data: {
        device_id: ctx.predictionResult.deviceId,
        timestamp: ctx.predictionResult.timestamp,
        anomaly_score: ctx.predictionResult.riskFactors.anomalyScore,
        failure_probability: ctx.predictionResult.failureProbability,
        predicted_eta: ctx.predictionResult.predictedEta,
      },
    };
  },
  "Maps prediction result to health_metric database table contract.",
);

const persistHealthMetricTask = Cadenza.createTask(
  "Persist health_metric via iot-db intent",
  async (ctx: any, _emit: any, inquire: any) => {
    await inquire(
      IOT_DB_INTENTS.healthMetricInsert,
      { data: ctx.data },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    );

    return ctx;
  },
  "Persists health_metric row through canonical internal iot-db insert intent.",
);

const emitPredictionSignalTask = Cadenza.createTask(
  "Emit canonical prediction signal",
  (ctx: any, emit: any) => {
    const signalName = ctx.predictionResult.maintenanceNeeded
      ? IOT_SIGNALS.predictionMaintenanceNeeded
      : IOT_SIGNALS.predictionReady;

    emit(signalName, {
      ...ctx.predictionResult,
      severity: toSeverity(ctx.predictionResult.failureProbability),
      reason: ctx.predictionResult.maintenanceNeeded
        ? "Failure probability exceeded maintenance threshold"
        : "Prediction computed below maintenance threshold",
    });

    return ctx;
  },
  "Emits canonical prediction-ready or maintenance-needed signal after persistence.",
).attachSignal(IOT_SIGNALS.predictionReady, IOT_SIGNALS.predictionMaintenanceNeeded);

const finalizePredictionResponseTask = Cadenza.createTask(
  "Finalize prediction compute response",
  (ctx: any) => {
    return {
      __success: true,
      ...ctx.predictionResult,
    };
  },
  "Builds canonical iot-prediction-compute response payload.",
);

normalizePredictionInputTask
  .then(fetchWeatherTask)
  .then(computePredictionTask)
  .then(persistPredictionSessionTask)
  .then(prepareHealthMetricInsertTask)
  .then(persistHealthMetricTask)
  .then(emitPredictionSignalTask)
  .then(finalizePredictionResponseTask)
  .respondsTo(IOT_INTENTS.predictionCompute);

Cadenza.createTask(
  "Compute prediction from anomaly signal",
  async (ctx: any, _emit: any, inquire: any) => {
    const result = await inquire(
      IOT_INTENTS.predictionCompute,
      {
        deviceId: ctx.deviceId,
        timestamp: ctx.timestamp,
        readings: ctx.readings,
        anomalyResult: ctx,
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    );

    return {
      __success: true,
      prediction: result,
    };
  },
  "Automatically computes prediction when anomaly-detected canonical signal is observed.",
).doOn(IOT_SIGNALS.anomalyDetected);

Cadenza.createTask(
  "Get prediction session state",
  predictionSessionActor.task(
    ({ actor, state }) => ({
      __success: true,
      actorKey: actor.key,
      session: state,
    }),
    { mode: "read" },
  ),
  "Returns persisted prediction actor session state by device key.",
).respondsTo(IOT_INTENTS.predictionSessionGet);

Cadenza.createCadenzaService(
  "PredictorService",
  "Computes canonical failure predictions and persists health_metric outputs.",
  {
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
      port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    },
  },
);

process.on("SIGTERM", () => {
  Cadenza.log("Predictor Service shutting down gracefully.");
  process.exit(0);
});
