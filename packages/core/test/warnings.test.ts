import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { defineGovernance } from "../src/governance";
import { definePolicy } from "../src/policy/define";
import { requireApproval } from "../src/policy/helpers";
import { createCapabilityRegistry } from "../src/registry";
import { createInMemoryApprovalCoordinator } from "../src/approvals/in-memory";
import { agentProcedure } from "../src/procedure";
import type { AgentInvocationInfo } from "../src/types";

/**
 * Startup footgun warnings (ADR-014, ADR-016): never fatal, static knowledge
 * only, and with NO flag to silence them. Each fires exactly where a decision
 * was left implicit, and is answered by making it — naming the coordinator, or
 * the audit sink, including one that deliberately discards.
 */

const base = agentProcedure(os.$context<{ agent?: AgentInvocationInfo }>());

const gatedSend = base
  .meta({
    agent: {
      description: "Send a message.",
      expose: { direct: true },
      sideEffect: "external",
      risk: "high",
      approval: { required: true, type: "human-confirmation" },
    },
  })
  .input(z.object({ draftId: z.string() }))
  .handler(async () => ({ ok: true }));

const exposedWrite = base
  .meta({
    agent: {
      description: "Update a record.",
      expose: { aiSdk: true },
      sideEffect: "write",
      risk: "medium",
    },
  })
  .input(z.object({ id: z.string() }))
  .handler(async () => ({ ok: true }));

const exposedRead = base
  .meta({
    agent: {
      description: "Search records.",
      expose: { aiSdk: true, mcp: true },
      sideEffect: "read",
      risk: "low",
    },
  })
  .input(z.object({ q: z.string() }))
  .handler(async () => ({ hits: [] }));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function warningsText(): string {
  return warn.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("in-memory coordinator warning", () => {
  test("fires for approval-gated capabilities on the default coordinator", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ messages: { send: gatedSend } }) }) });
    expect(warningsText()).toContain('"messages.send"');
    expect(warningsText()).toContain("no approval coordinator was chosen");
  });

  test("silent when a persistent coordinator is supplied", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ messages: { send: gatedSend } }) }), approvals: { coordinator: createInMemoryApprovalCoordinator() } });
    expect(warningsText()).not.toContain("coordinator");
  });

  test("silent when an inline handler is configured (explicit choice)", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ messages: { send: gatedSend } }) }), approvals: { handler: async () => undefined } });
    expect(warningsText()).not.toContain("coordinator");
  });

  test("silent when nothing is approval-gated", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ records: { search: exposedRead } }) }) });
    expect(warningsText()).not.toContain("coordinator");
  });
});

describe("missing audit sink warning", () => {
  test("fires for write-capable capabilities exposed to model surfaces", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ records: { update: exposedWrite } }) }) });
    expect(warningsText()).toContain('"records.update"');
    expect(warningsText()).toContain("no audit sink");
  });

  test("silent when a sink is configured", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ records: { update: exposedWrite } }) }), audit: () => {} });
    expect(warningsText()).not.toContain("no audit sink");
  });

  test("silent when only reads are exposed to model surfaces", () => {
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ records: { search: exposedRead } }) }) });
    expect(warningsText()).not.toContain("no audit sink");
  });

  test("direct-only writes do not fire the model-surface warning", () => {
    const directWrite = base
      .meta({
        agent: {
          description: "Internal write.",
          expose: { direct: true },
          sideEffect: "write",
          risk: "medium",
        },
      })
      .handler(async () => ({ ok: true }));
    createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ internal: { write: directWrite } }) }) });
    expect(warningsText()).not.toContain("no audit sink");
  });
});

describe("policy-driven approval durability", () => {
  const gate = definePolicy("gate", () => requireApproval({ reason: "x" }));

  test("fires when policies are configured and a model can reach a write", () => {
    createAgentRuntime({
      governance: defineGovernance({
        registry: createCapabilityRegistry({ records: { update: exposedWrite } }),
        policies: [gate],
      }),
    });

    // No capability declares meta.approval here — only a policy could gate,
    // and whether it does is unknowable without a real invocation.
    expect(warningsText()).toContain("no approval coordinator was chosen");
    expect(warningsText()).toContain('"records.update"');
  });

  test("silent without policies — nothing could suspend", () => {
    createAgentRuntime({
      governance: defineGovernance({
        registry: createCapabilityRegistry({ records: { update: exposedWrite } }),
      }),
    });

    expect(warningsText()).not.toContain("approval coordinator");
  });

  test("silent when only reads are reachable", () => {
    createAgentRuntime({
      governance: defineGovernance({
        registry: createCapabilityRegistry({ records: { search: exposedRead } }),
        policies: [gate],
      }),
    });

    expect(warningsText()).not.toContain("approval coordinator");
  });
});

/**
 * The replacement for the old `warnings: false`. Silence is not a flag: it is
 * what naming both choices produces, and the code then documents the decision
 * where a reviewer sees it.
 */
test("explicit configuration silences everything, with no flag to do it", () => {
  createAgentRuntime({
    governance: defineGovernance({
      registry: createCapabilityRegistry({
        messages: { send: gatedSend },
        records: { update: exposedWrite },
      }),
    }),
    approvals: { coordinator: createInMemoryApprovalCoordinator() },
    audit: () => {},
  });

  expect(warn).not.toHaveBeenCalled();
});
