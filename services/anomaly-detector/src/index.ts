import Cadenza from '@cadenza.io/service';

const summaryTask = Cadenza.createUniqueTask(
  'MergeAnomalyResults',
  (ctx: any, emit: any) => {
    // Fan-in unique task: merge parallel results into overall score
    const { temperatureAnomaly, humidityAnomaly } = ctx.joinedContexts.reduce((acc: any, c: any) => ({
      temperatureAnomaly: acc.temperatureAnomaly || c.temperatureAnomaly,
      humidityAnomaly: acc.humidityAnomaly || c.humidityAnomaly,
    }), {});
    const overallScore = ((temperatureAnomaly?.score || 0) + (humidityAnomaly?.score || 0)) / 2;
    ctx.anomalyScore = overallScore;
    ctx.anomalyDetected = overallScore > 0.7; // Threshold for flag
    if (ctx.anomalyDetected) {
      // Emit cross-service signal to Predictor/Alert
      emit('global.telemetry.anomaly_detected', {
        deviceId: ctx.deviceId,
        score: overallScore,
        metrics: { temperature: temperatureAnomaly, humidity: humidityAnomaly },
      }, { targetServices: ['predictor', 'alert-service'] });
      console.log(`Anomaly detected for ${ctx.deviceId}: score=${overallScore}`);
    }
    return {
      ...ctx,
      data: {
        deviceId: ctx.deviceId,
        timestamp: Date.now(),
        anomalyScore: ctx.anomalyScore,
        failureProbability: Math.random(),
      },
    };
  },
  'Merges parallel anomaly results into overall score and emits cross-service signal if needed'
)
  .attachSignal("global.telemetry.anomaly_detected")
  .then(
    Cadenza.createDatabaseInsertTask('health_metrics', 'IotDbService'),
  );

// Cadenza Task: Check Temperature Anomaly (delegated from Telemetry Collector)
// Queries recent history, computes Z-score, emits signal if anomalous
Cadenza.createRoutine(
  'CheckAnomaly',
  [
    Cadenza.createTask(
      'Prepare query',
      (ctx: any) => {
        return {
          ...ctx,
          queryData: {
            filter: { deviceId: ctx.deviceId },
          },
        }
      },
    ).then(
      Cadenza.createDatabaseQueryTask(
        'telemetry',
        'IotDbService',
        {
          sort: {timestamp: 'desc'},
          limit: 20,
        }
      ).then(
        Cadenza.createTask(
          'CheckTemperatureAnomaly',
          (ctx: any, emit: any) => {
            const temps = ctx.telemetrys?.map((h: any) => h.temperature);
            if (temps.length < 2) {
              return { score: 0, anomalous: false, reason: 'Insufficient data' };
            }

            // Simple Z-score calculation (mean + std dev)
            const mean = temps.reduce((a: number, b: number) => a + b, 0) / temps.length;
            const variance = temps.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / temps.length;
            const stdDev = Math.sqrt(variance);
            const zScore = Math.abs((ctx.readings.temperature - mean) / stdDev);

            const score = Math.min(zScore / 3, 1); // Normalize to 0-1 (threshold 3 std devs)
            const anomalous = zScore > 2; // Mild anomaly threshold

            if (anomalous) {
              // Emit local signal for immediate handling
              emit('anomaly.temperature_spike', { deviceId: ctx.deviceId, zScore, score });
              console.log(`Temperature anomaly for ${ctx.deviceId}: Z-score=${zScore.toFixed(2)}, score=${score.toFixed(2)}`);
            }

            return {
              score,
              anomalous,
              reason: anomalous ? `Z-score ${zScore.toFixed(2)} exceeds threshold` : 'Normal',
              metric: 'temperature',
            };
          },
          'Analyzes temperature for anomalies using Z-score from historical data'
        )
          .attachSignal("anomaly.temperature_spike")
          .then(summaryTask),
        Cadenza.createTask(
          'CheckHumidityAnomaly',
          (ctx: any, emit: any) => {

            const hums = ctx.telemetrys.map((h: any) => h.humidity);
            if (hums.length < 2) {
              return { score: 0, anomalous: false, reason: 'Insufficient data' };
            }

            const mean = hums.reduce((a: number, b: number) => a + b, 0) / hums.length;
            const variance = hums.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / hums.length;
            const stdDev = Math.sqrt(variance);
            const zScore = Math.abs((ctx.readings.humidity - mean) / stdDev);

            const score = Math.min(zScore / 3, 1);
            const anomalous = zScore > 2;

            if (anomalous) {
              emit('anomaly.humidity_spike', { deviceId: ctx.deviceId, zScore, score });
              console.log(`Humidity anomaly for ${ctx.deviceId}: Z-score=${zScore.toFixed(2)}, score=${score.toFixed(2)}`);
            }

            return {
              score,
              anomalous,
              reason: anomalous ? `Z-score ${zScore.toFixed(2)} exceeds threshold` : 'Normal',
              metric: 'humidity',
            };
          },
          'Analyzes humidity for anomalies using Z-score from historical data'
        )
          .attachSignal("anomaly.humidity_spike")
          .then(summaryTask),
      ),
    ),
  ],
);


// Cadenza Routine: Anomaly Detection (exposed for delegation from Telemetry Collector)
// Handles specific metric checks; can be extended for battery, etc.
// const anomalyDetectionRoutine = Cadenza.createRoutine(
//   'AnomalyDetection',
//   [
//     Cadenza.createTask(
//       'DetectMetricAnomaly',
//       async (ctx: any, emit: any) => {
//         let result;
//         switch (ctx.metric) {
//           case 'temperature':
//             result = await Cadenza.runTask('CheckTemperatureAnomaly', ctx);
//             break;
//           case 'humidity':
//             result = await Cadenza.runTask('CheckHumidityAnomaly', ctx);
//             break;
//           default:
//             throw new Error(`Unknown metric: ${ctx.metric}`);
//         }
//         if (result.anomalous) {
//           // Emit cross-service signal to Predictor/Alert if score > 0.7
//           if (result.score > 0.7) {
//             emit('anomaly_detected', {
//               deviceId: ctx.deviceId,
//               score: result.score,
//               metric: result.metric,
//               reason: result.reason,
//             }, { targetServices: ['predictor', 'alert-service'] });
//           }
//         }
//         return result;
//       },
//       'Detects anomalies for a specific metric and emits signals if needed'
//     ),
//   ],
//   'Delegated anomaly detection for a metric (temperature or humidity)'
// );

// Cadenza Service Setup
Cadenza.createCadenzaService('AnomalyDetectorService', 'Detects outliers in IoT telemetry using statistical analysis', {
  cadenzaDB: {
    connect: true,
    address: process.env.CADENZA_DB_ADDRESS || 'cadenza-db-service',
    port: parseInt(process.env.CADENZA_DB_PORT || '8080'),
  },
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Anomaly Detector shutting down gracefully');
  process.exit(0);
});
