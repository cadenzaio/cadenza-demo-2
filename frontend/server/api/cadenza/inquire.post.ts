import { createError, defineEventHandler, readBody } from "h3";
import { createDemoSSRBridge } from "../../utils/cadenza/bridge";

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    inquiry?: string;
    context?: Record<string, any>;
    options?: Record<string, any>;
  }>(event);

  const inquiry = typeof body?.inquiry === "string" ? body.inquiry.trim() : "";
  if (!inquiry) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing inquiry name.",
    });
  }

  const config = useRuntimeConfig(event);
  const bridge = createDemoSSRBridge({
    cadenzaServerAddress: String(config.cadenzaServerAddress ?? "").trim(),
    cadenzaServerPort: Math.trunc(Number(config.cadenzaServerPort ?? 8080) || 8080),
  });

  return bridge.inquire(inquiry, body?.context ?? {}, {
    ...(body?.options ?? {}),
  });
});
