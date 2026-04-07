import type {
  AlertRow,
  HealthMetricRow,
  LiveEvent,
  SignalName,
  TelemetryRow,
} from "./contracts";
import { IOT_SIGNALS } from "./contracts";
import { coerceTimestamp } from "./query";

const LIVE_FEED_LIMIT = 24;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function normalizeSignalPayload(payload: Record<string, any>) {
  const root = asRecord(payload.data ?? payload);
  const rawJson = asRecord(root.raw_json ?? root.rawJson);
  const explicitReadings = asRecord(root.readings ?? rawJson.readings);
  const readings =
    Object.keys(explicitReadings).length > 0
      ? explicitReadings
      : {
          temperature: root.temperature ?? rawJson.temperature,
          humidity: root.humidity ?? rawJson.humidity,
          battery: root.battery ?? rawJson.battery,
        };

  return {
    deviceId: String(
      root.deviceId ?? root.device_id ?? rawJson.deviceId ?? rawJson.device_id ?? "",
    ).trim(),
    timestamp:
      coerceTimestamp(root.timestamp, rawJson.timestamp, payload.timestamp) ??
      new Date().toISOString(),
    readings,
    reason: root.reason ?? payload.reason ?? "Threshold exceeded",
    anomalyScore: Number(root.anomalyScore ?? root.anomaly_score ?? payload.anomalyScore ?? 0),
    failureProbability: Number(
      root.failureProbability ??
        root.failure_probability ??
        payload.failureProbability ??
        0,
    ),
    predictedEta:
      coerceTimestamp(root.predictedEta, root.predicted_eta, payload.predictedEta) ??
      root.predictedEta ??
      root.predicted_eta ??
      payload.predictedEta ??
      "n/a",
    severity: root.severity ?? payload.severity ?? "low",
    type: root.type ?? payload.type ?? "prediction",
  };
}

function severityFromProbability(probability: number): "low" | "medium" | "high" {
  if (probability >= 0.8) {
    return "high";
  }
  if (probability >= 0.5) {
    return "medium";
  }
  return "low";
}

function createEventId(signal: string, deviceId: string, timestamp: string): string {
  return `${signal}:${deviceId}:${timestamp}`;
}

export function appendLiveEvent(current: LiveEvent[], next: LiveEvent): LiveEvent[] {
  const seen = new Set<string>();
  return [next, ...current]
    .filter((event) => {
      if (seen.has(event.id)) {
        return false;
      }
      seen.add(event.id);
      return true;
    })
    .slice(0, LIVE_FEED_LIMIT);
}

export function signalPayloadToLiveEvent(
  signal: SignalName,
  payload: Record<string, any>,
): LiveEvent | null {
  const normalized = normalizeSignalPayload(payload);
  const deviceId = normalized.deviceId;
  const timestamp = normalized.timestamp;

  if (!deviceId) {
    return null;
  }

  if (signal === IOT_SIGNALS.telemetryIngested) {
    const readings = normalized.readings;
    return {
      id: createEventId(signal, deviceId, timestamp),
      signal,
      category: "telemetry",
      deviceId,
      timestamp,
      headline: `Telemetry ingest for ${deviceId}`,
      detail: `Temp ${Number(readings.temperature ?? 0).toFixed(1)} C · Humidity ${Number(
        readings.humidity ?? 0,
      ).toFixed(1)}% · Battery ${Number(readings.battery ?? 0).toFixed(1)}%`,
      severity: "low",
    };
  }

  if (signal === IOT_SIGNALS.anomalyDetected) {
    return {
      id: createEventId(signal, deviceId, timestamp),
      signal,
      category: "anomaly",
      deviceId,
      timestamp,
      headline: `Anomaly detected for ${deviceId}`,
      detail: `${normalized.reason} · score ${normalized.anomalyScore.toFixed(2)}`,
      severity: normalized.anomalyScore >= 0.75 ? "high" : "medium",
    };
  }

  if (
    signal === IOT_SIGNALS.predictionReady ||
    signal === IOT_SIGNALS.predictionMaintenanceNeeded
  ) {
    const probability = normalized.failureProbability;
    const maintenance = signal === IOT_SIGNALS.predictionMaintenanceNeeded;

    return {
      id: createEventId(signal, deviceId, timestamp),
      signal,
      category: maintenance ? "maintenance" : "prediction",
      deviceId,
      timestamp,
      headline: maintenance
        ? `Maintenance threshold crossed for ${deviceId}`
        : `Prediction updated for ${deviceId}`,
      detail: `${(probability * 100).toFixed(1)}% failure probability · ETA ${normalized.predictedEta}`,
      severity: severityFromProbability(probability),
    };
  }

  if (signal === IOT_SIGNALS.alertRaised) {
    const severity = normalized.severity === "high" || normalized.severity === "medium"
      ? normalized.severity
      : "low";
    return {
      id: createEventId(signal, deviceId, timestamp),
      signal,
      category: "alert",
      deviceId,
      timestamp,
      headline: `Alert raised for ${deviceId}`,
      detail: `${normalized.type} · ${normalized.reason ?? "No reason provided"}`,
      severity,
    };
  }

  return null;
}

export function seedDashboardLiveEvents(input: {
  recentTelemetry: TelemetryRow[];
  recentHealthMetrics: HealthMetricRow[];
  recentAlerts: AlertRow[];
}): LiveEvent[] {
  const events: LiveEvent[] = [];

  for (const row of input.recentTelemetry) {
    events.push({
      id: createEventId(IOT_SIGNALS.telemetryIngested, row.device_id, row.timestamp),
      signal: IOT_SIGNALS.telemetryIngested,
      category: "telemetry",
      deviceId: row.device_id,
      timestamp: row.timestamp,
      headline: `Telemetry ingest for ${row.device_id}`,
      detail: `Temp ${Number(row.temperature).toFixed(1)} C · Humidity ${Number(
        row.humidity,
      ).toFixed(1)}% · Battery ${Number(row.battery).toFixed(1)}%`,
      severity: "low",
    });
  }

  for (const row of input.recentHealthMetrics) {
    const probability = Number(row.failure_probability ?? 0);
    const maintenance = probability >= 0.72;
    events.push({
      id: createEventId(
        maintenance
          ? IOT_SIGNALS.predictionMaintenanceNeeded
          : IOT_SIGNALS.predictionReady,
        row.device_id,
        row.timestamp,
      ),
      signal: maintenance
        ? IOT_SIGNALS.predictionMaintenanceNeeded
        : IOT_SIGNALS.predictionReady,
      category: maintenance ? "maintenance" : "prediction",
      deviceId: row.device_id,
      timestamp: row.timestamp,
      headline: maintenance
        ? `Maintenance threshold crossed for ${row.device_id}`
        : `Prediction updated for ${row.device_id}`,
      detail: `${(probability * 100).toFixed(1)}% failure probability · ETA ${
        row.predicted_eta ?? "n/a"
      }`,
      severity: severityFromProbability(probability),
    });
  }

  for (const row of input.recentAlerts) {
    events.push({
      id: createEventId(IOT_SIGNALS.alertRaised, row.device_id, row.timestamp),
      signal: IOT_SIGNALS.alertRaised,
      category: "alert",
      deviceId: row.device_id,
      timestamp: row.timestamp,
      headline: `Alert raised for ${row.device_id}`,
      detail: `${row.type} · ${row.reason}`,
      severity: row.severity,
    });
  }

  return events
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, LIVE_FEED_LIMIT);
}
