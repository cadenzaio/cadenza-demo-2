export const IOT_SIGNALS = {
  telemetryIngested: "global.iot.telemetry.ingested",
  anomalyDetected: "global.iot.anomaly.detected",
  predictionReady: "global.iot.prediction.ready",
  predictionMaintenanceNeeded: "global.iot.prediction.maintenance_needed",
  alertRaised: "global.iot.alert.raised",
} as const;

export const IOT_INTENTS = {
  telemetryIngest: "iot-telemetry-ingest",
  anomalyDetect: "iot-anomaly-detect",
  predictionCompute: "iot-prediction-compute",
  alertEvaluate: "iot-alert-evaluate",
  telemetrySessionGet: "iot-telemetry-session-get",
  predictionSessionGet: "iot-prediction-session-get",
  alertSessionGet: "iot-alert-session-get",
} as const;

export const IOT_DB_INTENTS = {
  telemetryInsert: "insert-pg-iot-db-service-postgres-actor-telemetry",
  healthMetricInsert: "insert-pg-iot-db-service-postgres-actor-health_metric",
  alertInsert: "insert-pg-iot-db-service-postgres-actor-alert",
} as const;

export type DeviceReadings = {
  temperature: number;
  humidity: number;
  battery: number;
};

export type TelemetryIngestPayload = {
  deviceId: string;
  timestamp: string;
  readings: DeviceReadings;
  source: "scheduler";
  trafficMode: "low" | "high";
};

export type AnomalyResult = {
  deviceId: string;
  timestamp: string;
  anomalyDetected: boolean;
  anomalyScore: number;
  reason: string;
  metrics: {
    temperature: { score: number; zScore: number; anomalous: boolean };
    humidity: { score: number; zScore: number; anomalous: boolean };
  };
};

export type PredictionResult = {
  deviceId: string;
  timestamp: string;
  failureProbability: number;
  maintenanceNeeded: boolean;
  predictedEta: string;
  riskFactors: {
    anomalyScore: number;
    weatherCondition: string;
    weatherMultiplier: number;
  };
};

export type AlertEvaluatePayload = {
  deviceId: string;
  type: "anomaly" | "prediction" | "escalation";
  severity: "low" | "medium" | "high";
  reason: string;
  timestamp: string;
};
