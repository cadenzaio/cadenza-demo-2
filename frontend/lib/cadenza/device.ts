import type {
  AlertRow,
  AlertSessionState,
  AlertType,
  AnomalyRuntimeState,
  DevicePageData,
  DeviceRow,
  HealthMetricRow,
  PredictionSessionState,
  TelemetryRow,
  TelemetrySessionState,
} from "./contracts";
import { seedDashboardLiveEvents } from "./live-events";

export function buildDevicePageData(input: {
  device: DeviceRow | null;
  telemetrySession: TelemetrySessionState | null;
  predictionSession: PredictionSessionState | null;
  alertSessions: Partial<Record<AlertType, AlertSessionState | null>>;
  anomalyRuntime: AnomalyRuntimeState | null;
  telemetryHistory: TelemetryRow[];
  healthMetricHistory: HealthMetricRow[];
  alertHistory: AlertRow[];
}): DevicePageData {
  return {
    device: input.device,
    telemetrySession: input.telemetrySession,
    predictionSession: input.predictionSession,
    alertSessions: input.alertSessions,
    anomalyRuntime: input.anomalyRuntime,
    telemetryHistory: input.telemetryHistory,
    healthMetricHistory: input.healthMetricHistory,
    alertHistory: input.alertHistory,
    liveFeedSeed: seedDashboardLiveEvents({
      recentTelemetry: input.telemetryHistory,
      recentHealthMetrics: input.healthMetricHistory,
      recentAlerts: input.alertHistory,
    }),
  };
}
