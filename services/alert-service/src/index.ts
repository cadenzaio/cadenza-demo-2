import Cadenza from "@cadenza.io/service";
import { randomUUID } from "node:crypto";
import {
  IOT_DB_INTENTS,
  IOT_INTENTS,
  IOT_SIGNALS,
  type AlertEvaluatePayload,
} from "./contracts.js";

const publicOrigin =
  process.env.PUBLIC_ORIGIN ?? "http://alert-service.localhost";
const internalOrigin = `http://${process.env.CADENZA_SERVER_URL ?? "alert-service"}:${
  process.env.HTTP_PORT ?? "3006"
}`;

type AlertSessionState = {
  isOpen: boolean;
  lastSeverity: "low" | "medium" | "high";
  lastReason: string | null;
  lastRaisedAt: string | null;
  lastResolvedAt: string | null;
  raiseCount: number;
  dedupeCount: number;
};

const dedupeWindowMs = 5 * 60 * 1000;

function severityRank(severity: "low" | "medium" | "high"): number {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function normalizeSeverity(value: unknown): "low" | "medium" | "high" {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }

  return "medium";
}

const alertSessionActor = Cadenza.createActor<AlertSessionState>({
  name: "AlertSessionActor",
  description:
    "Per-device-and-type durable alert session state with dedupe/escalation bookkeeping.",
  defaultKey: "device:unknown:prediction",
  keyResolver: (input: any) => {
    const deviceId =
      typeof input?.deviceId === "string" ? input.deviceId.trim() : "";
    const type = typeof input?.type === "string" ? input.type.trim() : "prediction";

    return deviceId ? `${deviceId}:${type}` : undefined;
  },
  initState: {
    isOpen: false,
    lastSeverity: "low",
    lastReason: null,
    lastRaisedAt: null,
    lastResolvedAt: null,
    raiseCount: 0,
    dedupeCount: 0,
  },
  session: {
    // Keep demo session state runtime-only until actor-session hydration exists.
    persistDurableState: false,
    persistenceTimeoutMs: 30000,
  },
});

const normalizeAlertInputTask = Cadenza.createTask(
  "Normalize alert evaluation input",
  (ctx: any) => {
    const deviceId = typeof ctx.deviceId === "string" ? ctx.deviceId.trim() : "";
    const type =
      ctx.type === "anomaly" || ctx.type === "prediction" || ctx.type === "escalation"
        ? ctx.type
        : "prediction";
    const reason =
      typeof ctx.reason === "string" && ctx.reason.trim().length > 0
        ? ctx.reason.trim()
        : "No reason provided";
    const severity = normalizeSeverity(ctx.severity);
    const timestamp =
      typeof ctx.timestamp === "string" && ctx.timestamp.length > 0
        ? ctx.timestamp
        : new Date().toISOString();

    if (!deviceId) {
      throw new Error("deviceId is required for iot-alert-evaluate");
    }

    const payload: AlertEvaluatePayload = {
      deviceId,
      type,
      severity,
      reason,
      timestamp,
    };

    return {
      ...ctx,
      ...payload,
      payload,
    };
  },
  "Normalizes canonical alert-evaluation payload and enforces required fields.",
);

const evaluateAlertSessionTask = Cadenza.createTask(
  "Evaluate alert dedupe and escalation",
  alertSessionActor.task(
    ({ input, state, setState }) => {
      const previousRaisedAtMs = state.lastRaisedAt ? Date.parse(state.lastRaisedAt) : 0;
      const currentTimestampMs = Date.parse(input.timestamp);

      const withinDedupeWindow =
        Number.isFinite(previousRaisedAtMs) &&
        Number.isFinite(currentTimestampMs) &&
        currentTimestampMs - previousRaisedAtMs <= dedupeWindowMs;

      const sameSeverity = state.lastSeverity === input.severity;
      const sameReason = state.lastReason === input.reason;

      const deduped = state.isOpen && withinDedupeWindow && sameSeverity && sameReason;
      const escalated =
        !deduped && severityRank(input.severity) > severityRank(state.lastSeverity);
      const shouldRaise = !deduped;

      const nextState: AlertSessionState = {
        ...state,
        isOpen: shouldRaise ? true : state.isOpen,
        lastSeverity: shouldRaise ? input.severity : state.lastSeverity,
        lastReason: shouldRaise ? input.reason : state.lastReason,
        lastRaisedAt: shouldRaise ? input.timestamp : state.lastRaisedAt,
        lastResolvedAt: state.lastResolvedAt,
        raiseCount: shouldRaise ? state.raiseCount + 1 : state.raiseCount,
        dedupeCount: deduped ? state.dedupeCount + 1 : state.dedupeCount,
      };

      setState(nextState);

      return {
        ...input,
        shouldRaise,
        deduped,
        escalated,
        session: nextState,
      };
    },
    { mode: "write" },
  ),
  "Applies dedupe/escalation rules and writes durable alert session actor state.",
);

