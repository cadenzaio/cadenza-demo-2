import {
  useCadenzaRuntime as useNuxtCadenzaRuntime,
} from "@cadenza.io/service/nuxt";
import type { DemoFrontendRuntime } from "../lib/cadenza/runtime";

export function useCadenzaRuntime() {
  return useNuxtCadenzaRuntime<DemoFrontendRuntime>();
}
