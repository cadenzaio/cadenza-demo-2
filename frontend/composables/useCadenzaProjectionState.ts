import {
  useCadenzaProjectionState as useNuxtCadenzaProjectionState,
} from "@cadenza.io/service/nuxt";
import type {
  DemoFrontendProjectionState,
  DemoFrontendRuntimeState,
} from "../lib/cadenza/runtime";

export function useCadenzaProjectionState() {
  return useNuxtCadenzaProjectionState<DemoFrontendProjectionState>() as {
    value: DemoFrontendRuntimeState;
  };
}
