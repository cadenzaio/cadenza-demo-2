#!/bin/bash

# Get instance index from hostname (e.g., telemetry-collector_2 -> index 2)
INSTANCE_INDEX=$(hostname | sed -n 's/.*_\([0-9]\+\)$/\1/p' || echo "1")

# Base port from env or default
BASE_PORT=${SERVICE_PORT:-3003}

# Compute unique port
UNIQUE_PORT=$((BASE_PORT + INSTANCE_INDEX - 1))

# Set env var for the service
export HTTP_PORT=$UNIQUE_PORT
export INSTANCE_INDEX=$INSTANCE_INDEX
export CADENZA_SERVER_URL=$(hostname)

# Register unique address in CadenzaDB via signal (after npm start)
echo "Instance $INSTANCE_INDEX starting on port $UNIQUE_PORT (hostname: $CADENZA_SERVER_URL)"

# Run the original command
exec "$@"