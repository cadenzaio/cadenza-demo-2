import { describe, expect, it } from "vitest";
import { buildDashboardPageData } from "../lib/cadenza/dashboard";
import { normalizeRunnerStatus } from "../lib/cadenza/query";

describe("dashboard data builder", () => {
  it("combines counts and recent rows into device summaries", () => {
    const data = buildDashboardPageData({
      deviceCount: 50,
      openHighAlerts: 3,
      maintenanceAlerts: 5,
      devices: [
        {
          name: "device-1",
          type: "temperature-humidity",
        },
      ],
      recentTelemetry: [
        {
          device_id: "device-1",
          timestamp: "2026-03-14T12:00:00.000Z",
          temperature: 87,
          humidity: 18,
          battery: 14,
        },
      ],
      recentHealthMetrics: [
        {
          device_id: "device-1",
          timestamp: "2026-03-14T12:01:00.000Z",
          anomaly_score: 0.74,
          failure_probability: 0.83,
          predicted_eta: "2026-03-14T18:00:00.000Z",
        },
      ],
      recentAlerts: [
        {
          device_id: "device-1",
          timestamp: "2026-03-14T12:02:00.000Z",
          type: "prediction",
          severity: "high",
          reason: "Failure probability exceeded threshold",
          resolved: false,
        },
      ],
      runnerStatus: null,
    });

    expect(data.kpis[0]?.value).toBe("50");
    expect(data.devices[0]).toMatchObject({
      deviceId: "device-1",
      status: "critical",
      openAlertCount: 1,
    });
    expect(data.liveFeedSeed.length).toBeGreaterThan(0);
  });

  it("normalizes runner runtime payloads for dashboard rendering", () => {
    expect(
      normalizeRunnerStatus({
        tickCount: 48,
        totalEventsEmitted: 59,
        lastDelayMs: 13695,
        lastBurstCount: 3,
        trafficMode: "low",
      }),
    ).toEqual({
      tickCount: 48,
      totalEventsEmitted: 59,
      lastDelayMs: 13695,
      lastBurstCount: 3,
      trafficMode: "low",
    });
  });
});
