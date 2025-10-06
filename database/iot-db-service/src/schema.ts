
// Define constraints for common fields
const idConstraints = {
  required: true,
  default: "gen_random_uuid()",
};

const deviceIdConstraints = {
  required: true,
  references: 'device(name)', // Foreign key reference
  onDelete: 'cascade',
};

const timestampConstraints = {
  required: true,
  default: "now()",
};

const decimalConstraints = {
  precision: 5,
  scale: 2,
  min: -100,
  max: 100,
};

const varcharConstraints = {
  maxLength: 255,
  required: true,
};

const severityConstraints = {
  enum: ['low', 'medium', 'high'],
  required: true,
};

export const iotHealthSchema = {
  version: 1,
  tables: {
    device: {
      fields: {
        name: {
          type: 'varchar',
          primary: true,
          ...varcharConstraints,
          description: 'Unique name for the IoT device',
        },
        type: {
          type: 'varchar',
          ...varcharConstraints,
          description: 'Type of sensor (e.g., temperature, humidity)',
        },
        last_seen: {
          type: 'timestamp',
          nullable: true,
          description: 'Last telemetry timestamp',
        },
      },
      meta: {
        description: 'IoT devices in the fleet',
        tags: ['core', 'device'],
        autoIndex: true,
      },
      indexes: [['name'], ['type']],
      initialData: {
        fields: ['name', 'type'],
        data: [
          ['device-1', 'temperature-humidity'],
          ['device-2', 'battery-monitor'],
          ['device-3', 'environmental'],
          // Add more for demo (up to 50)
          ...Array.from({ length: 47 }, (_, i) => [`device-${i + 4}`, 'mixed-sensor']),
        ],
      },
    },
    telemetry: {
      fields: {
        uuid: {
          type: 'uuid',
          primary: true,
          ...idConstraints,
        },
        device_id: {
          type: 'varchar',
          ...deviceIdConstraints,
        },
        timestamp: {
          type: 'timestamp',
          ...timestampConstraints,
        },
        temperature: {
          type: 'decimal',
          ...decimalConstraints,
          description: 'Temperature reading in °C',
        },
        humidity: {
          type: 'decimal',
          ...decimalConstraints,
          description: 'Humidity reading in %',
        },
        battery: {
          type: 'decimal',
          min: 0,
          max: 100,
          description: 'Battery level in %',
        },
        raw_json: {
          type: 'jsonb',
          description: 'Raw sensor data as JSON',
        },
      },
      meta: {
        description: 'Raw telemetry data from devices',
        tags: ['telemetry', 'timeseries'],
        shardKey: 'device_id',
        appendOnly: true,
      },
      indexes: [['device_id', 'timestamp'], ['timestamp']],
      uniqueConstraints: [['device_id', 'timestamp']],
    },
    health_metric: {
      fields: {
        uuid: {
          type: 'uuid',
          primary: true,
          ...idConstraints,
        },
        device_id: {
          type: 'varchar',
          ...deviceIdConstraints,
        },
        timestamp: {
          type: 'timestamp',
          ...timestampConstraints,
        },
        anomaly_score: {
          type: 'decimal',
          ...decimalConstraints,
          min: 0,
          max: 1,
          description: 'Anomaly score (0-1)',
        },
        failure_probability: {
          type: 'decimal',
          ...decimalConstraints,
          min: 0,
          max: 1,
          description: 'Predicted failure probability (0-1)',
        },
        predicted_eta: {
          type: 'timestamp',
          default: null,
          description: 'Estimated time of failure',
        },
      },
      meta: {
        description: 'Computed health metrics and predictions',
        tags: ['metrics', 'predictions'],
        autoIndex: true,
      },
      indexes: [['device_id', 'timestamp'], ['anomaly_score']],
    },
    alert: {
      fields: {
        uuid: {
          type: 'uuid',
          primary: true,
          ...idConstraints,
        },
        device_id: {
          type: 'varchar',
          ...deviceIdConstraints,
        },
        timestamp: {
          type: 'timestamp',
          ...timestampConstraints,
        },
        type: {
          type: 'varchar',
          ...varcharConstraints,
          enum: ['anomaly', 'prediction', 'escalation'],
          description: 'Alert type',
        },
        severity: {
          type: 'varchar',
          ...severityConstraints,
          description: 'Alert severity',
        },
        reason: {
          type: 'text',
          description: 'Reason for alert',
        },
        resolved: {
          type: 'boolean',
          default: false,
          description: 'Whether alert is resolved',
        },
      },
      meta: {
        description: 'Generated alerts and notifications',
        tags: ['alerts', 'events'],
        autoIndex: true,
      },
      indexes: [['device_id', 'timestamp'], ['severity', 'resolved']],
    },
  },
  meta: {
    dropExisting: false, // Set to true for dev resets
  },
};
