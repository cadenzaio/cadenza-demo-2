import { beforeEach, describe, expect, it, vi } from "vitest";

const defineNuxtPlugin = vi.fn((plugin) => plugin);
const stateStore = new Map<string, { value: any }>();

vi.mock("nuxt/app", () => ({
  defineNuxtPlugin,
  onNuxtReady: (callback: () => void) => {
    callback();
  },
  useState: (key: string, init: () => unknown) => {
    if (!stateStore.has(key)) {
      stateStore.set(key, { value: init() });
    }
    return stateStore.get(key);
  },
}));

describe("demo frontend runtime plugin", () => {
  beforeEach(() => {
    defineNuxtPlugin.mockClear();
    stateStore.clear();
  });

  it("provides a ready browser runtime with demo telemetry commands", async () => {
    const module = await import("../plugins/cadenza.client");
    const setup = module.default as unknown as () => {
      provide: { cadenzaRuntime: Record<string, any> };
    };

    expect(defineNuxtPlugin).toHaveBeenCalledTimes(1);

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
    expect(runtime.inquire).toEqual(expect.any(Function));
    expect(runtime.commands.ingestTelemetry).toEqual(expect.any(Function));
  });
});
