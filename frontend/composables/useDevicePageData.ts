import type { HydrationOptions } from "@cadenza.io/service";
import type { DevicePageData } from "../lib/cadenza/contracts";
import { mergeHydrationOptions } from "../lib/cadenza/query";

async function loadDevicePageDataClient(deviceId: string): Promise<DevicePageData> {
  return $fetch<DevicePageData>(`/api/devices/${encodeURIComponent(deviceId)}`);
}

export async function useDevicePageData(deviceId: Ref<string>) {
  const hydration = useState<HydrationOptions>("demo-cadenza-hydration", () => ({
    initialInquiryResults: {},
  }));

  return useAsyncData(
    () => `device-page:${deviceId.value}`,
    async () => {
      if (import.meta.server) {
        const config = useRuntimeConfig();
        const { loadDevicePageDataServer } = await import("../server/utils/cadenza/device");
        const result = await loadDevicePageDataServer(deviceId.value, {
          cadenzaServerAddress: String(config.cadenzaServerAddress ?? "").trim(),
          cadenzaServerPort: Math.trunc(Number(config.cadenzaServerPort ?? 8080) || 8080),
        });
        hydration.value = mergeHydrationOptions(hydration.value, result.hydration);
        return result.data;
      }

      return loadDevicePageDataClient(deviceId.value);
    },
    {
      watch: [deviceId],
    },
  );
}
