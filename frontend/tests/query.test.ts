import { describe, expect, it } from "vitest";
import {
  normalizeAlertRow,
  normalizeDeviceRow,
  normalizeHealthMetricRow,
  normalizeTelemetryRow,
} from "../lib/cadenza/query";

describe("query normalization helpers", () => {
  it("normalizes camelCase telemetry rows from SSR bridge queries", () => {
    const row = normalizeTelemetryRow({
      deviceId: "device-44",
      timestamp: {},
      temperature: "47.38",
      humidity: "38.09",
      battery: "80.64",
      rawJson: {
        timestamp: "2026-03-18T10:10:40.196Z",
      },
    });

    expect(row).toEqual({
      device_id: "device-44",
      timestamp: "2026-03-18T10:10:40.196Z",
      temperature: 47.38,
      humidity: 38.09,
      battery: 80.64,
      raw_json: {
        timestamp: "2026-03-18T10:10:40.196Z",
      },
    });
  });

  it("normalizes camelCase health metric and device rows", () => {
    expect(
      normalizeHealthMetricRow({
        deviceId: "device-44",
        timestamp: "2026-03-18T10:10:40.196Z",
        anomalyScore: "0.12",
        failureProbability: "0.61",
        predictedEta: "2026-03-19T10:10:40.196Z",
      }),
    ).toMatchObject({
      device_id: "device-44",
      anomaly_score: 0.12,
      failure_probability: 0.61,
      predicted_eta: "2026-03-19T10:10:40.196Z",
    });

    expect(
      normalizeDeviceRow({
        name: "device-1",
        type: "temperature-humidity",
        lastSeen: "2026-03-18T10:10:40.196Z",
      }),
    ).toEqual({
      name: "device-1",
      type: "temperature-humidity",
      last_seen: "2026-03-18T10:10:40.196Z",
    });
  });

  it("normalizes alert rows with camelCase device ids", () => {
    expect(
      normalizeAlertRow({
        deviceId: "device-8",
        timestamp: "2026-03-18T10:10:40.196Z",
        type: "prediction",
        severity: "high",
        reason: "Failure probability exceeded threshold",
        resolved: false,
      }),
    ).toEqual({
      device_id: "device-8",
      timestamp: "2026-03-18T10:10:40.196Z",
      type: "prediction",
      severity: "high",
      reason: "Failure probability exceeded threshold",
      resolved: false,
    });
  });
});
