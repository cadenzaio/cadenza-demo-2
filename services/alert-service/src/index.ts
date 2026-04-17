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
const META_ACTOR_SESSION_STATE_HYDRATE_INTENT = "meta-actor-session-state-hydrate";
const META_ACTOR_SESSION_STATE_PERSIST_INTENT = "meta-actor-session-state-persist";
const ALERT_SESSION_PERSIST_SIGNAL =
  "meta.demo.alert.session_persist_requested";
const ALERT_SESSION_PERSIST_TIMEOUT_MS = 10_000;
const ALERT_SESSION_FLUSH_DEBOUNCE_MS = 30_000;
const ALERT_SESSION_RETRY_BASE_MS = 1_000;
const ALERT_SESSION_RETRY_MAX_MS = 30_000;
const ALERT_SESSION_ACTOR_NAME = "AlertSessionActor";
const ALERT_SESSION_ACTOR_VERSION = 1;

type AlertSessionState = {
  isOpen: boolean;
  lastSeverity: "low" | "medium" | "high";
  lastReason: string | null;
  lastRaisedAt: string | null;
  lastResolvedAt: string | null;
  raiseCount: number;
  dedupeCount: number;
};

type AlertSessionRuntimeState = AlertSessionState & {
  __hydrated: boolean;
  __durableVersion: number;
  __persistenceDeferred: boolean;
  __lastPersistenceError: string | null;
};

type PendingAlertSessionFlush = {
  actorKey: string;
  durableState: AlertSessionState;
  durableVersion: number;
  retryDelayMs: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type CadenzaInquiry = (
  inquiryName: string,
  context: Record<string, unknown>,
  options: any,
) => Promise<any>;

const hydratedAlertSessionKeys = new Set<string>();
const pendingAlertSessionHydrations = new Map<
  string,
  Promise<AlertSessionRuntimeState>
>();
const pendingAlertSessionFlushes = new Map<string, PendingAlertSessionFlush>();
let latestAlertSessionInquire: CadenzaInquiry | null = null;

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

const alertSessionActor = Cadenza.createActor<AlertSessionRuntimeState>({
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
    __hydrated: false,
    __durableVersion: 0,
    __persistenceDeferred: false,
    __lastPersistenceError: null,
  },
  session: {
    persistDurableState: false,
  },
});

function buildDefaultAlertSessionState(): AlertSessionState {
  return {
    isOpen: false,
    lastSeverity: "low",
    lastReason: null,
    lastRaisedAt: null,
    lastResolvedAt: null,
    raiseCount: 0,
    dedupeCount: 0,
  };
}

function createAlertSessionRuntimeState(
  state: Partial<AlertSessionState> | null | undefined,
  durableVersion = 0,
  options: Partial<
    Pick<
      AlertSessionRuntimeState,
      "__hydrated" | "__persistenceDeferred" | "__lastPersistenceError"
    >
  > = {},
): AlertSessionRuntimeState {
  const base = buildDefaultAlertSessionState();

  return {
    ...base,
    ...(state ?? {}),
    isOpen: Boolean(state?.isOpen ?? base.isOpen),
    lastSeverity: normalizeSeverity(state?.lastSeverity),
    lastReason: typeof state?.lastReason === "string" ? state.lastReason : null,
    lastRaisedAt:
      typeof state?.lastRaisedAt === "string" ? state.lastRaisedAt : null,
    lastResolvedAt:
      typeof state?.lastResolvedAt === "string" ? state.lastResolvedAt : null,
    raiseCount: Number(state?.raiseCount ?? base.raiseCount),
    dedupeCount: Number(state?.dedupeCount ?? base.dedupeCount),
    __hydrated: options.__hydrated ?? true,
    __durableVersion: Math.max(0, Number(durableVersion) || 0),
    __persistenceDeferred: options.__persistenceDeferred ?? false,
    __lastPersistenceError: options.__lastPersistenceError ?? null,
  };
}

