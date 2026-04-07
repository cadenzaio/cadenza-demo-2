// Define constraints for common fields
const idConstraints = {
  required: true,
  default: "gen_random_uuid()",
};

const deviceIdConstraints = {
  required: true,
  references: "device(name)",
  onDelete: "cascade",
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
  enum: ["low", "medium", "high"],
  required: true,
};

const deviceTable = {
  fields: {
    name: {
      type: "varchar",
      primary: true,
      ...varcharConstraints,
      description: "Unique name for the IoT device",
    },
    type: {
      type: "varchar",
      ...varcharConstraints,
      description: "Type of sensor (e.g., temperature, humidity)",
    },
    last_seen: {
      type: "timestamp",
      nullable: true,
      description: "Last telemetry timestamp",
    },
  },
  meta: {
    description: "IoT devices in the fleet",
    tags: ["core", "device"],
    autoIndex: true,
  },
  indexes: [["name"], ["type"]],
  initialData: {
    fields: ["name", "type"],
    data: [
      ["device-1", "temperature-humidity"],
      ["device-2", "battery-monitor"],
      ["device-3", "environmental"],
      ...Array.from({ length: 47 }, (_, i) => [
        `device-${i + 4}`,
        "mixed-sensor",
      ]),
    ],
  },
};

const telemetryTable = {
  fields: {
    uuid: {
      type: "uuid",
      primary: true,
      ...idConstraints,
    },
    device_id: {
      type: "varchar",
      ...deviceIdConstraints,
    },
    timestamp: {
      type: "timestamp",
      ...timestampConstraints,
    },
    temperature: {
      type: "decimal",
      ...decimalConstraints,
      description: "Temperature reading in °C",
    },
    humidity: {
      type: "decimal",
      ...decimalConstraints,
      description: "Humidity reading in %",
    },
    battery: {
      type: "decimal",
      min: 0,
      max: 100,
      description: "Battery level in %",
    },
    raw_json: {
      type: "jsonb",
      description: "Raw sensor data as JSON",
    },
  },
  meta: {
    description: "Raw telemetry data from devices",
    tags: ["telemetry", "timeseries"],
    shardKey: "device_id",
    appendOnly: true,
  },
  indexes: [["device_id", "timestamp"], ["timestamp"]],
  uniqueConstraints: [["device_id", "timestamp"]],
};

const healthMetricTable = {
  fields: {
    uuid: {
      type: "uuid",
      primary: true,
      ...idConstraints,
    },
    device_id: {
      type: "varchar",
      ...deviceIdConstraints,
    },
    timestamp: {
      type: "timestamp",
      ...timestampConstraints,
    },
    anomaly_score: {
      type: "decimal",
      ...decimalConstraints,
      min: 0,
      max: 1,
      description: "Anomaly score (0-1)",
    },
    failure_probability: {
      type: "decimal",
      ...decimalConstraints,
      min: 0,
      max: 1,
      description: "Predicted failure probability (0-1)",
    },
    predicted_eta: {
      type: "timestamp",
      default: null,
      description: "Estimated time of failure",
    },
  },
  meta: {
    description: "Computed health metrics and predictions",
    tags: ["metrics", "predictions"],
    autoIndex: true,
  },
  indexes: [["device_id", "timestamp"], ["anomaly_score"]],
};

const alertFieldsV1 = {
  uuid: {
    type: "uuid",
    primary: true,
    ...idConstraints,
  },
  device_id: {
    type: "varchar",
    ...deviceIdConstraints,
  },
  timestamp: {
    type: "timestamp",
    ...timestampConstraints,
  },
  type: {
    type: "varchar",
    ...varcharConstraints,
    enum: ["anomaly", "prediction", "escalation"],
    description: "Alert type",
  },
  severity: {
    type: "varchar",
    ...severityConstraints,
    description: "Alert severity",
  },
  reason: {
    type: "text",
    description: "Reason for alert",
  },
  resolved: {
    type: "boolean",
    default: false,
    description: "Whether alert is resolved",
  },
};

const alertTableV1 = {
  fields: alertFieldsV1,
  meta: {
    description: "Generated alerts and notifications",
    tags: ["alerts", "events"],
    autoIndex: true,
  },
  indexes: [["device_id", "timestamp"], ["severity", "resolved"]],
};

const alertTable = {
  ...alertTableV1,
  fields: {
    ...alertFieldsV1,
    resolved_at: {
      type: "timestamp",
      default: null,
      description: "Timestamp when the alert was resolved",
    },
  },
  indexes: [
    ["device_id", "timestamp"],
    ["severity", "resolved"],
    ["resolved", "resolved_at"],
  ],
};

export const iotHealthSchema = {
  version: 2,
  tables: {
    device: deviceTable,
    telemetry: telemetryTable,
    health_metric: healthMetricTable,
    alert: alertTable,
  },
  migrations: [
    {
      version: 1,
      name: "initial-schema",
      steps: [
        {
          kind: "createTable",
          table: "device",
          definition: deviceTable,
        },
        {
          kind: "createTable",
          table: "telemetry",
          definition: telemetryTable,
        },
        {
          kind: "createTable",
          table: "health_metric",
          definition: healthMetricTable,
        },
        {
          kind: "createTable",
          table: "alert",
          definition: alertTableV1,
        },
      ],
    },
    {
      version: 2,
      name: "add-alert-resolved-at",
      steps: [
        {
          kind: "addColumn",
          table: "alert",
          column: "resolved_at",
          definition: {
            type: "timestamp",
            default: null,
            description: "Timestamp when the alert was resolved",
          },
        },
        {
          kind: "addIndex",
          table: "alert",
          fields: ["resolved", "resolved_at"],
        },
      ],
    },
  ],
  migrationPolicy: {
    baselineOnEmpty: true,
    adoptExistingVersion: 1,
    allowDestructive: false,
    transactionalMode: "per_migration",
  },
  meta: {
    dropExisting: false,
  },
};
