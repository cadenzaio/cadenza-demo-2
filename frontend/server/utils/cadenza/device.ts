import type { HydrationOptions, SSRInquiryBridge } from "@cadenza.io/service";
import {
  ALERT_TYPES,
  IOT_DB_QUERY_INTENTS,
  IOT_INTENTS,
  type AlertRow,
  type AlertSessionState,
  type AlertType,
  type AnomalyRuntimeState,
  type DevicePageData,
  type DeviceRow,
  type HealthMetricRow,
  type PredictionSessionState,
  type TelemetryRow,
  type TelemetrySessionState,
} from "../../../lib/cadenza/contracts";
import { getDeviceHydrationKeys } from "../../../lib/cadenza/hydration";
import { buildDevicePageData } from "../../../lib/cadenza/device";
import {
  extractOne,
  extractRows,
  normalizeAlertRow,
  normalizeDeviceRow,
  normalizeHealthMetricRow,
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

export async function loadDevicePageDataServer(
  deviceId: string,
  bridgeConfig: DemoSSRBridgeConfig,
): Promise<{ data: DevicePageData; hydration: HydrationOptions }> {
  const bridge = createDemoSSRBridge(bridgeConfig);
  const hydrationKeys = getDeviceHydrationKeys(deviceId);

  const [
    deviceResult,
    telemetrySessionResult,
    predictionSessionResult,
    anomalyRuntimeResult,
    telemetryHistoryResult,
    healthMetricHistoryResult,
    alertHistoryResult,
    alertResults,
  ] = await Promise.all([
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.deviceOne,
      {
        queryData: {
          filter: {
            name: deviceId,
          },
        },
      },
      hydrationKeys.device,
    ),
    safeInquire(
      bridge,
      IOT_INTENTS.telemetrySessionGet,
      { deviceId },
      hydrationKeys.telemetrySession,
    ),
    safeInquire(
      bridge,
      IOT_INTENTS.predictionSessionGet,
      { deviceId },
      hydrationKeys.predictionSession,
    ),
    safeInquire(
      bridge,
      IOT_INTENTS.anomalyRuntimeGet,
      { deviceId },
      hydrationKeys.anomalyRuntime,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.telemetryQuery,
      {
        queryData: {
          filter: {
            device_id: deviceId,
          },
          sort: {
            timestamp: "desc",
          },
          limit: 20,
        },
      },
      hydrationKeys.telemetryHistory,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.healthMetricQuery,
      {
        queryData: {
          filter: {
            device_id: deviceId,
          },
          sort: {
            timestamp: "desc",
          },
          limit: 12,
        },
      },
      hydrationKeys.healthMetricHistory,
    ),
    safeInquire(
      bridge,
      IOT_DB_QUERY_INTENTS.alertQuery,
      {
        queryData: {
          filter: {
            device_id: deviceId,
          },
          sort: {
            timestamp: "desc",
          },
          limit: 12,
        },
      },
      hydrationKeys.alertHistory,
    ),
    Promise.all(
      ALERT_TYPES.map(async (type) => ({
        type,
        response: await safeInquire(
          bridge,
          IOT_INTENTS.alertSessionGet,
          { deviceId, type },
          hydrationKeys.alertSession(type),
        ),
      })),
    ),
  ]);

  const alertSessions = Object.fromEntries(
    alertResults.map(({ type, response }) => [
      type,
      (response?.session ?? null) as AlertSessionState | null,
    ]),
  ) as Partial<Record<AlertType, AlertSessionState | null>>;

  const data = buildDevicePageData({
    device: normalizeDeviceRow(extractOne<DeviceRow>(deviceResult, ["device"])),
    telemetrySession:
      (telemetrySessionResult?.session as TelemetrySessionState | null | undefined) ?? null,
    predictionSession:
      (predictionSessionResult?.session as PredictionSessionState | null | undefined) ?? null,
    alertSessions,
    anomalyRuntime:
      (anomalyRuntimeResult?.runtimeSession as AnomalyRuntimeState | null | undefined) ?? null,
    telemetryHistory: extractRows<TelemetryRow>(telemetryHistoryResult, [
      "telemetries",
      "telemetrys",
      "telemetryRows",
    ]).map(normalizeTelemetryRow),
    healthMetricHistory: extractRows<HealthMetricRow>(healthMetricHistoryResult, [
      "healthMetrics",
      "healthMetricRows",
    ]).map(normalizeHealthMetricRow),
    alertHistory: extractRows<AlertRow>(alertHistoryResult, [
      "alerts",
      "alertRows",
    ]).map(normalizeAlertRow),
  });

  return {
    data,
    hydration: bridge.dehydrate(),
  };
}