function stripAlertSessionRuntimeState(
  state: Partial<AlertSessionRuntimeState> | null | undefined,
): AlertSessionState {
  const runtime = createAlertSessionRuntimeState(
    state ?? null,
    state?.__durableVersion ?? 0,
  );

  return {
    isOpen: runtime.isOpen,
    lastSeverity: runtime.lastSeverity,
    lastReason: runtime.lastReason,
    lastRaisedAt: runtime.lastRaisedAt,
    lastResolvedAt: runtime.lastResolvedAt,
    raiseCount: runtime.raiseCount,
    dedupeCount: runtime.dedupeCount,
  };
}

function shouldTreatAlertSessionAsHydrated(
  state: Partial<AlertSessionRuntimeState> | null | undefined,
): boolean {
  return state?.__hydrated === true;
}

function describeInquiryError(error: unknown): string[] {
  const values: string[] = [];
  const seen = new Set<unknown>();

  const collect = (value: unknown, depth = 3) => {
    if (depth < 0 || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      values.push(value);
      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      values.push(String(value));
      return;
    }

    if (typeof value !== "object" || seen.has(value)) {
      return;
    }

    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collect(nested, depth - 1);
    }
  };

  collect(error);
  return values.length > 0 ? values : [String(error)];
}

function isManagedAlertSessionPersistenceRecoveryError(error: unknown): boolean {
  const values = describeInquiryError(error).join(" | ");

  return (
    values.includes("No routeable internal transport available") ||
    values.includes("Waiting for authority route updates before retrying") ||
    values.includes("ECONNREFUSED") ||
    values.includes("ENOTFOUND") ||
    values.includes("timed out") ||
    values.includes("failed, reason:")
  );
}

function buildAlertActorKey(input: any): string {
  const deviceId = typeof input?.deviceId === "string" ? input.deviceId.trim() : "";
  const type = typeof input?.type === "string" ? input.type.trim() : "prediction";
  return deviceId ? `${deviceId}:${type}` : "";
}

function scheduleAlertSessionFlush(
  pending: PendingAlertSessionFlush,
  delayMs: number,
): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    pending.timer = null;
    void flushAlertSession(pending.actorKey);
  }, delayMs);
  pending.timer.unref?.();
}

async function flushAlertSession(actorKey: string): Promise<void> {
  const pending = pendingAlertSessionFlushes.get(actorKey);
  if (!pending || pending.inFlight) {
    return;
  }

  const inquire = latestAlertSessionInquire;
  if (!inquire) {
    scheduleAlertSessionFlush(pending, pending.retryDelayMs);
    return;
  }

  const snapshotVersion = pending.durableVersion;
  const snapshotState = pending.durableState;
  pending.inFlight = true;

  try {
    const result = await inquire(
      META_ACTOR_SESSION_STATE_PERSIST_INTENT,
      {
        actor_name: ALERT_SESSION_ACTOR_NAME,
        actor_key: actorKey,
        actor_version: ALERT_SESSION_ACTOR_VERSION,
        durable_state: snapshotState,
        durable_version: snapshotVersion,
      },
      {
        requireComplete: true,
        rejectOnTimeout: true,
        timeout: ALERT_SESSION_PERSIST_TIMEOUT_MS,
      },
    );

    if (
      result &&
      typeof result === "object" &&
      (result.errored === true || result.failed === true || result.__success === false)
    ) {
      throw result;
    }

    const current = pendingAlertSessionFlushes.get(actorKey);
    if (!current) {
      return;
    }

    current.inFlight = false;
    current.retryDelayMs = ALERT_SESSION_RETRY_BASE_MS;

    if (current.durableVersion <= snapshotVersion) {
      pendingAlertSessionFlushes.delete(actorKey);
      return;
    }

    scheduleAlertSessionFlush(current, ALERT_SESSION_FLUSH_DEBOUNCE_MS);
  } catch (error) {
    const current = pendingAlertSessionFlushes.get(actorKey);
    if (!current) {
      return;
    }

    current.inFlight = false;
    current.retryDelayMs = Math.min(
      Math.max(current.retryDelayMs, ALERT_SESSION_RETRY_BASE_MS) * 2,
      ALERT_SESSION_RETRY_MAX_MS,
    );

    if (!isManagedAlertSessionPersistenceRecoveryError(error)) {
      current.retryDelayMs = ALERT_SESSION_RETRY_MAX_MS;
    }

    scheduleAlertSessionFlush(current, current.retryDelayMs);
  }
}

