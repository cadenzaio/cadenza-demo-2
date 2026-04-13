import { beforeEach, describe, expect, it, vi } from "vitest";

const defineNuxtPlugin = vi.fn((setup) => setup);
const fakeCadenza = { label: "fake-cadenza" };
const defineCadenzaNuxtRuntimePlugin = vi.fn((options) => {
  const runtime = {
    actor: { key: "browser-runtime" },
    actorHandle: { key: "browser-runtime-handle" },
    waitUntilReady: vi.fn(async () => {}),
    inquire: vi.fn(async () => ({ ok: true })),
    getRuntimeState: vi.fn(() => ({
      ready: true,
      projectionState: {
        liveFeed: [],
      },
      lastReadyAt: "2026-04-13T00:00:00.000Z",
      lastSyncRequestedAt: null,
    })),
    subscribe: vi.fn(() => () => {}),
  };

  return () => ({
    provide: {
      cadenzaRuntime: {
        ...runtime,
        commands: options.commands({ cadenza: fakeCadenza, runtime }),
      },
    },
  });
});

vi.mock("@cadenza.io/service", () => ({
  default: fakeCadenza,
}));

vi.mock("nuxt/app", () => ({
  defineNuxtPlugin,
}));

vi.mock("@cadenza.io/service/nuxt", () => ({
  defineCadenzaNuxtRuntimePlugin,
}));

describe("demo frontend runtime plugin", () => {
  beforeEach(() => {
    defineNuxtPlugin.mockClear();
    defineCadenzaNuxtRuntimePlugin.mockClear();
  });

  it("uses the official Nuxt browser runtime wrapper with demo bindings", async () => {
    const module = await import("../plugins/cadenza.client");
    const setup = module.default as unknown as () => {
      provide: { cadenzaRuntime: Record<string, any> };
    };

    expect(defineCadenzaNuxtRuntimePlugin).toHaveBeenCalledTimes(1);
    expect(defineNuxtPlugin).toHaveBeenCalledTimes(1);

    const options = defineCadenzaNuxtRuntimePlugin.mock.calls[0][0];
    expect(options.cadenza).toBe(fakeCadenza);
    expect(options.actorName).toBe("BrowserDemoFrontendRuntimeActor");
    expect(options.hydrationStateKey).toBe("demo-cadenza-hydration");
    expect(options.initialProjectionState).toEqual({
      liveFeed: [],
    });
    expect(options.signalBindings).toHaveLength(5);
    expect(options.bootstrapUrl({ public: { cadenzaBootstrapUrl: "http://db.localhost" } })).toBe(
      "http://db.localhost",
    );

    const provided = setup();
    const runtime = provided.provide.cadenzaRuntime;

    expect(runtime.getRuntimeState()).toEqual(
      expect.objectContaining({
        ready: true,
        projectionState: {
          liveFeed: [],
        },
      }),
    );

    await runtime.commands.ingestTelemetry({
      deviceId: "device-1",
      trafficMode: "high",
      readings: {
        temperature: 95,
        humidity: 12,
        battery: 21,
      },
    });

    expect(runtime.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(runtime.inquire).toHaveBeenCalledWith(
      "iot-telemetry-ingest",
      expect.objectContaining({
        deviceId: "device-1",
        trafficMode: "high",
        source: "scheduler",
        triggeredBy: "frontend",
      }),
      expect.objectContaining({
        timeout: 10_000,
        requireComplete: true,
        rejectOnTimeout: true,
      }),
    );
  });
});
