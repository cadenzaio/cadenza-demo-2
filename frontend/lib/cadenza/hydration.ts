import type { AlertType } from "./contracts";

export const DASHBOARD_HYDRATION_KEYS = {
  deviceCount: "dashboard:device-count",
  highAlertCount: "dashboard:high-alert-count",
  maintenanceAlertCount: "dashboard:maintenance-alert-count",
  deviceRows: "dashboard:device-rows",
  telemetryRows: "dashboard:telemetry-rows",
  healthMetricRows: "dashboard:health-metric-rows",
  alertRows: "dashboard:alert-rows",
} as const;

function encodeHydrationSegment(value: string): string {
  return encodeURIComponent(String(value ?? "").trim());
}

export function getDeviceHydrationKeys(deviceId: string) {
  const encodedDeviceId = encodeHydrationSegment(deviceId);

  return {
    device: `device:${encodedDeviceId}:record`,
    telemetrySession: `device:${encodedDeviceId}:telemetry-session`,
    predictionSession: `device:${encodedDeviceId}:prediction-session`,
    anomalyRuntime: `device:${encodedDeviceId}:anomaly-runtime`,
    alertSession: (type: AlertType) =>
      `device:${encodedDeviceId}:alert-session:${encodeHydrationSegment(type)}`,
    telemetryHistory: `device:${encodedDeviceId}:telemetry-history`,
    healthMetricHistory: `device:${encodedDeviceId}:health-metric-history`,
    alertHistory: `device:${encodedDeviceId}:alert-history`,
  } as const;
}
