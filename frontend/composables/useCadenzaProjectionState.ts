import type { BrowserCadenzaRuntimeState, DemoFrontendProjectionState } from "../lib/cadenza/runtime";

export function useCadenzaProjectionState() {
  return useState<BrowserCadenzaRuntimeState>("demo-cadenza-runtime-state", () => ({
    ready: false,
    projectionState: {
      liveFeed: [],
    } as DemoFrontendProjectionState,
    lastReadyAt: null,
    lastSyncRequestedAt: null,
  }));
}
