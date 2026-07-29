import { os } from "@orpc/server";
import { z } from "zod";
import {
  allow,
  createAgentRuntime,
  createCapabilityRegistry,
  createInMemoryApprovalCoordinator,
  defineGovernance,
  definePolicy,
  requireApproval,
} from "@orpc-agent/core";

/**
 * The reported shape: destructive capabilities gated by a RUNTIME-level policy,
 * conditionally on surface, with no `meta.approval` anywhere. The app's own UI
 * and cron actors run on `direct` and pass ungated; the model loop suspends.
 */
const gateModelWrites = definePolicy("gate-model-writes", (req) =>
  req.capability.meta.sideEffect === "destructive" &&
  (req.surface === "aiSdk" || req.surface === "mcp")
    ? requireApproval({ reason: "destructive capability reached from a model surface" })
    : allow(),
);

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

export const governance = defineGovernance({
  registry: capabilities,
  policies: [gateModelWrites],
});

/** Chosen explicitly: implicit is exactly what the startup warnings are about. */
const coordinator = createInMemoryApprovalCoordinator();

/** Also exported, to cover the loader preferring the governance over it. */
export const runtime = createAgentRuntime({
  governance,
  approvals: { coordinator },
  audit: () => {},
});