const persistAlertRowTask = Cadenza.createTask(
  "Persist alert via IoT DB intent",
  async (ctx: any, _emit: any, inquire: any) => {
    if (!ctx.shouldRaise) {
      return {
        ...ctx,
        persisted: false,
      };
    }

    const payload =
      ctx.queryData ??
      (ctx.data ? { data: ctx.data } : undefined) ??
      {
        data: {
          uuid: randomUUID(),
          device_id: ctx.deviceId,
          timestamp: ctx.timestamp,
          type: ctx.type,
          severity: ctx.severity,
          reason: ctx.reason,
          resolved: false,
        },
      };
    const result = await inquire(IOT_DB_INTENTS.alertInsert, payload, {
      requireComplete: true,
      rejectOnTimeout: true,
      timeout: 10000,
    });

    return {
      ...ctx,
      ...(typeof result === "object" && result ? result : {}),
    };
  },
  "Persists alert rows through the generated IoT DB insert intent.",
);

const persistAlertIfNeededTask = Cadenza.createTask(
  "Prepare alert persistence",
  (ctx: any) => {
    if (!ctx.shouldRaise) {
      return {
        ...ctx,
        persisted: false,
        __skipRemoteExecution: true,
      };
    }

    const insertData = {
      uuid: randomUUID(),
      device_id: ctx.deviceId,
      timestamp: ctx.timestamp,
      type: ctx.type,
      severity: ctx.severity,
      reason: ctx.reason,
      resolved: false,
    };

    return {
      ...ctx,
      persisted: true,
      data: insertData,
      queryData: {
        ...(ctx.queryData ?? {}),
        data: insertData,
      },
    };
  },
  "Prepares conditional alert persistence for the IoT DB service.",
);

const emitAlertSignalTask = Cadenza.createTask(
  "Emit canonical alert raised signal",
  (ctx: any, emit: any) => {
    if (ctx.shouldRaise) {
      emit(IOT_SIGNALS.alertRaised, {
        deviceId: ctx.deviceId,
        type: ctx.type,
        severity: ctx.severity,
        reason: ctx.reason,
        timestamp: ctx.timestamp,
        escalated: Boolean(ctx.escalated),
      });
    }

    return ctx;
  },
  "Emits global.iot.alert.raised for raised alerts.",
).attachSignal(IOT_SIGNALS.alertRaised);

const finalizeAlertEvaluationTask = Cadenza.createTask(
  "Finalize alert evaluation response",
  (ctx: any) => {
    return {
      __success: true,
      deviceId: ctx.deviceId,
      type: ctx.type,
      severity: ctx.severity,
      reason: ctx.reason,
      timestamp: ctx.timestamp,
      raised: Boolean(ctx.shouldRaise),
      deduped: Boolean(ctx.deduped),
      escalated: Boolean(ctx.escalated),
      persisted: Boolean(ctx.persisted),
      session: ctx.session,
    };
  },
  "Builds canonical iot-alert-evaluate response payload.",
);

normalizeAlertInputTask.then(evaluateAlertSessionTask);
evaluateAlertSessionTask.then(persistAlertIfNeededTask);
persistAlertIfNeededTask.then(persistAlertRowTask);
persistAlertRowTask.then(emitAlertSignalTask);
emitAlertSignalTask.then(finalizeAlertEvaluationTask);
normalizeAlertInputTask.respondsTo(IOT_INTENTS.alertEvaluate);

Cadenza.createTask(
  "Evaluate alert from anomaly signal",
  async (ctx: any, _emit: any, inquire: any) => {
    const severity =
      Number(ctx.anomalyScore ?? 0) >= 0.85
        ? "high"
        : Number(ctx.anomalyScore ?? 0) >= 0.65
          ? "medium"
          : "low";

    return inquire(
      IOT_INTENTS.alertEvaluate,
      {
        deviceId: ctx.deviceId,
        type: "anomaly",
        severity,
        reason: ctx.reason ?? "Anomaly detected",
        timestamp: ctx.timestamp ?? new Date().toISOString(),
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    );
  },
  "Subscribes to anomaly-detected signal and evaluates alert rules.",
).doOn(IOT_SIGNALS.anomalyDetected);

Cadenza.createTask(
  "Evaluate alert from maintenance signal",
  async (ctx: any, _emit: any, inquire: any) => {
    return inquire(
      IOT_INTENTS.alertEvaluate,
      {
        deviceId: ctx.deviceId,
        type: "prediction",
        severity: "high",
        reason:
          ctx.reason ?? "Failure probability exceeded maintenance threshold",
        timestamp: ctx.timestamp ?? new Date().toISOString(),
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: 10000,
      },
    );
  },
  "Subscribes to prediction-maintenance signal and evaluates alert rules.",
).doOn(IOT_SIGNALS.predictionMaintenanceNeeded);

Cadenza.createTask(
  "Get alert session state",
  alertSessionActor.task(
    ({ actor, state }) => ({
      __success: true,
      actorKey: actor.key,
      session: state,
    }),
    { mode: "read" },
  ),
  "Returns persisted alert actor session state by device/type key.",
).respondsTo(IOT_INTENTS.alertSessionGet);

Cadenza.createCadenzaService(
  "AlertService",
  "Evaluates alert dedupe/escalation rules and persists canonical alert events.",
  {
    useSocket: false,
    cadenzaDB: {
      connect: true,
      address: process.env.CADENZA_DB_ADDRESS ?? "cadenza-db-service",
      port: parseInt(process.env.CADENZA_DB_PORT ?? "8080", 10),
    },
    transports: [
      {
        role: "internal",
        origin: internalOrigin,
        protocols: ["rest"],
      },
      {
        role: "public",
        origin: publicOrigin,
        protocols: ["rest"],
      },
    ],
  },
);
