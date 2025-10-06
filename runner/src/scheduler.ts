
// Re-export for use in index.ts (if needed for modularity)
export async function mockTelemetryEvent(ctx: any): Promise<any> {
  // This is a placeholder for telemetry mocking logic
  // In a real implementation, this could fetch or generate more complex data
  const { deviceId, readings } = ctx;
  console.log(`Mocking telemetry for ${deviceId}:`, readings);
  return {
    data: {
      ...readings,
      deviceId,
    },
    validated: true,
  };
}