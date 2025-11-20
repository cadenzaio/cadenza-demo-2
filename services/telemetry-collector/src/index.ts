import Cadenza from '@cadenza.io/service';

const validateTask = Cadenza.createTask(
    'ValidateTelemetry',
    (ctx: any, emit: any) => {
      // Basic validation (e.g., required fields, range checks)
      if (!ctx.deviceId || !ctx.telemetry || typeof ctx.telemetry.readings?.temperature !== 'number') {
        throw new Error('Invalid telemetry data');
      }
      // Emit local signal for validation status
      emit('tememetry.data_validated', { valid: true, deviceId: ctx.deviceId });
      Cadenza.log(`Validated telemetry for device ${ctx.deviceId}`);
      return ctx;
    },
    'Validates incoming telemetry data and emits local validation signal'
  ).then(
    Cadenza.createTask(
      'FilterOutliers',
      (ctx: any, emit: any) => {
        const telemetry = ctx.telemetry;
        // Simple outlier filtering (e.g., >3 std devs from mean; mock mean=50 for demo)
        const tempZScore = Math.abs(telemetry.readings.temperature - 50) / 20; // Mock std dev=20
        if (tempZScore > 3) {
          ctx.filtered = false;
          emit('telemetry.outlier_detected', { deviceId: ctx.deviceId, metric: 'temperature' });
          Cadenza.log(`Filtered outlier for device ${ctx.deviceId}: temp=${telemetry.readings.temperature}`);
          return { ...ctx, filtered: false };
        }
        ctx.filtered = true;
        return ctx;
      },
      'Filters outliers and emits local outlier signal if needed'
    ).then(
      Cadenza.createDeputyTask(
        'CheckAnomaly',
        'AnomalyDetector',
        { concurrency: 1 },
      ),
    ),
  );

// Cadenza Routine: Health Check (triggered by 'health_check_triggered' signal)
// Validates data, fan-out yields parallel anomaly checks via DeputyTasks, fan-in unique task to merge, delegates persistence
Cadenza.createRoutine(
  'HealthCheck',
  [validateTask],
  'Full health check: validate, fan-out anomaly checks, fan-in merge, persist'
).doOn("IotDbService.telemetry.inserted");

// Cadenza Routine: Handle Reactive Signals (e.g., from Predictor for re-check)
// Example: If prediction indicates high risk, re-run health check
Cadenza.createRoutine(
  'ReactiveHealthCheck',
  [
    Cadenza.createTask(
      'RevalidateTelemetry',
      (ctx: any, emit: any) => {
        // Re-validation logic (e.g., fetch latest from shared_telemetry or DB)
        emit('telemetry.recheck_initiated', { deviceId: ctx.deviceId });
        return ctx;
      },
      'Re-validates telemetry on reactive signal'
    ).then(validateTask),  // Chain to main health check
  ],
  'Reactive health check triggered by signals (e.g., high prediction risk)'
).doOn("ScheduledRunnerService.runner.health_check_triggered");

// Cadenza Service Setup
Cadenza.createCadenzaService('TelemetryCollectorService', 'Ingests and validates IoT telemetry, fan-out to anomaly detection', {
  cadenzaDB: {
    connect: true,
    address: process.env.CADENZA_DB_ADDRESS || 'cadenza-db-service',
    port: parseInt(process.env.CADENZA_DB_PORT || '8080'),
  },
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Telemetry Collector shutting down gracefully');
  process.exit(0);
});
