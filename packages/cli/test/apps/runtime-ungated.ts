import { os } from "@orpc/server";
import { z } from "zod";
import { createAgentRuntime, createCapabilityRegistry, defineGovernance } from "@orpc-agent/core";

/**
 * runtime-gated.ts with one line deleted: `policies: [gateModelWrites]` in
 * defineGovernance. Every capability declaration is unchanged, so every
 * per-capability snapshot field is byte-identical to the gated app — which is
 * the whole reason the snapshot has to record the governance as well.
 */
const purge = os
  .meta({
    agent: {
      description: "Permanently delete a customer and all their records.",
      expose: { aiSdk: true, mcp: true, direct: true },
      sideEffect: "destructive",
      risk: "critical",
    },
  })
  .input(z.object({ customerId: z.string() }))
  .handler(() => ({ ok: true }));

const list = os
  .meta({
    agent: {
      description: "List customers.",
      expose: { aiSdk: true, direct: true },
      sideEffect: "read",
      risk: "low",
    },
  })
  .handler(() => []);

export const capabilities = createCapabilityRegistry({
  customers: { purge, list },
});

export const governance = defineGovernance({ registry: capabilities });

export const runtime = createAgentRuntime({ governance, warnings: false });
