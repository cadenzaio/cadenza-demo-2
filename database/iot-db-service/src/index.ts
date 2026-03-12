import Cadenza from "@cadenza.io/service";
import { iotHealthSchema } from "./schema.js";
import { IOT_DB_INTENTS } from "./contracts.js";

Cadenza.createDatabaseService("IotDbService", iotHealthSchema as any, "IoT Database Service", {
  cadenzaDB: {
    connect: true,
    address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
    port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
  },
});

const persistTelemetryTask = Cadenza.createDatabaseInsertTask("telemetry");
const persistHealthMetricTask = Cadenza.createDatabaseInsertTask("health_metric");
const persistAlertTask = Cadenza.createDatabaseInsertTask("alert");

Cadenza.createTask(
  "Normalize telemetry insert queryData",
  (ctx: any) => {
    if (!ctx.data || typeof ctx.data !== "object") {
      throw new Error("iot-db-telemetry-insert requires data object");
    }

    return {
      ...ctx,
      data: {
        device_id: ctx.data.device_id,
        timestamp: ctx.data.timestamp,
        temperature: ctx.data.temperature,
        humidity: ctx.data.humidity,
        battery: ctx.data.battery,
        raw_json: ctx.data.raw_json,
      },
    };
  },
  "Validates telemetry insert payload for internal DB intent.",
)
  .then(persistTelemetryTask)
  .then(
    Cadenza.createTask("Finalize telemetry insert intent", () => {
      return {
        __success: true,
        inserted: true,
      };
    }),
  )
  .respondsTo(IOT_DB_INTENTS.telemetryInsert);

Cadenza.createTask(
  "Normalize health_metric insert queryData",
  (ctx: any) => {
    if (!ctx.data || typeof ctx.data !== "object") {
      throw new Error("iot-db-health-metric-insert requires data object");
    }

    return {
      ...ctx,
      data: {
        device_id: ctx.data.device_id,
        timestamp: ctx.data.timestamp,
        anomaly_score: ctx.data.anomaly_score,
        failure_probability: ctx.data.failure_probability,
        predicted_eta: ctx.data.predicted_eta,
      },
    };
  },
  "Validates health_metric insert payload for internal DB intent.",
)
  .then(persistHealthMetricTask)
  .then(
    Cadenza.createTask("Finalize health_metric insert intent", () => {
      return {
        __success: true,
        inserted: true,
      };
    }),
  )
  .respondsTo(IOT_DB_INTENTS.healthMetricInsert);

Cadenza.createTask(
  "Normalize alert insert queryData",
  (ctx: any) => {
    if (!ctx.data || typeof ctx.data !== "object") {
      throw new Error("iot-db-alert-insert requires data object");
    }

    return {
      ...ctx,
      data: {
        device_id: ctx.data.device_id,
        timestamp: ctx.data.timestamp,
        type: ctx.data.type,
        severity: ctx.data.severity,
        reason: ctx.data.reason,
        resolved: ctx.data.resolved,
      },
    };
  },
  "Validates alert insert payload for internal DB intent.",
)
  .then(persistAlertTask)
  .then(
    Cadenza.createTask("Finalize alert insert intent", () => {
      return {
        __success: true,
        inserted: true,
      };
    }),
  )
  .respondsTo(IOT_DB_INTENTS.alertInsert);

process.on("SIGTERM", () => {
  Cadenza.log("IoT DB Service shutting down gracefully.");
  process.exit(0);
});
