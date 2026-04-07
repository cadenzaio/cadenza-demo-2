import { createError, defineEventHandler, getRouterParam } from "h3";
import { loadDevicePageDataServer } from "../../utils/cadenza/device";

export default defineEventHandler(async (event) => {
  const deviceId = getRouterParam(event, "deviceId");
  if (!deviceId) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing device id.",
    });
  }

  const config = useRuntimeConfig(event);
  const result = await loadDevicePageDataServer(deviceId, {
    cadenzaServerAddress: String(config.cadenzaServerAddress ?? "").trim(),
    cadenzaServerPort: Math.trunc(Number(config.cadenzaServerPort ?? 8080) || 8080),
  });

  return result.data;
});
