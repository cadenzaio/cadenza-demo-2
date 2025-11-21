import Cadenza from '@cadenza.io/service';
import { mockTelemetryEvent } from './scheduler.js';

// Cadenza Routine: Mock Telemetry Ingestion
// This routine is triggered by signals from the scheduler and mocks a device event
Cadenza.createRoutine(
  'MockTelemetryIngestion',
  [
    Cadenza.createTask(
      'GenerateRandomTelemetry',
      mockTelemetryEvent,
      'Generates random sensor data for a device'
    ).then(
      Cadenza.createDatabaseInsertTask("telemetry", "IotDbService"),
    ),
  ],
  'Mocks and delegates persistence of a telemetry event to kick off monitoring flows'
).doOn("runner.new_telemetry");

// Cadenza Routine: Trigger Health Check Flow
// Emits a signal to trigger the Health Check routine in Telemetry Collector
Cadenza.createRoutine(
  'TriggerHealthCheck',
  [
    Cadenza.createTask(
      'EmitHealthCheckSignal',
      async (ctx: any, emit: any) => {
        // Emit cross-service signal to Telemetry Collector
        emit('runner.health_check_triggered', {
          deviceId: ctx.deviceId,
          triggerType: 'scheduled',
        });
        Cadenza.log(`Emitted health check signal for device ${ctx.deviceId}`);
        return ctx;
      },
      'Emits a signal to trigger the Health Check flow'
    ),
  ],
  'Triggers the Health Check routine via signal'
).doOn("health.check");

// Cadenza Routine: Trigger Predictive Maintenance Flow
// Emits a signal to trigger Predictive Maintenance in Predictor Service
Cadenza.createRoutine(
  'TriggerPredictiveMaintenance',
  [
    Cadenza.createTask(
      'EmitPredictiveSignal',
      async (ctx: any, emit: any) => {
        emit('runner.predictive_maintenance_triggered', {
          deviceId: ctx.deviceId,
          recentAnomaly: ctx.anomalyFlag || false,
        });
        console.log(`Emitted predictive maintenance signal for device ${ctx.deviceId}`);
        return ctx;
      },
      'Emits a signal to trigger Predictive Maintenance'
    ),
  ],
  'Triggers Predictive Maintenance via signal'
).doOn("predictor.maintenance_needed");

// Cadenza Routine: Trigger Alert Escalation Flow
// Emitted reactively by signals from other services
Cadenza.createRoutine(
  'TriggerAlertEscalation',
  [
    Cadenza.createTask(
      'EmitEscalationSignal',
      async (ctx: any, emit: any) => {
        emit('runner.alert_escalation_triggered', {
          deviceId: ctx.deviceId,
          severity: ctx.severity,
          reason: ctx.reason,
        });
        console.log(`Emitted alert escalation signal for device ${ctx.deviceId}`);
        return ctx;
      },
      'Emits a signal to trigger Alert Escalation'
    ),
  ],
  'Triggers Alert Escalation via signal'
).doOn("health.alert_escalation");

