import { computed } from "vue";

export function useCadenzaRuntimeReady() {
  const readyState = useState<boolean>("demo-cadenza-runtime-ready", () => false);
  return computed(() => readyState.value);
}
