import { describe, expect, test } from "vitest";
import { generateText, stepCountIs, type ToolSet } from "ai";
import type { LanguageModelV2 } from "@ai-sdk/provider";
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
import { toAISDKTools, type AISDKToolResult } from "../src/index";
import { describeAdapterConformance, type ConformanceHarness } from "../../../test-fixtures/conformance";
import { buildFixtureRegistry, collidingToolNaming } from "../../../test-fixtures/registry";

const actor: Actor = { id: "u_dana", kind: "user" };
const context = {};

/** Minimal scripted LanguageModelV2 — no live provider, no test-helper deps. */
function scriptedModel(
  responses: Awaited<ReturnType<LanguageModelV2["doGenerate"]>>[],
): LanguageModelV2 {
  let call = 0;
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "scripted",
    supportedUrls: {},
    async doGenerate() {
      const response = responses[call++];
      if (!response) throw new Error("scripted model exhausted");
      return response;
    },
    async doStream() {
      throw new Error("not scripted for streaming");
    },
  };
}

function fixtureRuntime(): AgentRuntime<object> {
  return createAgentRuntime<object>({ governance: defineGovernance({ registry: buildFixtureRegistry() }) });
}

// ---------------------------------------------------------------------------
// Shared adapter conformance checklist
// ---------------------------------------------------------------------------

describeAdapterConformance("ai-sdk", async (): Promise<ConformanceHarness> => {
  const runtime = fixtureRuntime();
  const tools = await toAISDKTools(runtime, { actor, context });

  const execute = async (
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<AISDKToolResult> => {
    const tool = tools[name];
    if (tool?.execute) {
      return (await tool.execute(args as never, {
        toolCallId: "call_1",
        messages: [],
        ...(options?.signal ? { abortSignal: options.signal } : {}),
      })) as AISDKToolResult;
    }
    // No wire protocol here: a call naming an unlisted tool models a hostile
    // client going straight to the runtime — which conceals (SI-2, SI-8).
    const result = await runtime.invoke(name, args, {
      actor,
      context,
      surface: "aiSdk",
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (result.status === "failed" || result.status === "cancelled") {
      return {
        status: "error",
        error: result.error.exposeToModel
          ? {
              code: result.error.code,
              message: result.error.publicMessage,
              retryable: result.error.retryable,
            }
          : { code: "INTERNAL_ERROR", message: "The operation failed.", retryable: false },
      };
    }
    throw new Error("unexpected non-failure for unlisted tool");
  };

  return {
    listToolNames: async () => Object.keys(tools),
    toolDescription: async (name) => tools[name]?.description,
    callTool: execute,
    buildWithCollidingNaming: () =>
      toAISDKTools(fixtureRuntime(), { actor, context, toolNaming: collidingToolNaming }),
  };
});

// ---------------------------------------------------------------------------
// Adapter-specific behavior
// ---------------------------------------------------------------------------

describe("per-request tool sets", () => {
  const hideForDana = definePolicy(
    "hide-for-dana",
    ({ actor: requester }) => (requester.id === "u_dana" ? hide() : allow()),
    { phases: ["discovery", "invocation"] },
  );

  const base = agentProcedure(os.$context<object>());
  const registry = createCapabilityRegistry({
    open: base
      .meta({
        agent: {
          description: "Open to all.",
          expose: { aiSdk: true },
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
          expose: { aiSdk: true },
          sideEffect: "read",
          risk: "high",
          policies: [hideForDana],
        },
      })
      .input(z.object({}))
      .handler(async () => ({})),
  });

  test("two actors get different tool sets from the same runtime", async () => {
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
    const danaTools = await toAISDKTools(runtime, { actor, context });
    const priyaTools = await toAISDKTools(runtime, {
      actor: { id: "u_priya", kind: "user" },
      context,
    });
    expect(Object.keys(danaTools)).toEqual(["open"]);
    expect(Object.keys(priyaTools)).toEqual(["open", "sensitive"]);
  });

  test("filter narrows the set (UX only)", async () => {
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry }) });
    const tools = await toAISDKTools(runtime, {
      actor: { id: "u_priya", kind: "user" },
      context,
      filter: (d) => d.risk === "low",
    });
    expect(Object.keys(tools)).toEqual(["open"]);
  });

  test("the model is never the actor: tool args cannot create or change identity (SI-3)", async () => {
    const seenActors: unknown[] = [];
    const whoami = agentProcedure(os.$context<object>())
      .meta({
        agent: {
          description: "Reports the bound actor.",
          expose: { aiSdk: true },
          sideEffect: "read",
          risk: "low",
        },
      })
      .handler(async ({ context }) => {
        seenActors.push((context as { agent: { actor: unknown } }).agent.actor);
        return { ok: true };
      });
    const runtime = createAgentRuntime<object>({ governance: defineGovernance({ registry: createCapabilityRegistry({ whoami }) }) });
    const tools = await toAISDKTools(runtime, { actor, context });
    // A prompt-injected model tries to smuggle an identity through arguments.
    const result = (await tools.whoami!.execute!(
      { actor: { id: "u_admin", kind: "user" }, role: "admin" } as never,
      { toolCallId: "call_1", messages: [] },
    )) as AISDKToolResult;
    expect(result.status).toBe("ok");
    expect(seenActors).toEqual([actor]); // still Dana — args changed nothing
  });

  test("inputSchema wraps the converted JSON Schema", async () => {
    const runtime = fixtureRuntime();
    const tools = await toAISDKTools(runtime, { actor, context });
    const echoSchema = tools.fixtures_echo?.inputSchema as { jsonSchema?: unknown };
    expect(echoSchema?.jsonSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });
});

// ---------------------------------------------------------------------------
// Scripted end-to-end chat (mocked model, no live provider)
// ---------------------------------------------------------------------------

describe("scripted generateText flow", () => {
  test("mock model drives a governed tool call end to end", async () => {
    const runtime = fixtureRuntime();
    const tools = (await toAISDKTools(runtime, { actor, context })) as ToolSet;

    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
    const model = scriptedModel([
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "fixtures_echo",
              input: JSON.stringify({ text: "hello" }),
            },
          ],
          finishReason: "tool-calls",
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "The echo returned hello." }],
          finishReason: "stop",
          usage,
          warnings: [],
        },
      ]);

    const result = await generateText({
      model,
      tools,
      prompt: "echo hello",
      stopWhen: stepCountIs(3),
    });

    expect(result.text).toBe("The echo returned hello.");
    const toolResults = result.steps.flatMap((s) => s.toolResults);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.output).toEqual({ status: "ok", data: { echoed: "hello" } });
  });

  test("approval-required surfaces to the model as a structured non-error", async () => {
    const runtime = fixtureRuntime();
    const tools = (await toAISDKTools(runtime, { actor, context })) as ToolSet;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
    const model = scriptedModel([
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "fixtures_gated",
              input: JSON.stringify({ target: "x" }),
            },
          ],
          finishReason: "tool-calls",
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Waiting for approval." }],
          finishReason: "stop",
          usage,
          warnings: [],
        },
      ]);

    const result = await generateText({ model, tools, prompt: "do it", stopWhen: stepCountIs(3) });
    const output = result.steps.flatMap((s) => s.toolResults)[0]!.output as {
      status: string;
      approvalId: string;
    };
    expect(output.status).toBe("approval-required");
    expect(output.approvalId).toMatch(/^apr_/);
  });
});