async function runMockScheduler (ctx: any, emit: any) {
  const trafficMode = process.env.TRAFFIC_MODE || 'low';
  const deviceCount = parseInt(process.env.DEVICE_COUNT || '50');
  const now = new Date();

  // Simulate random device selection
  const deviceId = `device-${Math.floor(Math.random() * deviceCount) + 1}`;

  // Generate base random readings (with slight bias in high traffic for anomalies)
  const baseTemp = 20 + Math.random() * 60;
  const baseHumidity = 30 + Math.random() * 40;
  const battery = 50 + Math.random() * 50;

  // Apply anomaly simulation based on thresholds (more frequent in high traffic)
  const anomalyBias = trafficMode === 'high' ? 0.2 : 0.05; // Probability to exceed threshold
  let temperature = baseTemp;
  let humidity = baseHumidity;
  let anomalyFlag = false;
  let anomalyReason = '';

  // Temperature anomaly: >80°C (overheat) or <10°C (freeze)
  if (Math.random() < anomalyBias) {
    temperature = Math.random() < 0.5 ? baseTemp + 25 : baseTemp - 15; // Spike or drop
    anomalyFlag = temperature > 80 || temperature < 10;
    if (anomalyFlag) anomalyReason = `Temperature out of range: ${temperature}°C`;
  }

  // Humidity anomaly: >90% (condensation) or <20% (dry)
  if (!anomalyFlag && Math.random() < anomalyBias) {
    humidity = Math.random() < 0.5 ? baseHumidity + 65 : baseHumidity - 15; // Spike or drop
    anomalyFlag = humidity > 90 || humidity < 20;
    if (anomalyFlag) anomalyReason = `Humidity out of range: ${humidity}%`;
  }

  // Combined anomaly if both exceed (rare, for escalation testing)
  if (Math.random() < 0.02) { // 2% chance for dual anomaly
    temperature = Math.random() < 0.5 ? 85 : 5;
    humidity = Math.random() < 0.5 ? 95 : 15;
    anomalyFlag = true;
    anomalyReason = `Dual anomaly: Temp ${temperature}°C, Humidity ${humidity}%`;
  }

  const readings = { temperature, humidity, battery };

  const mockCtx = {
    deviceId,
    readings,
    timestamp: now,
    anomalyFlag,
    anomalyReason: anomalyReason || null
  };

  // Trigger Mock Telemetry Ingestion routine (delegates persistence to IotDbService)
  emit("runner.new_telemetry", mockCtx);

  // Randomly trigger flows based on mode and anomaly
  if (Math.random() < (trafficMode === 'high' ? 0.7 : 0.3)) {
    emit("health.check", { deviceId });
  }

  if (anomalyFlag && Math.random() < 0.5) {
    emit("predictor.maintenance_needed", { deviceId });
  }

  // Simulate reactive escalation (e.g., 10% chance on high anomaly)
  if (anomalyFlag && trafficMode === 'high' && Math.random() < 0.1) {
    emit("health.alert_escalation", {
      deviceId,
      severity: 'high',
      reason: anomalyReason || 'Anomaly spike detected',
    });
  }

  Cadenza.log(`Scheduler tick: Mocked event for ${deviceId} (anomaly: ${anomalyFlag ? 'yes (' + anomalyReason + ')' : 'no'})`);
  return { success: true, eventsGenerated: 1 };
}

// Scheduler Task: Runs periodically to mock events and trigger flows
Cadenza.createTask(
  'RunMockScheduler',
  runMockScheduler,
  'Runs the mock scheduler to generate events and trigger flows'
).doOn("tick.started");

// Cadenza Service Setup
Cadenza.createCadenzaService('ScheduledRunnerService', 'Mocks IoT device events and triggers monitoring flows', {
  cadenzaDB: {
    connect: true,
    address: process.env.CADENZA_DB_ADDRESS || 'cadenza-db-service',
    port: parseInt(process.env.CADENZA_DB_PORT || '8080'),
  },
});

// Manual emit after a delay (or hook into connect promise if exposed)
setTimeout(() => {
  // @ts-ignore
  process.emit('cadenza-ready');
}, 60000);  // Adjust delay based on init time

// Start the cron scheduler after Cadenza initializes
process.on('cadenza-ready', () => {
  Cadenza.log('Cadenza ready—starting dynamic traffic simulator');

  const simulateTick = async () => {
    // Emit signal to trigger the mock scheduler task
    if (Math.random() < 0.1) {
      for (let i = 0; i < Math.floor(Math.random() * 100); i++) {
        Cadenza.emit("tick.started", {});
      }
    }
    Cadenza.emit("tick.started", {});

    const minDelay = 1000;
    const maxDelay = 200000;

    const nextDelay = minDelay + Math.random() * (maxDelay - minDelay);

    Cadenza.log(`Dynamic tick complete. Next tick in ${(nextDelay / 1000).toFixed(0)} seconds.`);

    // Schedule next tick
    setTimeout(simulateTick, nextDelay);
  };

  // Start the first tick immediately
  simulateTick();
});

console.log('Listening for cadenza-ready event');