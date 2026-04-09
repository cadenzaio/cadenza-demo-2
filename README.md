# cadenza-demo-2

IoT demo stack for generating realistic distributed runtime metadata and data flows in Cadenza.

Additional reading:

- [docs/demo-lessons.md](./docs/demo-lessons.md)

## What this demo now validates

- canonical intent-driven orchestration (`iot-*` intents; current core disallows dots in inquiry names)
- canonical global event contracts (`global.iot.*` signals)
- actor-centric state handling
  - persisted session actors for domain state
  - runtime-only actors for infrastructure/cache state
- strict durable actor persistence through `actor_session_state`
- dual-database setup
  - `cadenza-db-service` for Cadenza metadata
  - `iot-db-service` for app telemetry/metrics/alerts

## Services

- `frontend` (`DemoFrontend`)
  - Nuxt 3 SSR app at `http://frontend.localhost`
  - uses `createSSRInquiryBridge(...)` for first render
  - starts a Nuxt wrapper runtime after hydration via `defineCadenzaNuxtRuntimePlugin(...)` from `@cadenza.io/service/nuxt`
  - reduces `global.iot.*` signals into projection state slices such as `liveFeed`
  - emits `iot-telemetry-ingest` directly from the browser for manual controls
- `cadenza-ui`
  - React console at `http://console.localhost`
  - uses `@cadenza.io/service/react`
  - bootstraps directly against `http://cadenza-db.localhost`
  - exposes `/business` for the business graph console and `/meta` as the reserved meta-console surface
- `scheduled-runner` (`ScheduledRunnerService`)
  - generates dummy telemetry traffic
  - calls `iot-telemetry-ingest`
  - owns runtime-only `TrafficRuntimeActor`
- `telemetry-collector` (`TelemetryCollectorService`)
  - responds to `iot-telemetry-ingest`
  - persists telemetry rows
  - calls anomaly + prediction intents
  - emits `global.iot.telemetry.ingested` and `global.iot.anomaly.detected` when needed
  - owns persisted `TelemetrySessionActor`
- `anomaly-detector` (`AnomalyDetectorService`)
  - responds to `iot-anomaly-detect`
  - computes anomaly from rolling runtime history
  - owns runtime-only `AnomalyRuntimeActor`
- `predictor` (`PredictorService`)
  - responds to `iot-prediction-compute`
  - persists `health_metric`
  - emits `global.iot.prediction.ready` or `global.iot.prediction.maintenance_needed`
  - owns persisted `PredictionSessionActor` + runtime-only `WeatherRuntimeActor`
- `alert-service` (`AlertService`)
  - responds to `iot-alert-evaluate`
  - subscribes to anomaly + maintenance signals
  - dedupes/escalates and persists `alert`
  - emits `global.iot.alert.raised`
  - owns persisted `AlertSessionActor`
- `iot-db-service` (`IotDbService`)
  - application DB service + internal DB intents:
    - `iot-db-telemetry-insert`
    - `iot-db-health-metric-insert`
    - `iot-db-alert-insert`
- `cadenza-db-service`
  - metadata DB service for graph + actor metadata/session state
- `edge`
  - local Node reverse proxy exposing one public origin per browser-reachable service

## Canonical Contracts

### Global signals

- `global.iot.telemetry.ingested`
- `global.iot.anomaly.detected`
- `global.iot.prediction.ready`
- `global.iot.prediction.maintenance_needed`
- `global.iot.alert.raised`

### Public intents

- `iot-telemetry-ingest`
- `iot-anomaly-detect`
- `iot-prediction-compute`
- `iot-alert-evaluate`
- `iot-telemetry-session-get`
- `iot-prediction-session-get`
- `iot-alert-session-get`

### Payload convention

- cross-service signal/intent payloads: camelCase (`deviceId`, `timestamp`, etc.)
- DB payload data/filter: table-aligned keys (`device_id`, `anomaly_score`, etc.)
- authoritative metrics table name: `health_metric` (singular)

## Run

```bash
docker-compose up --build
```

Open:

- `http://frontend.localhost`
- `http://console.localhost`
- `http://cadenza-db.localhost`
- `http://telemetry-collector.localhost`
- `http://anomaly-detector.localhost`
- `http://predictor.localhost`
- `http://alert-service.localhost`
- `http://iot-db.localhost`

