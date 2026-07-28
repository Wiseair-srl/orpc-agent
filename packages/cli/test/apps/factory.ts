import { os } from "@orpc/server";
import { createCapabilityRegistry } from "@orpc-agent/core";

const ping = os
  .meta({
    agent: {
      description: "Ping.",
      expose: { aiSdk: true },
      sideEffect: "none",
      risk: "low",
    },
  })
  .handler(() => "pong");

/** Exports only a factory — the CLI must refuse to call it. */
export function makeApp() {
  return { capabilities: createCapabilityRegistry({ ping }) };
}
