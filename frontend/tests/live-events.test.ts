import { describe, expect, it } from "vitest";
import {
  appendLiveEvent,
  seedDashboardLiveEvents,
  signalPayloadToLiveEvent,
} from "../lib/cadenza/live-events";
import { IOT_SIGNALS } from "../lib/cadenza/contracts";

describe("live event helpers", () => {
  it("normalizes telemetry signals into live feed events", () => {
    const event = signalPayloadToLiveEvent(IOT_SIGNALS.telemetryIngested, {
      deviceId: "device-7",
      timestamp: "2026-03-14T10:00:00.000Z",
      readings: {
        temperature: 82.1,
        humidity: 18.4,
        battery: 34.2,
      },
    });

    expect(event).toMatchObject({
      deviceId: "device-7",
      category: "telemetry",
      severity: "low",
    });
  });

  it("normalizes wrapped telemetry payloads with snake_case and rawJson fallback", () => {
    const event = signalPayloadToLiveEvent(IOT_SIGNALS.telemetryIngested, {
      data: {
        device_id: "device-9",
        timestamp: {},
        temperature: "61.2",
        humidity: "43.5",
        battery: "79.9",
        rawJson: {
          timestamp: "2026-03-18T10:10:40.196Z",
        },
      },
    });

    expect(event).toMatchObject({
      deviceId: "device-9",
      timestamp: "2026-03-18T10:10:40.196Z",
      category: "telemetry",
    });
    expect(event?.detail).toContain("Temp 61.2 C");
  });

  it("deduplicates feed entries while keeping newest items first", () => {
    const base = signalPayloadToLiveEvent(IOT_SIGNALS.alertRaised, {
      deviceId: "device-3",
      timestamp: "2026-03-14T11:00:00.000Z",
      severity: "high",
      type: "prediction",
      reason: "Failure probability exceeded threshold",
    });

    const next = signalPayloadToLiveEvent(IOT_SIGNALS.predictionReady, {
      deviceId: "device-3",
      timestamp: "2026-03-14T11:01:00.000Z",
      failureProbability: 0.64,
      predictedEta: "2026-03-15T11:01:00.000Z",
    });

    expect(base).not.toBeNull();
    expect(next).not.toBeNull();

    const appended = appendLiveEvent([base!, base!], next!);
    expect(appended).toHaveLength(2);
    expect(appended[0]?.id).toBe(next!.id);
  });

  it("seeds initial feed entries from recent rows", () => {
    const events = seedDashboardLiveEvents({
      recentTelemetry: [
        {
          device_id: "device-1",
          timestamp: "2026-03-14T09:00:00.000Z",
          temperature: 70,
          humidity: 48,
          battery: 82,
        },
      ],
      recentHealthMetrics: [],
      recentAlerts: [],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.deviceId).toBe("device-1");
  });
});
