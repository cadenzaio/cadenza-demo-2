import type {
  AlertRow,
  DashboardPageData,
  DeviceRow,
  DeviceSummary,
  HealthMetricRow,
  RunnerStatus,
  TelemetryRow,
} from "./contracts";
import { formatCompactNumber, uniqueCount } from "./query";
import { seedDashboardLiveEvents } from "./live-events";

function toStatus(input: {
  openAlertSeverity: DeviceSummary["openAlertSeverity"];
  failureProbability: number | null;
}): DeviceSummary["status"] {
  if (input.openAlertSeverity === "high" || (input.failureProbability ?? 0) >= 0.72) {
    return "critical";
  }
  if (input.openAlertSeverity === "medium" || (input.failureProbability ?? 0) >= 0.45) {
    return "watch";
  }
  return "stable";
}

export function buildDashboardPageData(input: {
  deviceCount: number;
  openHighAlerts: number;
  maintenanceAlerts: number;
  devices: DeviceRow[];
  recentTelemetry: TelemetryRow[];
  recentHealthMetrics: HealthMetricRow[];
  recentAlerts: AlertRow[];
  runnerStatus: RunnerStatus | null;
}): DashboardPageData {
  const latestTelemetry = new Map<string, TelemetryRow>();
  const latestHealthMetric = new Map<string, HealthMetricRow>();
  const unresolvedAlertsByDevice = new Map<
    string,
    { count: number; highest: "low" | "medium" | "high" | null }
  >();

  for (const row of input.recentTelemetry) {
    if (!latestTelemetry.has(row.device_id)) {
      latestTelemetry.set(row.device_id, row);
    }
  }

  for (const row of input.recentHealthMetrics) {
    if (!latestHealthMetric.has(row.device_id)) {
      latestHealthMetric.set(row.device_id, row);
    }
  }

  for (const row of input.recentAlerts) {
    if (row.resolved) {
      continue;
    }
    const current = unresolvedAlertsByDevice.get(row.device_id) ?? {
      count: 0,
      highest: null,
    };
    const highest =
      current.highest === "high" || row.severity === "high"
        ? "high"
        : current.highest === "medium" || row.severity === "medium"
          ? "medium"
          : "low";
    unresolvedAlertsByDevice.set(row.device_id, {
      count: current.count + 1,
      highest,
    });
  }

  const deviceSummaries: DeviceSummary[] = input.devices.map((device) => {
    const telemetry = latestTelemetry.get(device.name);
    const metric = latestHealthMetric.get(device.name);
    const alerts = unresolvedAlertsByDevice.get(device.name);
    const lastSeen = telemetry?.timestamp ?? device.last_seen ?? device.lastSeen ?? null;
    const failureProbability =
      typeof metric?.failure_probability === "number"
        ? Number(metric.failure_probability)
        : null;

    return {
      deviceId: device.name,
      type: device.type,
      lastSeen,
      temperature:
        typeof telemetry?.temperature === "number" ? Number(telemetry.temperature) : null,
      humidity:
        typeof telemetry?.humidity === "number" ? Number(telemetry.humidity) : null,
      battery: typeof telemetry?.battery === "number" ? Number(telemetry.battery) : null,
      failureProbability,
      predictedEta: metric?.predicted_eta ?? null,
      openAlertCount: alerts?.count ?? 0,
      openAlertSeverity: alerts?.highest ?? null,
      status: toStatus({
        openAlertSeverity: alerts?.highest ?? null,
        failureProbability,
      }),
    };
  });

  return {
    kpis: [
      {
        label: "Tracked devices",
        value: formatCompactNumber(input.deviceCount),
        hint: "Provisioned device inventory from the IoT DB service",
      },
      {
        label: "High alerts",
        value: formatCompactNumber(input.openHighAlerts),
        hint: "Currently open high-severity alerts",
      },
      {
        label: "Maintenance flags",
        value: formatCompactNumber(input.maintenanceAlerts),
        hint: "Open prediction or escalation alerts",
      },
      {
        label: "Recent active devices",
        value: formatCompactNumber(uniqueCount(input.recentTelemetry.map((row) => row.device_id))),
        hint: "Unique devices in the latest telemetry sample",
      },
    ],
    runnerStatus: input.runnerStatus,
    devices: deviceSummaries,
    recentTelemetry: input.recentTelemetry,
    recentHealthMetrics: input.recentHealthMetrics,
    recentAlerts: input.recentAlerts,
    liveFeedSeed: seedDashboardLiveEvents({
      recentTelemetry: input.recentTelemetry,
      recentHealthMetrics: input.recentHealthMetrics,
      recentAlerts: input.recentAlerts,
    }),
  };
}
