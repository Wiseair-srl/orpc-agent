import { os } from "@orpc/server";
import { createCapabilityRegistry } from "@orpc-agent/core";

const read = os
  .meta({
    agent: {
      description: "Read something.",
      expose: { aiSdk: true, mcp: true },
      sideEffect: "read",
      risk: "low",
    },
  })
  .handler(() => "value");

export const publicRegistry = createCapabilityRegistry({ read });
export const internalRegistry = publicRegistry.filter({ surface: "mcp" });
