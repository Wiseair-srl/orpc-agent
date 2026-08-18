import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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

describe("session lifetime", () => {
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
  });

  function fixture(): AgentRuntime<object> {
    return createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
  }

  /** A bearer token that expires `seconds` from now (negative = already expired). */
  function tokenExpiringIn(seconds: number): AuthInfo {
    return {
      token: "tok_dana",
      clientId: "cli_test",
      scopes: ["tools"],
      expiresAt: Math.floor(Date.now() / 1000) + seconds,
    };
  }

  /**
   * Stamps every inbound message with an authInfo, the way a Streamable HTTP
   * transport attaches what it verified from that request's bearer token. The
   * holder is mutable, which is what makes a mid-session expiry observable.
   */
  function stampAuthInfo(
    transport: InMemoryTransport,
    credential: { authInfo?: AuthInfo | undefined },
  ): void {
    let handler: Transport["onmessage"];
    Object.defineProperty(transport, "onmessage", {
      configurable: true,
      get: () => handler,
      set: (next: Transport["onmessage"]) => {
        handler = next && ((message, extra) => next(message, { ...extra, authInfo: credential.authInfo }));
      },
    });
  }

  async function connect(
    mcp: { connect(transport: Transport): Promise<void> },
    serverTransport: InMemoryTransport,
    clientTransport: InMemoryTransport,
  ): Promise<Client> {
    const client = new Client({ name: "session-lifetime-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
    return client;
  }

  test("a token that expires mid-session is refused on the next call", async () => {
    let calls = 0;
    const credential: { authInfo?: AuthInfo | undefined } = { authInfo: tokenExpiringIn(60) };
    const mcp = createMCPServer(fixture(), {
      createContext: () => {
        calls += 1;
        return { actor: dana, context: {} };
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    stampAuthInfo(serverTransport, credential);
    const client = await connect(mcp, serverTransport, clientTransport);

    await client.callTool({ name: "open", arguments: {} });
    expect(calls).toBe(1);

    // Same session, same cached identity — but the credential behind it died.
    credential.authInfo = tokenExpiringIn(-1);
    await expect(client.callTool({ name: "open", arguments: {} })).rejects.toThrowError(
      /Unauthorized: the session's access token has expired/,
    );
    // Listing is identity-derived too, so it refuses on the same grounds.
    await expect(client.listTools()).rejects.toThrowError(/expired/);

    // The refusal evicted the entry, so a refreshed token re-verifies rather
    // than resuming the dead session's identity.
    credential.authInfo = tokenExpiringIn(60);
    await client.callTool({ name: "open", arguments: {} });
    expect(calls).toBe(2);
  });

  test("a token with no expiry is left to createContext to judge", async () => {
    const credential: { authInfo?: AuthInfo | undefined } = {
      authInfo: { token: "tok_dana", clientId: "cli_test", scopes: ["tools"] },
    };
    const mcp = createMCPServer(fixture(), {
      createContext: () => ({ actor: dana, context: {} }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    stampAuthInfo(serverTransport, credential);
    const client = await connect(mcp, serverTransport, clientTransport);
    await expect(client.callTool({ name: "open", arguments: {} })).resolves.toBeDefined();
  });

  test("closing a session evicts its cached identity", async () => {
    let calls = 0;
    const mcp = createMCPServer(fixture(), {
      createContext: () => {
        calls += 1;
        return { actor: dana, context: {} };
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = await connect(mcp, serverTransport, clientTransport);
    await client.listTools();
    expect(calls).toBe(1);

    await client.close();

    // Same server, same session key. A surviving entry would answer the new
    // connection with the closed session's identity — and, on a long-lived
    // server, would never be removed at all.
    const [nextClientTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
    const next = await connect(mcp, nextServerTransport, nextClientTransport);
    await next.listTools();
    expect(calls).toBe(2);
  });

  test("eviction survives an app that takes over server.onclose", async () => {
    let calls = 0;
    let appNotified = 0;
    const mcp = createMCPServer(fixture(), {
      createContext: () => {
        calls += 1;
        return { actor: dana, context: {} };
      },
    });
    // Composing over `mcp.server` this way replaces the adapter's own onclose
    // hook; the transport hook installed by connect() is what keeps the cache
    // from outliving the session anyway.
    mcp.server.onclose = () => {
      appNotified += 1;
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = await connect(mcp, serverTransport, clientTransport);
    await client.listTools();
    expect(calls).toBe(1);

    await client.close();
    expect(appNotified).toBe(1);

    const [nextClientTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
    const next = await connect(mcp, nextServerTransport, nextClientTransport);
    await next.listTools();
    expect(calls).toBe(2);
  });

  test("eviction also holds when the app connects the SDK server itself", async () => {
    let calls = 0;
    const mcp = createMCPServer(fixture(), {
      createContext: () => {
        calls += 1;
        return { actor: dana, context: {} };
      },
    });

    // `mcp.server` is documented as the seam for advanced composition, so the
    // adapter's own connect() wrapper is not on this path.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = await connect(mcp.server, serverTransport, clientTransport);
    await client.listTools();
    expect(calls).toBe(1);

    await client.close();

    const [nextClientTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
    const next = await connect(mcp.server, nextServerTransport, nextClientTransport);
    await next.listTools();
    expect(calls).toBe(2);
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

// ---------------------------------------------------------------------------
// Approval UX: deep link + resume tool
// ---------------------------------------------------------------------------

describe("approval UX", () => {
  const priya: Actor = { id: "u_priya", kind: "user" };
  const base = agentProcedure(os.$context<object>());
  const registry = createCapabilityRegistry({
    orders: {
      refund: base
        .meta({
          agent: {
            description: "Refund an order.",
            expose: { mcp: true, aiSdk: true },
            sideEffect: "write",
            risk: "high",
            approval: { required: true, type: "human-confirmation" },
          },
        })
        .input(z.object({ orderId: z.string(), amount: z.number().positive() }))
        .handler(async ({ input }) => ({ refundId: "ref_1", amount: input.amount })),
    },
  });

  function fixture(): AgentRuntime<object> {
    return createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
  }

  const REFUND = { orderId: "ord_42", amount: 649 };

  test("approvals.url: envelope carries url + expiresAt; message hands the link to the user", async () => {
    const runtime = fixture();
    const { client } = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: {
        url: (record) => `https://approvals.acme.test/${record.id}`,
        resumeTool: true,
      },
    });
    const envelope = parseEnvelope(
      (await client.callTool({ name: "orders_refund", arguments: REFUND })) as never,
    );
    if (envelope.status !== "approval-required") expect.unreachable();
    expect(envelope.url).toBe(`https://approvals.acme.test/${envelope.approvalId}`);
    expect(Date.parse(envelope.expiresAt!)).toBeGreaterThan(Date.now());
    expect(envelope.message).toContain("Share this link with the user");
    expect(envelope.message).toContain(envelope.url);
    expect(envelope.message).toContain("call approvals_resume with this approvalId");
  });

  test("resume tool is opt-in and absent by default (SI-4 listing unchanged)", async () => {
    const { client } = await connectedClient(fixture(), {
      createContext: () => ({ actor: dana, context: {} }),
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["orders_refund"]);
  });

  test("resume tool listing: default name, execute-only description, strict input schema", async () => {
    const { client } = await connectedClient(fixture(), {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: { resumeTool: true },
    });
    const tools = (await client.listTools()).tools;
    const resume = tools.find((t) => t.name === "approvals_resume")!;
    expect(resume.description).toContain("cannot approve or reject");
    expect(resume.description).toContain("exactly once");
    expect(resume.inputSchema).toMatchObject({
      type: "object",
      required: ["approvalId"],
      additionalProperties: false,
    });
  });

  test("full in-chat loop: gated call → human decides in the app → resume tool executes once", async () => {
    const runtime = fixture();
    const { client } = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: { resumeTool: true },
    });

    const pending = parseEnvelope(
      (await client.callTool({ name: "orders_refund", arguments: REFUND })) as never,
    );
    if (pending.status !== "approval-required") expect.unreachable();

    // Before the decision: the owner sees the real, retryable pending state.
    const early = parseEnvelope(
      (await client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: pending.approvalId },
      })) as never,
    );
    if (early.status !== "error") expect.unreachable();
    expect(early.error.code).toBe("APPROVAL_PENDING");
    expect(early.error.retryable).toBe(true);

    // The decision happens in the APP (dashboard/Slack), never over MCP.
    await runtime.approvals.decide(pending.approvalId, { status: "approved", approver: priya });

    const final = parseEnvelope(
      (await client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: pending.approvalId },
      })) as never,
    );
    if (final.status !== "ok") expect.unreachable();
    expect(final.data).toEqual({ refundId: "ref_1", amount: 649 });

    // Single-use: the consumed record refuses a second execution.
    const again = parseEnvelope(
      (await client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: pending.approvalId },
      })) as never,
    );
    if (again.status !== "error") expect.unreachable();
    expect(again.error.code).toBe("APPROVAL_CONSUMED");
  });

  test("another session's actor cannot resume: byte-identical to an unknown id", async () => {
    const runtime = fixture();
    const danaSession = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: { resumeTool: true },
    });
    const mallorySession = await connectedClient(runtime, {
      createContext: () => ({ actor: { id: "u_mallory", kind: "user" }, context: {} }),
      approvals: { resumeTool: true },
    });

    const pending = parseEnvelope(
      (await danaSession.client.callTool({ name: "orders_refund", arguments: REFUND })) as never,
    );
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approvalId, { status: "approved", approver: priya });

    const stolen = parseEnvelope(
      (await mallorySession.client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: pending.approvalId },
      })) as never,
    );
    const unknown = parseEnvelope(
      (await mallorySession.client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: "apr_nope" },
      })) as never,
    );
    expect(stolen).toEqual(unknown);
    if (stolen.status !== "error") expect.unreachable();
    expect(stolen.error.code).toBe("INTERNAL_ERROR");

    // The record is untouched: its owner still executes it.
    const final = parseEnvelope(
      (await danaSession.client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: pending.approvalId },
      })) as never,
    );
    expect(final.status).toBe("ok");
  });

  test("approvals requested on another surface cannot be resumed over MCP", async () => {
    const runtime = fixture();
    const { client } = await connectedClient(runtime, {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: { resumeTool: true },
    });

    // Same actor, but the suspension belongs to the app's own AI-SDK loop.
    const pending = await runtime.invoke("orders.refund", REFUND, {
      actor: dana,
      context: {},
      surface: "aiSdk",
    });
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });

    const crossed = parseEnvelope(
      (await client.callTool({
        name: "approvals_resume",
        arguments: { approvalId: pending.approval.id },
      })) as never,
    );
    if (crossed.status !== "error") expect.unreachable();
    expect(crossed.error.code).toBe("INTERNAL_ERROR");
  });

  test("missing approvalId is refused with INPUT_INVALID, not a protocol error", async () => {
    const { client } = await connectedClient(fixture(), {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: { resumeTool: true },
    });
    const envelope = parseEnvelope(
      (await client.callTool({ name: "approvals_resume", arguments: {} })) as never,
    );
    if (envelope.status !== "error") expect.unreachable();
    expect(envelope.error.code).toBe("INPUT_INVALID");
  });

  test("custom name/description are honored; capability collisions throw at startup", async () => {
    const { client } = await connectedClient(fixture(), {
      createContext: () => ({ actor: dana, context: {} }),
      approvals: { resumeTool: { name: "run_approved", description: "Run it." } },
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("run_approved");
    expect(names).not.toContain("approvals_resume");

    expect(() =>
      createMCPServer(fixture(), {
        createContext: () => ({ actor: dana, context: {} }),
        approvals: { resumeTool: { name: "orders_refund" } },
      }),
    ).toThrowError(/collision/);
  });
});
