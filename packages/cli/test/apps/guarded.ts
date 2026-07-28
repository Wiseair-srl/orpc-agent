import { os } from "@orpc/server";
import { createCapabilityRegistry } from "@orpc-agent/core";

/**
 * Stands in for an app that does real work at import time and guards it, the
 * convention the loader documents by setting ORPC_AGENT_INSPECT=1.
 */
const inspecting = process.env.ORPC_AGENT_INSPECT === "1";

const ping = os
  .meta({
    agent: {
      description: inspecting ? "inspected" : "started for real",
      expose: { aiSdk: true },
      sideEffect: "none",
      risk: "low",
    },
  })
  .handler(() => "pong");

export const capabilities = createCapabilityRegistry({ ping });
