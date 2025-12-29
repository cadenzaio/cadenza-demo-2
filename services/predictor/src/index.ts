import Cadenza from '@cadenza.io/service';

// Cadenza Task: Fetch Anomaly History (fan-in aggregation prep)
// Queries aggregated anomalies from Anomaly Detector via signal or DB
const analyzeAnomalyHistoryTask = Cadenza.createTask(
  'AnalyzeAnomalyHistory',
  async (ctx: any) => {

    const anomalies = ctx.healthMetrics.filter((m: any) => m.anomaly_score > 0.5);
    const trend = anomalies.length > 3 ? 'increasing' : 'stable'; // Simple trend detection

    console.log(`Fetched anomaly history for ${ctx.deviceId}: ${anomalies.length} high-score events, trend=${trend}`);
    return { ...ctx, anomalyHistory: anomalies, trend };
  },
  'Fetches recent anomaly history for failure prediction'
);

// Cadenza Task: Call External Weather API
const callWeatherApiTask = Cadenza.createTask(
  'CallWeatherApi',
  async (ctx: any) => {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      console.warn('WEATHER_API_KEY not set; skipping external API call');
      return { ...ctx, weatherData: { temperature: 20, humidity: 50, condition: 'neutral' } };
    }

    // Mock device location (random lat/long for demo)
    const lat = 37.7749 + (Math.random() - 0.5) * 2; // Around SF
    const lon = -122.4194 + (Math.random() - 0.5) * 2;

    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`
      );
      const data = await response.json();
      const weatherData = {
        temperature: data.main.temp,
        humidity: data.main.humidity,
        condition: data.weather[0].main.toLowerCase(), // e.g., 'rain', 'clear'
      };
      console.log(`Fetched weather for ${ctx.deviceId}: ${weatherData.condition}, ${weatherData.temperature}°C`);
      return { ...ctx, weatherData };
    } catch (err) {
      console.error(`Weather API error for ${ctx.deviceId}:`, err);
      return { ...ctx, weatherData: { temperature: 20, humidity: 50, condition: 'neutral' } };
    }
  },
  'Calls OpenWeatherMap API for environmental context'
);

// Cadenza Task: Compute Failure Prediction (fan-in unique task)
// Aggregates anomalies + weather, computes probability and ETA
const computePredictionTask = Cadenza.createUniqueTask(
  'ComputeFailurePrediction',
  async (ctx: any, emit: any) => {
    // Fan-in: Merge from parallel anomaly history and weather call
    const { anomalyHistory, trend, weatherData } = ctx.joinedContexts.reduce((acc: any, c: any) => ({
      anomalyHistory: acc.anomalyHistory || c.anomalyHistory,
      trend: acc.trend || c.trend,
      weatherData: acc.weatherData || c.weatherData,
    }), {});

    // Simple prediction logic (demo: weighted score)
    const baseRisk = anomalyHistory.length / 10; // 0-1 from count
    const weatherMultiplier = (weatherData.condition === 'rain' || 'thunderstorm') ? 1.5 : 1.0;
    const trendMultiplier = (trend === 'increasing') ? 1.2 : 1.0;
    const failureProbability = Math.min(baseRisk * weatherMultiplier * trendMultiplier, 1);

    // Mock ETA: Exponential based on probability
    const etaDays = failureProbability > 0.7 ? Math.random() * 3 + 1 : Math.random() * 30 + 7;
    const predictedEta = new Date(Date.now() + etaDays * 24 * 60 * 60 * 1000);

    const prediction = {
      failureProbability: failureProbability.toFixed(3),
      predictedEta,
      riskFactors: {
        anomalies: anomalyHistory.length,
        trend,
        weatherImpact: weatherData.condition,
      },
    };

    if (failureProbability > 0.7) {
      // Emit cross-service signal for high-risk prediction
      emit('predictor.maintenance_needed', {
        deviceId: ctx.deviceId,
        prediction,
        urgency: 'high',
      }, { targetServices: ['telemetry-collector', 'alert-service'] });
      console.log(`High-risk prediction for ${ctx.deviceId}: prob=${prediction.failureProbability}, ETA=${predictedEta.toISOString()}`);
    } else {
      emit('predictor.prediction_ready', {
        deviceId: ctx.deviceId,
        prediction,
        urgency: 'low',
      }, { targetServices: ['alert-service'] });
    }

    return {
      ...ctx,
      data: {
        deviceId: ctx.deviceId,
        anomalyScore: ctx.anomalyScore || 0,
        failureProbability,
        predictedEta,
      },
    };
  },
  'Computes failure prediction from aggregated anomalies and weather data, emits signals, persists'
)
  .attachSignal(
    "predictor.maintenance_needed",
    "predictor.prediction_ready"
  )
  .then(
    Cadenza.createDatabaseInsertTask('health_metric', 'IotDbService'),
  );

// Cadenza Routine: Predictive Maintenance (triggered by 'predictive_maintenance_triggered' signal)
// Fan-out yield: parallel history fetch and weather call, fan-in to compute prediction
const predictiveMaintenanceRoutine = Cadenza.createRoutine(
  'PredictiveMaintenance',
  [
    Cadenza.createTask(
      'InitiatePrediction',
      (ctx: any, emit: any) => {
        emit('predictor.prediction_started', { deviceId: ctx.deviceId });
        console.log(`Started predictive maintenance for ${ctx.deviceId}`);
        return {
          ...ctx,
          filter: {
            deviceId: ctx.deviceId,
          },
        };
      },
      'Initiates prediction and emits local start signal'
    )
      .attachSignal("predictor.prediction_started")
      .then(
        Cadenza.createDatabaseQueryTask(
          'health_metrics',
          'IotDbService',
          { limit: 10 },
        ).then(
          analyzeAnomalyHistoryTask.then(
            computePredictionTask,
          ),
        ),
        callWeatherApiTask.then(
          computePredictionTask,
        ),
      ),
  ],
  'Full predictive maintenance: fan-out history/weather, fan-in prediction, persist and signal'
).doOn(
  "global.telemetry.anomaly_detected",
  "global.telemetry.inserted",
);

// Cadenza Service Setup
Cadenza.createCadenzaService('PredictorService', 'Forecasts IoT device failures using anomalies and external weather data', {
  cadenzaDB: {
    connect: true,
    address: process.env.CADENZA_DB_ADDRESS || 'cadenza-db-service',
    port: parseInt(process.env.CADENZA_DB_PORT || '8080'),
  },
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Predictor Service shutting down gracefully');
  process.exit(0);
});