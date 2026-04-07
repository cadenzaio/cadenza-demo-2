import type { HydrationOptions } from "@cadenza.io/service";
import type { DashboardPageData, RunnerStatus } from "../lib/cadenza/contracts";
import {
  mergeHydrationOptions,
} from "../lib/cadenza/query";

async function loadDashboardPageDataClient(
  _runnerStatus: RunnerStatus | null,
): Promise<DashboardPageData> {
  return $fetch<DashboardPageData>("/api/dashboard");
}

export async function useDashboardPageData() {
  const hydration = useState<HydrationOptions>("demo-cadenza-hydration", () => ({
    initialInquiryResults: {},
  }));
  const runnerStatus = useState<RunnerStatus | null>("demo-runner-status", () => null);

  return useAsyncData("dashboard-page", async () => {
    if (import.meta.server) {
      const config = useRuntimeConfig();
      const { loadDashboardPageDataServer } = await import("../server/utils/cadenza/dashboard");
      const result = await loadDashboardPageDataServer({
        cadenzaServerAddress: String(config.cadenzaServerAddress ?? "").trim(),
        cadenzaServerPort: Math.trunc(Number(config.cadenzaServerPort ?? 8080) || 8080),
      });
      hydration.value = mergeHydrationOptions(hydration.value, result.hydration);
      runnerStatus.value = result.data.runnerStatus;
      return result.data;
    }

      return loadDashboardPageDataClient(runnerStatus.value);
  });
}
