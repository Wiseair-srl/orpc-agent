import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { createCapabilityRegistry } from "../src/registry";
import { createInMemoryApprovalCoordinator } from "../src/approvals/in-memory";
import { agentProcedure } from "../src/procedure";
import type { AgentInvocationInfo } from "../src/types";

/**
 * Startup footgun warnings (v0.2, ADR-014): never fatal, static knowledge
 * only, silenced by `warnings: false`.
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
    createAgentRuntime({ registry: createCapabilityRegistry({ messages: { send: gatedSend } }) });
    expect(warningsText()).toContain('"messages.send"');
    expect(warningsText()).toContain("in-memory coordinator");
  });

  test("silent when a persistent coordinator is supplied", () => {
    createAgentRuntime({
      registry: createCapabilityRegistry({ messages: { send: gatedSend } }),
      approvals: { coordinator: createInMemoryApprovalCoordinator() },
    });
    expect(warningsText()).not.toContain("coordinator");
  });

  test("silent when an inline handler is configured (explicit choice)", () => {
    createAgentRuntime({
      registry: createCapabilityRegistry({ messages: { send: gatedSend } }),
      approvals: { handler: async () => undefined },
    });
    expect(warningsText()).not.toContain("coordinator");
  });

  test("silent when nothing is approval-gated", () => {
    createAgentRuntime({
      registry: createCapabilityRegistry({ records: { search: exposedRead } }),
    });
    expect(warningsText()).not.toContain("coordinator");
  });
});

describe("missing audit sink warning", () => {
  test("fires for write-capable capabilities exposed to model surfaces", () => {
    createAgentRuntime({
      registry: createCapabilityRegistry({ records: { update: exposedWrite } }),
    });
    expect(warningsText()).toContain('"records.update"');
    expect(warningsText()).toContain("no audit sink");
  });

  test("silent when a sink is configured", () => {
    createAgentRuntime({
      registry: createCapabilityRegistry({ records: { update: exposedWrite } }),
      audit: () => {},
    });
    expect(warningsText()).not.toContain("no audit sink");
  });

  test("silent when only reads are exposed to model surfaces", () => {
    createAgentRuntime({
      registry: createCapabilityRegistry({ records: { search: exposedRead } }),
    });
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
    createAgentRuntime({ registry: createCapabilityRegistry({ internal: { write: directWrite } }) });
    expect(warningsText()).not.toContain("no audit sink");
  });
});

test("warnings: false silences everything", () => {
  createAgentRuntime({
    registry: createCapabilityRegistry({
      messages: { send: gatedSend },
      records: { update: exposedWrite },
    }),
    warnings: false,
  });
  expect(warn).not.toHaveBeenCalled();
});