Stop:

```bash
docker-compose down
```

Reset all data:

```bash
docker-compose down -v
```

## Useful checks

- list containers:

```bash
docker-compose ps
```

- follow logs:

```bash
docker-compose logs -f
```

- Postgres is reachable on `localhost:5433` (`iot_user` / `iot_pass`); the demo services create and use `cadenza_db` and `iot_db_service`
- the browser connects directly to service public transports through the `edge` proxy on `*.localhost`
- `cadenza-ui` is built from its own sibling repo and included in this demo stack as an additional browser-facing service
- the runner stays internal-only; its status is surfaced to the frontend during SSR

## Local Debug Workflow

- The releaseable default is published packages from npm:
  - `@cadenza.io/core ^3.26.1`
  - `@cadenza.io/service ^2.19.1`
  - `@cadenza.io/cadenza-db ^2.11.1`
- Release verification should prove all three layers of truth from the workspace root:
  - `python3 scripts/release_sync.py scan`
  - confirm demo package manifests show `matches-npm`
  - confirm lockfiles resolve to `published-source`
  - confirm installed packages either `match-lockfile` or are intentionally not installed yet
- For cross-repo debugging, the local tarball helper scripts can still temporarily rewrite package refs and hydrate ignored `vendor/` folders:
  - use `node scripts/local-cadenza-core.mjs sync` to rebuild and repack the sibling `cadenza` repo, refresh all demo `vendor/` copies, and refresh installed `node_modules` when present
  - use `node scripts/local-cadenza-core.mjs verify` to confirm vendored core tarballs and lockfiles still match the source tarball
  - use `node scripts/local-cadenza-core.mjs rebuild <service>` when you want the guarded core sync plus a targeted Docker rebuild
  - use `node scripts/local-cadenza-service.mjs sync` to rebuild and repack the sibling `cadenza-service` repo, refresh all demo `vendor/` copies, and refresh installed `node_modules` when present
  - use `node scripts/local-cadenza-service.mjs verify` to confirm vendored tarballs and lockfiles still match the source tarball
  - use `node scripts/local-cadenza-service.mjs rebuild <service>` when you want the guarded sync plus a targeted Docker rebuild
  - restore published package refs before merge or release verification; local tarballs are a debug detour, not the committed default
- Prefer the lowest-cost reproduction that can still prove the point:
  - if a flow is identical across services, iterate on `cadenza-db-service` plus one representative service first
  - do not rebuild the full stack unless the narrow fix is already proven
- Prefer targeted rebuilds over full-stack rebuilds:
  - `docker compose build <service>`
  - `docker compose up -d --force-recreate <service>`
  - prefer this over `docker compose up -d --build <service>` because it keeps build output and restart output separate and avoids token-heavy mixed logs
- Prefer tailed or grepped logs over streaming full build output:
  - `docker compose logs --tail 100 <service>`
  - `docker logs <container> 2>&1 | rg '<pattern>'`
- Prefer file-backed build output over streamed compose output:
  - `docker compose up -d --build <service> > /tmp/<service>-build.log 2>&1`
  - then inspect only `tail -n 40` or `rg` matches from that file
- Prefer direct authority snapshots over broad runtime log review when checking convergence:
  - query `cadenza_db` tables directly for `service`, `service_instance`, `task`, and `intent_to_task_map`
  - use runtime logs only to explain a specific missing row or failure edge
- Keep temporary traces extremely narrow and easy to remove:
  - gate them behind one service name, one env flag, or one failing flow
  - remove them once the branch is understood
- Keep high-volume debug flags such as `CADENZA_DB_TASK_DEBUG` disabled unless they are the specific focus of the current investigation.

## Notes

- `WEATHER_API_KEY` is optional; predictor falls back to neutral weather context when absent.
- the runner defaults to `TRAFFIC_MODE=low` and `DEVICE_COUNT=50`.
- the frontend server uses internal Docker service names for SSR bootstrap and `http://cadenza-db.localhost:80` for the hydrated browser runtime.
- topic-grouped demo lessons live in [docs/demo-lessons.md](./docs/demo-lessons.md)
