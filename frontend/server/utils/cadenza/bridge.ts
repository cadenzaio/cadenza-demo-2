import { createSSRInquiryBridge } from "@cadenza.io/service";

export interface DemoSSRBridgeConfig {
  cadenzaServerAddress: string;
  cadenzaServerPort: number;
}

export function createDemoSSRBridge(config: DemoSSRBridgeConfig) {
  const address = String(config.cadenzaServerAddress ?? "").trim();
  const port = Math.trunc(Number(config.cadenzaServerPort ?? 8080) || 8080);

  if (address.includes("://")) {
    return createSSRInquiryBridge({
      bootstrap: {
        url: address,
      },
    });
  }

  return createSSRInquiryBridge({
    cadenzaDB: {
      address,
      port,
    },
  });
}