function queueAlertSessionFlush(
  actorKey: string,
  state: AlertSessionRuntimeState,
  inquire: CadenzaInquiry,
): AlertSessionRuntimeState {
  latestAlertSessionInquire = inquire;

  const durableState = stripAlertSessionRuntimeState(state);
  const durableVersion = state.__durableVersion;
  const existing = pendingAlertSessionFlushes.get(actorKey);

  if (existing) {
    existing.durableState = durableState;
    existing.durableVersion = durableVersion;

    if (!existing.inFlight) {
      existing.retryDelayMs = ALERT_SESSION_RETRY_BASE_MS;
      scheduleAlertSessionFlush(existing, ALERT_SESSION_FLUSH_DEBOUNCE_MS);
    }
  } else {
    const pending: PendingAlertSessionFlush = {
      actorKey,
      durableState,
      durableVersion,
      retryDelayMs: ALERT_SESSION_RETRY_BASE_MS,
      inFlight: false,
      timer: null,
    };
    pendingAlertSessionFlushes.set(actorKey, pending);
    scheduleAlertSessionFlush(pending, ALERT_SESSION_FLUSH_DEBOUNCE_MS);
  }

  return {
    ...state,
    __persistenceDeferred: true,
    __lastPersistenceError: null,
  };
}

async function loadDurableAlertSessionState(
  actorKey: string,
  inquire: CadenzaInquiry,
): Promise<AlertSessionRuntimeState> {
  if (hydratedAlertSessionKeys.has(actorKey)) {
    return createAlertSessionRuntimeState(undefined, 0, { __hydrated: false });
  }

  const existing = pendingAlertSessionHydrations.get(actorKey);
  if (existing) {
    return existing;
  }

  const hydration = (async () => {
    try {
      const result = await inquire(
        META_ACTOR_SESSION_STATE_HYDRATE_INTENT,
        {
          actor_name: ALERT_SESSION_ACTOR_NAME,
          actor_key: actorKey,
          actor_version: ALERT_SESSION_ACTOR_VERSION,
        },
        {
          requireComplete: true,
          rejectOnTimeout: true,
          timeout: ALERT_SESSION_PERSIST_TIMEOUT_MS,
        },
      );

      if (
        result &&
        typeof result === "object" &&
        result.__success === true &&
        result.hydrated === true
      ) {
        return createAlertSessionRuntimeState(
          result.durable_state as Partial<AlertSessionState>,
          Number(result.durable_version ?? 0),
        );
      }
    } catch (error) {
      return createAlertSessionRuntimeState(undefined, 0, {
        __persistenceDeferred: true,
        __lastPersistenceError: describeInquiryError(error)[0] ?? null,
      });
    } finally {
      pendingAlertSessionHydrations.delete(actorKey);
    }

    return createAlertSessionRuntimeState(undefined, 0);
  })();

  pendingAlertSessionHydrations.set(actorKey, hydration);
  return hydration;
}

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

const prepareAlertSessionContextTask = Cadenza.createTask(
  "Prepare alert session context",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const actorKey = buildAlertActorKey(ctx);

    if (!actorKey) {
      throw new Error("deviceId is required for alert session state");
    }

    if (hydratedAlertSessionKeys.has(actorKey)) {
      return {
        ...ctx,
        __alertActorKey: actorKey,
      };
    }

    return {
      ...ctx,
      __alertActorKey: actorKey,
      hydratedAlertSessionState: await loadDurableAlertSessionState(actorKey, inquire),
    };
  },
  "Hydrates durable alert session state once per actor key without blocking later outages.",
);

const prepareAlertSessionReadContextTask = Cadenza.createTask(
  "Prepare alert session read context",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const actorKey = buildAlertActorKey(ctx);

    if (!actorKey) {
      throw new Error("deviceId is required for alert session state");
    }

    if (hydratedAlertSessionKeys.has(actorKey)) {
      return {
        ...ctx,
        __alertActorKey: actorKey,
      };
    }

    return {
      ...ctx,
      __alertActorKey: actorKey,
      hydratedAlertSessionState: await loadDurableAlertSessionState(actorKey, inquire),
    };
  },
  "Hydrates durable alert session state for read requests without blocking later outages.",
);

