import type { HydrationOptions, SSRInquiryBridge } from "@cadenza.io/service";
import {
  IOT_INTENTS,
  IOT_DB_QUERY_INTENTS,
  type AlertRow,
  type DashboardPageData,
  type DeviceRow,
  type HealthMetricRow,
  type TelemetryRow,
} from "../../../lib/cadenza/contracts";
import { DASHBOARD_HYDRATION_KEYS } from "../../../lib/cadenza/hydration";
import { buildDashboardPageData } from "../../../lib/cadenza/dashboard";
import {
  extractCount,
  extractRows,
  normalizeAlertRow,
  normalizeDeviceRow,
  normalizeHealthMetricRow,
  normalizeRunnerStatus,
  normalizeTelemetryRow,
} from "../../../lib/cadenza/query";
import { createDemoSSRBridge, type DemoSSRBridgeConfig } from "./bridge";

const SSR_INQUIRY_TIMEOUT_MS = 5_000;

async function inquire(
  bridge: SSRInquiryBridge,
  inquiry: string,
  context: Record<string, any>,
  hydrationKey: string,
) {
  return bridge.inquire(inquiry, context, {
    requireComplete: true,
    rejectOnTimeout: true,
    timeout: SSR_INQUIRY_TIMEOUT_MS,
    overallTimeoutMs: SSR_INQUIRY_TIMEOUT_MS,
    hydrationKey,
  });
}

async function safeInquire(
  bridge: SSRInquiryBridge,
  inquiry: string,
  context: Record<string, any>,
  hydrationKey: string,
) {
  try {
    return await inquire(bridge, inquiry, context, hydrationKey);
  } catch {
    return null;
  }
}

export async function loadDashboardPageDataServer(
  bridgeConfig: DemoSSRBridgeConfig,
): Promise<{
  data: DashboardPageData;
  hydration: HydrationOptions;
}> {
  const bridge = createDemoSSRBridge(bridgeConfig);
  const [
    deviceCountResult,
    highAlertCountResult,
    deviceRowsResult,
    telemetryRowsResult,
    healthMetricRowsResult,
    alertRowsResult,
    runnerStatusResult,
  ] = await Promise.all([
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.deviceCount,
      { queryData: {} },
      DASHBOARD_HYDRATION_KEYS.deviceCount,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.alertCount,
      {
        queryData: {
          filter: {
            severity: "high",
            resolved: false,
          },
        },
      },
      DASHBOARD_HYDRATION_KEYS.highAlertCount,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.deviceQuery,
      {
        queryData: {
          sort: {
            name: "asc",
          },
          limit: 8,
        },
      },
      DASHBOARD_HYDRATION_KEYS.deviceRows,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.telemetryQuery,
      {
        queryData: {
          sort: {
            timestamp: "desc",
          },
          limit: 8,
        },
      },
      DASHBOARD_HYDRATION_KEYS.telemetryRows,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.healthMetricQuery,
      {
        queryData: {
          sort: {
            timestamp: "desc",
          },
          limit: 8,
        },
      },
      DASHBOARD_HYDRATION_KEYS.healthMetricRows,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.alertQuery,
      {
        queryData: {
          sort: {
            timestamp: "desc",
          },
          limit: 6,
        },
      },
      DASHBOARD_HYDRATION_KEYS.alertRows,
    ),
    safeInquire(
      bridge,
      IOT_INTENTS.runnerTrafficRuntimeGet,
      {},
      "dashboard:runner-status",
    ),
  ]);

  const data = buildDashboardPageData({
    deviceCount: extractCount(deviceCountResult),
    openHighAlerts: extractCount(highAlertCountResult),
    maintenanceAlerts: 0,
    devices: extractRows<DeviceRow>(deviceRowsResult, ["devices", "deviceRows"]).map(
      normalizeDeviceRow,
    ),
    recentTelemetry: extractRows<TelemetryRow>(telemetryRowsResult, [
      "telemetries",
      "telemetrys",
      "telemetryRows",
    ]).map(normalizeTelemetryRow),
    recentHealthMetrics: extractRows<HealthMetricRow>(healthMetricRowsResult, [
      "healthMetrics",
      "healthMetricRows",
    ]).map(normalizeHealthMetricRow),
    recentAlerts: extractRows<AlertRow>(alertRowsResult, ["alerts", "alertRows"]).map(
      normalizeAlertRow,
    ),
    runnerStatus: normalizeRunnerStatus(
      runnerStatusResult as Record<string, unknown> | null | undefined,
    ),
  });

  return {
    data,
    hydration: bridge.dehydrate(),
  };
}
