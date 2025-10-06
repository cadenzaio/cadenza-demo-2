# IoT Device Health Monitor Demo with Cadenza

## Overview

This demo showcases an IoT device health monitoring system built with Cadenza, simulating a fleet of 50 virtual sensors (e.g., temperature/humidity devices). The system ingests mock telemetry data, detects anomalies, predicts failures using environmental context (via OpenWeatherMap API), and escalates alerts. It's designed to generate continuous, realistic data streams for the Cadenza UI, demonstrating features like fan-out/yield for parallel processing, fan-in unique tasks for aggregation, DeputyTasks for delegation, and local/cross-service signals for coordination.

Key flows:
- **Health Check**: Validates and filters data, fan-out to anomaly detectors, fan-in to score.
- **Predictive Maintenance**: Aggregates anomalies with weather data, computes failure probability/ETA.
- **Alert Escalation**: Fan-in notifications, triggers on high-risk signals.

The Scheduled Runner mocks events at random intervals (low: every 5 min; high: every 1 min) to simulate traffic, producing ~400-3K events/hour. Data persists in PostgreSQL for UI querying.

## Architecture and Services

- **CadenzaDB**: Meta-orchestration for graphs, tasks, and signals.
- **IoT DB Service**: Cadenza-wrapped PostgreSQL interactions (DatabaseTasks for inserts/queries on telemetry, metrics, alerts).
- **Telemetry Collector** (3 replicas): Ingests/validates data, fan-out to detectors, reacts to `telementry.inserted` signals.
- **Anomaly Detector** (4 replicas): Statistical analysis (Z-score) on metrics, emits `anomaly_detected` signals.
- **Predictor** (2 replicas): Fan-out history/weather fetch, fan-in to predict failures, emits `maintenance_needed`.
- **Alert Service** (3 replicas): Notification queuing, fan-in prioritization, emits escalation signals.
- **Scheduled Runner** (1 instance): Mocks events via cron, emits signals to trigger flows (e.g., `runner.new_telemetry`).

Volumes: `iot_pgdata` (DB persistence), `shared_telemetry` (in-memory logs/signals). Network: `iot-network` for internal comms.

## Requirements

- Docker & Docker Compose (v2+)
- Node.js 22 (for local dev/testing)
- Free OpenWeatherMap API key (optional; set `WEATHER_API_KEY` in predictor `.env` for external calls)
- ~2GB RAM/4 cores for full replicas (scales down for testing)

Clone the repo and ensure directories match (`core-demo/database`, `core-demo/services/*`, `core-demo/runner`).

## Setup and Run Commands

1. **Full Startup** (builds/restarts everything, including DB init):
   ```
   docker-compose down -v  # Clean volumes if needed (WARNING: deletes DB data)
   docker-compose up --build
   ```

2. **View Logs** (all services):
   ```
   docker-compose logs -f
   ```

3. **Restart Specific Service** (e.g., telemetry-collector; rebuilds if code changed):
   ```
   docker-compose up --build telemetry-collector
   ```

4. **Restart All Services Except DB** (preserves data; rebuilds if needed):
   ```
   docker-compose up --build cadenza-db-service iot-db-service telemetry-collector anomaly-detector predictor alert-service scheduled-runner
   ```

5. **Scale Traffic** (high for bursts; restart runner):
   ```
   docker-compose restart scheduled-runner  # Or set TRAFFIC_MODE=high in runner/.env and up --build
   ```

6. **Stop/Teardown** (keeps DB data):
   ```
   docker-compose down  # No -v to preserve pgdata
   ```

## Monitoring and Testing

- **Check Replicas**: `docker-compose ps` (e.g., 3 telemetry-collector_* instances).
- **Test Signal Flow**: Logs show emissions (e.g., "Emitted health check signal") and triggers.
- **Query DB**: Connect to `localhost:5433` (user: iot_user, pass: iot_pass) to verify telemetry inserts.
- **UI Data**: Query CadenzaDB for signals/events; ~400 events/hour in low mode.

For dev: Edit code, rebuild specific service. Extend with more devices or APIs as needed. Issues? Check logs or CadenzaDB connections.