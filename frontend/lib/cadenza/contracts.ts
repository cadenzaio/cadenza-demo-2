export const IOT_SIGNALS = {
  telemetryIngested: "global.iot.telemetry.ingested",
  anomalyDetected: "global.iot.anomaly.detected",
  predictionReady: "global.iot.prediction.ready",
  predictionMaintenanceNeeded: "global.iot.prediction.maintenance_needed",
  alertRaised: "global.iot.alert.raised",
} as const;

export const IOT_INTENTS = {
  telemetryIngest: "iot-telemetry-ingest",
  telemetrySessionGet: "iot-telemetry-session-get",
  predictionSessionGet: "iot-prediction-session-get",
  alertSessionGet: "iot-alert-session-get",
  anomalyRuntimeGet: "iot-anomaly-runtime-get",
  runnerTrafficRuntimeGet: "runner-traffic-runtime-get",
} as const;

const IOT_DB_ACTOR_NAME = "iot-db-service-postgres-actor";

export const IOT_DB_QUERY_INTENTS = {
  deviceQuery: `query-pg-${IOT_DB_ACTOR_NAME}-device`,
  deviceCount: `count-pg-${IOT_DB_ACTOR_NAME}-device`,
  deviceOne: `one-pg-${IOT_DB_ACTOR_NAME}-device`,
  telemetryQuery: `query-pg-${IOT_DB_ACTOR_NAME}-telemetry`,
  healthMetricQuery: `query-pg-${IOT_DB_ACTOR_NAME}-health_metric`,
  healthMetricCount: `count-pg-${IOT_DB_ACTOR_NAME}-health_metric`,
  alertQuery: `query-pg-${IOT_DB_ACTOR_NAME}-alert`,
  alertCount: `count-pg-${IOT_DB_ACTOR_NAME}-alert`,
} as const;

export const ALERT_TYPES = ["anomaly", "prediction", "escalation"] as const;

export type AlertType = (typeof ALERT_TYPES)[number];
export type SignalName = (typeof IOT_SIGNALS)[keyof typeof IOT_SIGNALS];

export type DeviceRow = {
  name: string;
  type: string;
  last_seen?: string | null;
  lastSeen?: string | null;
};

export type TelemetryRow = {
  device_id: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number;
  raw_json?: Record<string, unknown> | null;
};

export type HealthMetricRow = {
  device_id: string;
  timestamp: string;
  anomaly_score: number;
  failure_probability: number;
  predicted_eta: string | null;
};

export type AlertRow = {
  device_id: string;
  timestamp: string;
  type: AlertType;
  severity: "low" | "medium" | "high";
  reason: string;
  resolved: boolean;
};

export type RunnerStatus = {
  tickCount: number;
  totalEventsEmitted: number;
  lastDelayMs: number;
  lastBurstCount: number;
  trafficMode: "low" | "high";
};

export type TelemetrySessionState = {
  lastTelemetry: {
    deviceId: string;
    timestamp: string;
    readings: {
      temperature: number;
      humidity: number;
      battery: number;
    };
    source: "scheduler";
    trafficMode: "low" | "high";
  } | null;
  validationCount: number;
  outlierCount: number;
  lastAnomaly: Record<string, unknown> | null;
  lastPrediction: Record<string, unknown> | null;
  lastIngestedAt: string | null;
};

export type PredictionSessionState = {
  lastProbability: number;
  lastPredictedEta: string | null;
  lastRiskFactors: Record<string, unknown> | null;
  lastAnomalyScore: number;
  computeCount: number;
  lastComputedAt: string | null;
};

export type AlertSessionState = {
  isOpen: boolean;
  lastSeverity: "low" | "medium" | "high";
  lastReason: string | null;
  lastRaisedAt: string | null;
  lastResolvedAt: string | null;
  raiseCount: number;
  dedupeCount: number;
};

export type AnomalyRuntimeState = {
  recentTemperatures: number[];
  recentHumidities: number[];
  recentScores: number[];
  lastAnomalyAt: string | null;
};

export type LiveEvent = {
  id: string;
  signal: string;
  category: "telemetry" | "anomaly" | "prediction" | "maintenance" | "alert";
  deviceId: string;
  timestamp: string;
  headline: string;
  detail: string;
  severity: "low" | "medium" | "high";
};

export type DeviceSummary = {
  deviceId: string;
  type: string;
  lastSeen: string | null;
  temperature: number | null;
  humidity: number | null;
  battery: number | null;
  failureProbability: number | null;
  predictedEta: string | null;
  openAlertCount: number;
  openAlertSeverity: "low" | "medium" | "high" | null;
  status: "stable" | "watch" | "critical";
};

export type DashboardPageData = {
  kpis: Array<{
    label: string;
    value: string;
    hint: string;
  }>;
  runnerStatus: RunnerStatus | null;
  devices: DeviceSummary[];
  recentTelemetry: TelemetryRow[];
  recentHealthMetrics: HealthMetricRow[];
  recentAlerts: AlertRow[];
  liveFeedSeed: LiveEvent[];
};

export type DevicePageData = {
  device: DeviceRow | null;
  telemetrySession: TelemetrySessionState | null;
  predictionSession: PredictionSessionState | null;
  alertSessions: Partial<Record<AlertType, AlertSessionState | null>>;
  anomalyRuntime: AnomalyRuntimeState | null;
  telemetryHistory: TelemetryRow[];
  healthMetricHistory: HealthMetricRow[];
  alertHistory: AlertRow[];
  liveFeedSeed: LiveEvent[];
};
