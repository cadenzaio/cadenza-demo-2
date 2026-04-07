import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSSRInquiryBridge } = vi.hoisted(() => ({
  createSSRInquiryBridge: vi.fn((options: Record<string, any>) => options),
}));

vi.mock("@cadenza.io/service", () => ({
  createSSRInquiryBridge,
}));

import { createDemoSSRBridge } from "../server/utils/cadenza/bridge";

describe("createDemoSSRBridge", () => {
  beforeEach(() => {
    createSSRInquiryBridge.mockClear();
  });

  it("uses direct bootstrap urls when the configured address is already a full origin", () => {
    createDemoSSRBridge({
      cadenzaServerAddress: "http://cadenza-db.localhost:80",
      cadenzaServerPort: 8080,
    });

    expect(createSSRInquiryBridge).toHaveBeenCalledWith({
      bootstrap: {
        url: "http://cadenza-db.localhost:80",
      },
    });
  });

  it("uses docker-internal address and port when the configured address is a bare host", () => {
    createDemoSSRBridge({
      cadenzaServerAddress: "cadenza-db-service",
      cadenzaServerPort: 8080,
    });

    expect(createSSRInquiryBridge).toHaveBeenCalledWith({
      cadenzaDB: {
        address: "cadenza-db-service",
        port: 8080,
      },
    });
  });
});
