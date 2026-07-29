import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { os } from "@orpc/server";
import * as z from "zod";
import {
  agentProcedure,
  allow,
  createAgentRuntime,
  defineGovernance,
  createCapabilityRegistry,
  definePolicy,
  hide,
  type Actor,
  type AgentRuntime,
} from "@orpc-agent/core";
import { createMCPServer, type MCPServerOptions } from "../src/index";
import {
  describeAdapterConformance,
  type AdapterEnvelope,
  type ConformanceHarness,
} from "../../../test-fixtures/conformance";
import { buildFixtureRegistry, collidingToolNaming } from "../../../test-fixtures/registry";

const dana: Actor = { id: "u_dana", kind: "user" };

async function connectedClient<TContext>(
  runtime: AgentRuntime<TContext>,
  options: MCPServerOptions<TContext>,
): Promise<{ client: Client }> {
  const mcp = createMCPServer(runtime, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "conformance-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  return { client };
}

function parseEnvelope(result: {
  content?: unknown;
  isError?: boolean;
}): AdapterEnvelope {
  const content = (result.content as { type: string; text: string }[] | undefined)?.[0];
  if (!content || content.type !== "text") throw new Error("expected a text content block");
  const envelope = JSON.parse(content.text) as AdapterEnvelope;
  // isError must track the envelope status exactly.
  expect(Boolean(result.isError)).toBe(envelope.status === "error");
  return envelope;
}

// ---------------------------------------------------------------------------
// Shared adapter conformance checklist — over a real in-memory MCP transport
// ---------------------------------------------------------------------------

describeAdapterConformance("mcp", async (): Promise<ConformanceHarness> => {
  const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry: buildFixtureRegistry() }) });
  const { client } = await connectedClient(runtime, {
    createContext: () => ({ actor: dana, context: {} }),
  });

  return {
    listToolNames: async () => (await client.listTools()).tools.map((t) => t.name),
    toolDescription: async (name) =>
      (await client.listTools()).tools.find((t) => t.name === name)?.description,
    async callTool(name, args, options) {
      try {
        const result = await client.callTool(
          { name, arguments: args as Record<string, unknown> },
          undefined,
          options?.signal ? { signal: options.signal } : {},
        );
        return parseEnvelope(result as never);
      } catch (error) {
        // Client-side cancellation rejects the wire request; the server-side
        // envelope (cancelled) has nowhere to go. Normalize for the checklist.
        if (options?.signal?.aborted) {
          return {
            status: "error",
            error: { code: "CANCELLED", message: "The operation was cancelled.", retryable: false },
          };
        }
        throw error;
      }
    },
    buildWithCollidingNaming: async () =>
      createMCPServer(createAgentRuntime<object>({ governance: defineGovernance({ registry: buildFixtureRegistry() }) }), {
        createContext: () => ({ actor: dana, context: {} }),
        toolNaming: collidingToolNaming,
      }),
  };
});

// ---------------------------------------------------------------------------
// MCP-specific behavior
// ---------------------------------------------------------------------------

describe("per-session identity", () => {
  const base = agentProcedure(os.$context<object>());
  const registry = createCapabilityRegistry({
    open: base
      .meta({
        agent: {
          description: "Open.",
          expose: { mcp: true },
          sideEffect: "read",
          risk: "low",
        },
      })
      .input(z.object({}))
      .handler(async () => ({})),
    sensitive: base
      .meta({
        agent: {
          description: "Hidden from Dana.",
          expose: { mcp: true },
          sideEffect: "read",
          risk: "high",
          policies: [
            definePolicy(
              "hide-for-dana",
              ({ actor }) => (actor.id === "u_dana" ? hide() : allow()),
              { phases: ["discovery", "invocation"] },
            ),
          ],
        },
      })
      .input(z.object({}))
      .handler(async () => ({})),
  });

  test("two sessions with different actors see different tool lists", async () => {
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
    const danaSession = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
    });
    const priyaSession = await connectedClient(runtime, {
      createContext: () => ({ actor: { id: "u_priya", kind: "user" }, context: {} }),
    });
    const danaTools = (await danaSession.client.listTools()).tools.map((t) => t.name);
    const priyaTools = (await priyaSession.client.listTools()).tools.map((t) => t.name);
    expect(danaTools).toEqual(["open"]);
    expect(priyaTools).toEqual(["open", "sensitive"]);
  });

  test("createContext is called once per session", async () => {
    let calls = 0;
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
    const { client } = await connectedClient(runtime, {
      createContext: () => {
        calls += 1;
        return { actor: dana, context: {} };
      },
    });
    await client.listTools();
    await client.callTool({ name: "open", arguments: {} });
    await client.listTools();
    expect(calls).toBe(1);
  });

  test("sessions without identity are refused — no anonymous default", async () => {
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
    const { client } = await connectedClient(runtime, {
      createContext: () => null,
    });
    await expect(client.listTools()).rejects.toThrowError(/Unauthorized/);
    await expect(client.callTool({ name: "open", arguments: {} })).rejects.toThrowError(
      /Unauthorized/,
    );
  });
});

describe("protocol mapping details", () => {
  test("annotations pass through to tool declarations; input schema is JSON Schema", async () => {
    const base = agentProcedure(os.$context<object>());
    const registry = createCapabilityRegistry({
      annotated: base
        .meta({
          agent: {
            description: "Annotated.",
            expose: { mcp: true },
            sideEffect: "read",
            risk: "low",
            adapters: { mcp: { annotations: { readOnlyHint: true } } },
          },
        })
        .input(z.object({ q: z.string() }))
        .handler(async () => ({})),
    });
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
    const { client } = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
    });
    const tools = (await client.listTools()).tools;
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true });
    expect(tools[0]!.inputSchema).toMatchObject({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  test("no approval-deciding surface exists on MCP (SI-4)", async () => {
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry: buildFixtureRegistry() }) });
    const { client } = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    // The gated capability is listed; nothing that decides approvals is.
    expect(names).toContain("fixtures_gated");
    expect(names.filter((n) => /approve|decide|reject/i.test(n))).toEqual([]);
  });

  test("serverInfo defaults are applied", async () => {
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry: buildFixtureRegistry() }) });
    const mcp = createMCPServer(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "x", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    expect(client.getServerVersion()).toMatchObject({ name: "orpc-agent" });
  });
});
