import type {
  CadenzaNuxtRuntime,
  CadenzaNuxtRuntimeState,
} from "@cadenza.io/service/nuxt";
import type { LiveEvent, SignalName } from "./contracts";
import { IOT_INTENTS, IOT_SIGNALS } from "./contracts";
import { appendLiveEvent, signalPayloadToLiveEvent } from "./live-events";

export type DemoFrontendProjectionState = {
  liveFeed: LiveEvent[];
};

export type DemoFrontendCommands = {
  ingestTelemetry: (payload: {
    deviceId: string;
    trafficMode: "low" | "high";
    readings: {
      temperature: number;
      humidity: number;
      battery: number;
    };
  }) => Promise<any>;
};

export type DemoFrontendRuntimeState =
  CadenzaNuxtRuntimeState<DemoFrontendProjectionState>;

export type DemoFrontendRuntime = CadenzaNuxtRuntime<
  DemoFrontendProjectionState,
  DemoFrontendCommands
>;

export function createLiveFeedProjection(signalName: SignalName) {
  return {
    signal: signalName,
    reduce: (
      current: DemoFrontendProjectionState,
      payload: Record<string, any>,
    ): DemoFrontendProjectionState => {
      const event = signalPayloadToLiveEvent(signalName, payload);
      if (!event) {
        return current;
      }

      return {
        ...current,
        liveFeed: appendLiveEvent(current.liveFeed, event),
      };
    },
  };
}

export function createDemoFrontendSignalBindings() {
  return [
    createLiveFeedProjection(IOT_SIGNALS.telemetryIngested),
    createLiveFeedProjection(IOT_SIGNALS.anomalyDetected),
    createLiveFeedProjection(IOT_SIGNALS.predictionReady),
    createLiveFeedProjection(IOT_SIGNALS.predictionMaintenanceNeeded),
    createLiveFeedProjection(IOT_SIGNALS.alertRaised),
  ];
}

export function createDemoFrontendCommands(
  runtime: Pick<
    DemoFrontendRuntime,
    "waitUntilReady" | "inquire"
  >,
): DemoFrontendCommands {
  return {
    ingestTelemetry: async (payload) => {
      await runtime.waitUntilReady();
      return runtime.inquire(
        IOT_INTENTS.telemetryIngest,
        {
          deviceId: payload.deviceId,
          timestamp: new Date().toISOString(),
          readings: payload.readings,
          trafficMode: payload.trafficMode,
          source: "scheduler",
          triggeredBy: "frontend",
        },
        {
          timeout: 10_000,
          requireComplete: true,
          rejectOnTimeout: true,
        },
      );
    },
  };
}