const evaluateAlertSessionTask = Cadenza.createTask(
  "Evaluate alert dedupe and escalation",
  alertSessionActor.task(
    ({ actor, input, state, setState }) => {
      const baseState = state.__hydrated
        ? state
        : createAlertSessionRuntimeState(
            input.hydratedAlertSessionState,
            input.hydratedAlertSessionState?.__durableVersion ?? 0,
          );
      const previousRaisedAtMs = baseState.lastRaisedAt
        ? Date.parse(baseState.lastRaisedAt)
        : 0;
      const currentTimestampMs = Date.parse(input.timestamp);

      const withinDedupeWindow =
        Number.isFinite(previousRaisedAtMs) &&
        Number.isFinite(currentTimestampMs) &&
        currentTimestampMs - previousRaisedAtMs <= dedupeWindowMs;

      const sameSeverity = baseState.lastSeverity === input.severity;
      const sameReason = baseState.lastReason === input.reason;

      const deduped =
        baseState.isOpen && withinDedupeWindow && sameSeverity && sameReason;
      const escalated =
        !deduped && severityRank(input.severity) > severityRank(baseState.lastSeverity);
      const shouldRaise = !deduped;

      const nextState = createAlertSessionRuntimeState(
        {
          ...baseState,
          isOpen: shouldRaise ? true : baseState.isOpen,
          lastSeverity: shouldRaise ? input.severity : baseState.lastSeverity,
          lastReason: shouldRaise ? input.reason : baseState.lastReason,
          lastRaisedAt: shouldRaise ? input.timestamp : baseState.lastRaisedAt,
          lastResolvedAt: baseState.lastResolvedAt,
          raiseCount: shouldRaise ? baseState.raiseCount + 1 : baseState.raiseCount,
          dedupeCount: deduped ? baseState.dedupeCount + 1 : baseState.dedupeCount,
        },
        baseState.__durableVersion + 1,
      );

      hydratedAlertSessionKeys.add(actor.key);
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
  "Applies dedupe/escalation rules and updates local alert session actor state.",
);

const persistAlertSessionBestEffortTask = Cadenza.createTask(
  "Persist alert session state best effort",
  async (ctx: any, _emit: any, inquire: CadenzaInquiry) => {
    const actorKey = buildAlertActorKey(ctx);
    if (!ctx.session || !actorKey) {
      return ctx;
    }

    const nextState = queueAlertSessionFlush(
      actorKey,
      ctx.session as AlertSessionRuntimeState,
      inquire,
    );

    return {
      ...ctx,
      session: nextState,
      sessionPersistenceDeferred: nextState.__persistenceDeferred,
      sessionPersistenceReason: nextState.__persistenceDeferred
        ? "alert_session_persist_deferred"
        : null,
    };
  },
  "Queues the latest alert session snapshot for durable persistence without blocking evaluation.",
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
      session: stripAlertSessionRuntimeState(ctx.session),
    };
  },
  "Builds canonical iot-alert-evaluate response payload.",
);

normalizeAlertInputTask.then(prepareAlertSessionContextTask);
prepareAlertSessionContextTask.then(evaluateAlertSessionTask);
evaluateAlertSessionTask.then(persistAlertIfNeededTask);
evaluateAlertSessionTask.then(persistAlertSessionBestEffortTask);
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

const getAlertSessionStateTask = Cadenza.createTask(
  "Get alert session state",
  alertSessionActor.task(
    ({ actor, input, state, setState }) => {
      const nextState = state.__hydrated
        ? state
        : createAlertSessionRuntimeState(
            input.hydratedAlertSessionState,
            input.hydratedAlertSessionState?.__durableVersion ?? 0,
          );

      if (!state.__hydrated && shouldTreatAlertSessionAsHydrated(nextState)) {
        hydratedAlertSessionKeys.add(actor.key);
        setState(nextState);
      }

      return {
        __success: true,
        actorKey: actor.key,
        session: stripAlertSessionRuntimeState(nextState),
      };
    },
    { mode: "write" },
  ),
  "Returns persisted alert actor session state by device/type key.",
);

prepareAlertSessionReadContextTask.then(getAlertSessionStateTask);
prepareAlertSessionReadContextTask.respondsTo(IOT_INTENTS.alertSessionGet);

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
