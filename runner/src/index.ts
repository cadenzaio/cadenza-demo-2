import Cadenza from "@cadenza.io/service";
import { IOT_INTENTS, type TelemetryIngestPayload } from "./contracts.js";

type TrafficRuntimeState = {
  tickCount: number;
  totalEventsEmitted: number;
  lastDelayMs: number;
  lastBurstCount: number;
  trafficMode: "low" | "high";
};

const defaultRuntimeState: TrafficRuntimeState = {
  tickCount: 0,
  totalEventsEmitted: 0,
  lastDelayMs: 1000,
  lastBurstCount: 1,
  trafficMode: "low",
};


const trafficRuntimeActor = Cadenza.createActor<
  { mode: "low" | "high" },
  TrafficRuntimeState
>({
  name: "TrafficRuntimeActor",
  description:
    "Runtime-only scheduler pacing actor for dummy telemetry traffic generation.",
  defaultKey: "runner",
  initState: {
    mode: "low",
  },
  session: {
    persistDurableState: false,
  },
});

const computeTickPlanTask = Cadenza.createTask(
  "Compute traffic tick plan",
  trafficRuntimeActor.task(
    ({ input, runtimeState, setRuntimeState }) => {
      const configuredMode =
        input?.trafficMode === "high" || process.env.TRAFFIC_MODE === "high"
          ? "high"
          : "low";
      const deviceCount = Math.max(parseInt(process.env.DEVICE_COUNT ?? "50", 10), 1);

      const currentRuntime: TrafficRuntimeState = runtimeState ?? {
        ...defaultRuntimeState,
        trafficMode: configuredMode,
      };

      const burstChance = configuredMode === "high" ? 0.45 : 0.2;
      const burstMax = configuredMode === "high" ? 8 : 3;
      const burstCount =
        Math.random() < burstChance ? 1 + Math.floor(Math.random() * burstMax) : 1;

      const minDelay = configuredMode === "high" ? 800 : 3500;
      const maxDelay = configuredMode === "high" ? 8000 : 25000;
      const nextDelayMs = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

      const payloads: TelemetryIngestPayload[] = [];

      for (let i = 0; i < burstCount; i += 1) {
        const deviceId = `device-${Math.floor(Math.random() * deviceCount) + 1}`;
        const baseTemp = 20 + Math.random() * 55;
        const baseHumidity = 25 + Math.random() * 60;
        const anomalyBias = configuredMode === "high" ? 0.25 : 0.08;

        let temperature = baseTemp;
        let humidity = baseHumidity;

        if (Math.random() < anomalyBias) {
          temperature += Math.random() < 0.5 ? 20 : -12;
        }

        if (Math.random() < anomalyBias) {
          humidity += Math.random() < 0.5 ? 25 : -18;
        }

        payloads.push({
          deviceId,
          timestamp: new Date().toISOString(),
          readings: {
            temperature: Number(temperature.toFixed(2)),
            humidity: Number(humidity.toFixed(2)),
            battery: Number((45 + Math.random() * 55).toFixed(2)),
          },
          source: "scheduler",
          trafficMode: configuredMode,
        });
      }

      setRuntimeState({
        tickCount: currentRuntime.tickCount + 1,
        totalEventsEmitted: currentRuntime.totalEventsEmitted + burstCount,
        lastDelayMs: nextDelayMs,
        lastBurstCount: burstCount,
        trafficMode: configuredMode,
      });

      return {
        payloads,
        nextDelayMs,
        burstCount,
        tickCount: currentRuntime.tickCount + 1,
      };
    },
    { mode: "write" },
  ),
  "Builds the next tick ingestion plan from runtime-only scheduler actor state.",
);

const ingestTelemetryBatchTask = Cadenza.createTask(
  "Ingest telemetry batch",
  async (ctx: any, _emit: any, inquire: any) => {
    const payloads: TelemetryIngestPayload[] = Array.isArray(ctx.payloads)
      ? ctx.payloads
      : [];

    if (payloads.length === 0) {
      return {
        ...ctx,
        ingestFailures: 0,
      };
    }

    let ingestFailures = 0;

    for (const payload of payloads) {
      try {
        await inquire(IOT_INTENTS.telemetryIngest, payload, {
          timeout: 12000,
          rejectOnTimeout: true,
          requireComplete: true,
        });
      } catch (error) {
        ingestFailures += 1;
        Cadenza.log(
          "Telemetry ingest inquiry failed.",
          {
            deviceId: payload.deviceId,
            error: String((error as Error)?.message ?? error),
          },
          "error",
        );
      }
    }

    return {
      ...ctx,
      ingestFailures,
    };
  },
  "Invokes canonical telemetry ingest intent for each payload in the current tick.",
);

const scheduleNextTickTask = Cadenza.createTask(
  "Schedule next traffic tick",
  (ctx: any, emit: any) => {
    const nextDelayMs =
      typeof ctx.nextDelayMs === "number" && ctx.nextDelayMs > 0
        ? ctx.nextDelayMs
        : 5000;

    setTimeout(() => {
      Cadenza.emit("runner.tick", {
        trafficMode: process.env.TRAFFIC_MODE === "high" ? "high" : "low",
      });
    }, nextDelayMs);

    emit("runner.tick_scheduled", {
      nextDelayMs,
      tickCount: ctx.tickCount,
      burstCount: ctx.burstCount,
      ingestFailures: ctx.ingestFailures ?? 0,
    });

    Cadenza.log(
      `Runner tick ${ctx.tickCount} completed: burst=${ctx.burstCount}, failures=${ctx.ingestFailures ?? 0}, next=${Math.round(nextDelayMs / 1000)}s`,
    );

    return {
      __success: true,
      tickCount: ctx.tickCount,
      burstCount: ctx.burstCount,
      ingestFailures: ctx.ingestFailures ?? 0,
      nextDelayMs,
    };
  },
  "Schedules the next runner tick and emits local scheduler telemetry.",
).attachSignal("runner.tick_scheduled");

computeTickPlanTask.doOn("runner.tick").then(ingestTelemetryBatchTask).then(
  scheduleNextTickTask,
);

const readTrafficRuntimeTask = Cadenza.createTask(
  "Read traffic runtime state",
  trafficRuntimeActor.task(({ runtimeState }) => runtimeState ?? defaultRuntimeState, {
    mode: "read",
  }),
  "Returns the current runtime-only scheduler pacing state.",
);

readTrafficRuntimeTask.respondsTo("runner-traffic-runtime-get");

Cadenza.createTask(
  "Prime runner loop",
  (_ctx: any, emit: any) => {
    emit("runner.tick", {
      trafficMode: process.env.TRAFFIC_MODE === "high" ? "high" : "low",
    });
    return true;
  },
  "Starts the runner tick loop after service bootstrap.",
)
  .doOn("runner.bootstrap")
  .attachSignal("runner.tick");

Cadenza.createCadenzaService(
  "ScheduledRunnerService",
  "Generates dummy IoT telemetry and drives canonical ingest intent flow.",
  {
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
      port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    },
  },
);

Cadenza.emit("runner.bootstrap", {
  startedAt: new Date().toISOString(),
});

process.on("SIGTERM", () => {
  Cadenza.log("Scheduled Runner shutting down gracefully.");
  process.exit(0);
});
