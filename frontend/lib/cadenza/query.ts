import type { HydrationOptions } from "@cadenza.io/service";
import type {
  AlertRow,
  DeviceRow,
  HealthMetricRow,
  RunnerStatus,
  TelemetryRow,
} from "./contracts";

type AnyRecord = Record<string, any>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

function firstDefined<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null);
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function coerceTimestamp(
  ...candidates: unknown[]
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      continue;
    }

    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
      return candidate.toISOString();
    }

    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return new Date(candidate).toISOString();
    }

    if (candidate && typeof candidate === "object") {
      const objectCandidate = candidate as { toISOString?: () => string };
      if (typeof objectCandidate.toISOString === "function") {
        try {
          return objectCandidate.toISOString();
        } catch {
          // Ignore and continue to the next candidate.
        }
      }
    }
  }

  return null;
}

export function normalizeDeviceRow(raw: AnyRecord | null | undefined): DeviceRow {
  const row = asRecord(raw);
  return {
    name: readString(firstDefined(row.name, row.device_id, row.deviceId)) ?? "",
    type: readString(row.type) ?? "unknown",
    last_seen: coerceTimestamp(firstDefined(row.last_seen, row.lastSeen)),
  };
}

export function normalizeTelemetryRow(
  raw: AnyRecord | null | undefined,
): TelemetryRow {
  const row = asRecord(raw);
  const rawJson = asRecord(firstDefined(row.raw_json, row.rawJson));

  return {
    device_id:
      readString(
        firstDefined(
          row.device_id,
          row.deviceId,
          rawJson.device_id,
          rawJson.deviceId,
        ),
      ) ?? "",
    timestamp:
      coerceTimestamp(
        row.timestamp,
        rawJson.timestamp,
      ) ?? "",
    temperature: readNumber(row.temperature) ?? 0,
    humidity: readNumber(row.humidity) ?? 0,
    battery: readNumber(row.battery) ?? 0,
    raw_json: Object.keys(rawJson).length > 0 ? rawJson : null,
  };
}

export function normalizeHealthMetricRow(
  raw: AnyRecord | null | undefined,
): HealthMetricRow {
  const row = asRecord(raw);

  return {
    device_id:
      readString(firstDefined(row.device_id, row.deviceId)) ?? "",
    timestamp: coerceTimestamp(row.timestamp) ?? "",
    anomaly_score:
      readNumber(firstDefined(row.anomaly_score, row.anomalyScore)) ?? 0,
    failure_probability:
      readNumber(
        firstDefined(row.failure_probability, row.failureProbability),
      ) ?? 0,
    predicted_eta:
      coerceTimestamp(firstDefined(row.predicted_eta, row.predictedEta)) ??
      readString(firstDefined(row.predicted_eta, row.predictedEta)) ??
      null,
  };
}

export function normalizeAlertRow(raw: AnyRecord | null | undefined): AlertRow {
  const row = asRecord(raw);
  const severity =
    row.severity === "high" || row.severity === "medium" ? row.severity : "low";

  return {
    device_id:
      readString(firstDefined(row.device_id, row.deviceId)) ?? "",
    timestamp: coerceTimestamp(row.timestamp) ?? "",
    type: readString(row.type) as AlertRow["type"],
    severity,
    reason: readString(row.reason) ?? "No reason provided",
    resolved: Boolean(row.resolved),
  };
}

export function normalizeRunnerStatus(
  raw: AnyRecord | null | undefined,
): RunnerStatus | null {
  const row = asRecord(raw);
  const trafficMode = readString(row.trafficMode);
  if (trafficMode !== "low" && trafficMode !== "high") {
    return null;
  }

  return {
    tickCount: Math.max(0, Math.trunc(readNumber(row.tickCount) ?? 0)),
    totalEventsEmitted: Math.max(
      0,
      Math.trunc(readNumber(row.totalEventsEmitted) ?? 0),
    ),
    lastDelayMs: Math.max(0, Math.trunc(readNumber(row.lastDelayMs) ?? 0)),
    lastBurstCount: Math.max(0, Math.trunc(readNumber(row.lastBurstCount) ?? 0)),
    trafficMode,
  };
}

export function mergeHydrationOptions(
  current?: HydrationOptions | null,
  next?: HydrationOptions | null,
): HydrationOptions {
  return {
    initialInquiryResults: {
      ...(current?.initialInquiryResults ?? {}),
      ...(next?.initialInquiryResults ?? {}),
    },
  };
}

export function extractCount(result: AnyRecord | null | undefined): number {
  return Math.max(0, Math.trunc(Number(result?.count ?? result?.rowCount ?? 0) || 0));
}

export function extractRows<T>(
  result: AnyRecord | null | undefined,
  keys: string[],
): T[] {
  if (!result) {
    return [];
  }

  for (const key of keys) {
    const value = result[key];
    if (Array.isArray(value)) {
      return value as T[];
    }
  }

  if (Array.isArray(result.rows)) {
    return result.rows as T[];
  }

  if (Array.isArray(result.data)) {
    return result.data as T[];
  }

  return [];
}

export function extractOne<T>(
  result: AnyRecord | null | undefined,
  keys: string[],
): T | null {
  if (!result) {
    return null;
  }

  for (const key of keys) {
    const value = result[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as T;
    }
  }

  return null;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value > 99 ? 0 : 1,
  }).format(value);
}

const DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatDisplayDate(value: string | null | undefined): string {
  if (!value) {
    return "No data";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return DISPLAY_DATE_FORMATTER.format(date);
}

export function uniqueCount(values: string[]): number {
  return new Set(values.filter(Boolean)).size;
}
