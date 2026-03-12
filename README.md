# cadenza-demo-2

IoT demo stack for generating realistic distributed runtime metadata and data flows in Cadenza.

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

## Notes

- `WEATHER_API_KEY` is optional; predictor falls back to neutral weather context when absent.
- the runner defaults to `TRAFFIC_MODE=low` and `DEVICE_COUNT=50`.
