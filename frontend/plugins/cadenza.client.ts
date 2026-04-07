import { defineNuxtPlugin, useState } from "nuxt/app";
import {
  type BrowserCadenzaRuntime,
  type BrowserCadenzaRuntimeState,
  createDemoFrontendCommands,
} from "../lib/cadenza/runtime";

const RUNTIME_READY_KEY = "demo-cadenza-runtime-ready";
const RUNTIME_STATE_KEY = "demo-cadenza-runtime-state";

function createDefaultRuntimeState(): BrowserCadenzaRuntimeState {
  return {
    ready: false,
    projectionState: {
      liveFeed: [],
    },
    lastReadyAt: null,
    lastSyncRequestedAt: null,
  };
}

export default defineNuxtPlugin(() => {
  const readyState = useState<boolean>(RUNTIME_READY_KEY, () => false);
  const runtimeState = useState<BrowserCadenzaRuntimeState>(
    RUNTIME_STATE_KEY,
    createDefaultRuntimeState,
  );

  const listeners = new Set<(state: BrowserCadenzaRuntimeState) => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener(runtimeState.value);
    }
  };

  const inquire: BrowserCadenzaRuntime["inquire"] = async (
    inquiry,
    context = {},
    options = {},
  ) =>
    $fetch("/api/cadenza/inquire", {
      method: "POST",
      body: {
        inquiry,
        context,
        options,
      },
    });

  const waitUntilReady = async () => {
    if (readyState.value) {
      return;
    }
    readyState.value = true;
    runtimeState.value = {
      ...runtimeState.value,
      ready: true,
      lastReadyAt: new Date().toISOString(),
    };
    notify();
  };

  const runtime: BrowserCadenzaRuntime = {
    actor: null,
    actorHandle: null,
    waitUntilReady,
    inquire,
    getRuntimeState: () => runtimeState.value,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(runtimeState.value);
      return () => {
        listeners.delete(listener);
      };
    },
    commands: {} as BrowserCadenzaRuntime["commands"],
  };

  runtime.commands = createDemoFrontendCommands({ inquire }, runtime);

  readyState.value = true;
  runtimeState.value = {
    ...runtimeState.value,
    ready: true,
    lastReadyAt: new Date().toISOString(),
  };
  notify();

  return {
    provide: {
      cadenzaRuntime: runtime,
    },
  };
});
