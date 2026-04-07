import type { BrowserCadenzaRuntime } from "../lib/cadenza/runtime";

export function useCadenzaRuntime() {
  return useNuxtApp().$cadenzaRuntime as BrowserCadenzaRuntime;
}
