import { defineEventHandler } from "h3";
import { loadDashboardPageDataServer } from "../utils/cadenza/dashboard";

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const result = await loadDashboardPageDataServer({
    cadenzaServerAddress: String(config.cadenzaServerAddress ?? "").trim(),
    cadenzaServerPort: Math.trunc(Number(config.cadenzaServerPort ?? 8080) || 8080),
  });

  return result.data;
});
