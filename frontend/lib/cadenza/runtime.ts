import type { LiveEvent, SignalName } from "./contracts";
import { IOT_INTENTS, IOT_SIGNALS } from "./contracts";
import { appendLiveEvent, signalPayloadToLiveEvent } from "./live-events";

type MinimalCadenza = {
  inquire: (
    inquiry: string,
    context: Record<string, any>,
    options?: Record<string, any>,
  ) => Promise<any>;
};

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

export type BrowserCadenzaRuntimeState = {
  ready: boolean;
  projectionState: DemoFrontendProjectionState;
  lastReadyAt: string | null;
  lastSyncRequestedAt: string | null;
};

export type BrowserCadenzaRuntime = {
  actor: null;
  actorHandle: null;
  waitUntilReady: () => Promise<void>;
  inquire: (
    inquiry: string,
    context?: Record<string, any>,
    options?: Record<string, any>,
  ) => Promise<any>;
  getRuntimeState: () => BrowserCadenzaRuntimeState;
  subscribe: (
    listener: (state: BrowserCadenzaRuntimeState) => void,
  ) => () => void;
  commands: DemoFrontendCommands;
};

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
  cadenza: MinimalCadenza,
  runtime: {
    waitUntilReady: () => Promise<void>;
  },
): DemoFrontendCommands {
  return {
    ingestTelemetry: async (payload) => {
      await runtime.waitUntilReady();
      return cadenza.inquire(
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
