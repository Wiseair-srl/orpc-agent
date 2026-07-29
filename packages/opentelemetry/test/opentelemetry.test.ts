import { beforeEach, describe, expect, test } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode, trace, context as otelContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
import { os } from "@orpc/server";
import * as z from "zod";
import {
  agentProcedure,
  createAgentRuntime,
  defineGovernance,
  createCapabilityRegistry,
  definePolicy,
  deny,
  allow,
  type Actor,
} from "@orpc-agent/core";
import { createOpenTelemetryTracing } from "../src/index";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("test");

const actor: Actor = { id: "u_dana", kind: "user" };
const base = agentProcedure(os.$context<object>());

const registry = createCapabilityRegistry({
  orders: {
    refund: base
      .meta({
        agent: {
          description: "Refund.",
          expose: { direct: true },
          sideEffect: "write",
          risk: "high",
          approval: { required: true },
          policies: [definePolicy("noop", () => allow())],
        },
      })
      .input(z.object({ amount: z.number() }))
      .handler(async ({ input }) => ({ refunded: input.amount })),
    search: base
      .meta({
        agent: {
          description: "Search.",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
          policies: [definePolicy("gate", () => allow())],
        },
      })
      .input(z.object({ q: z.string() }))
      .handler(async ({ input }) => ({ found: input.q })),
    denied: base
      .meta({
        agent: {
          description: "Denied.",
          expose: { direct: true },
          sideEffect: "read",
          risk: "low",
          policies: [definePolicy("no", () => deny(undefined, "No."))],
        },
      })
      .input(z.object({}))
      .handler(async () => ({})),
  },
});

function spansByName(): Map<string, ReadableSpan[]> {
  const map = new Map<string, ReadableSpan[]>();
  for (const span of exporter.getFinishedSpans()) {
    const list = map.get(span.name) ?? [];
    list.push(span);
    map.set(span.name, list);
  }
  return map;
}

beforeEach(() => {
  exporter.reset();
});

describe("span tree", () => {
  test("completed call: capability_call with policy_evaluation and procedure_execution children", async () => {
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), tracing: createOpenTelemetryTracing({ tracer }) });
    await runtime.invoke("orders.search", { q: "x" }, { actor, context: {} });

    const spans = spansByName();
    expect([...spans.keys()].sort()).toEqual([
      "agent.capability_call",
      "agent.policy_evaluation",
      "agent.procedure_execution",
    ]);

    const root = spans.get("agent.capability_call")![0]!;
    const policy = spans.get("agent.policy_evaluation")![0]!;
    const exec = spans.get("agent.procedure_execution")![0]!;
    expect(root.status.code).toBe(SpanStatusCode.OK);
    expect(policy.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(exec.parentSpanContext?.spanId).toBe(root.spanContext().spanId);

    expect(root.attributes["orpc_agent.capability_id"]).toBe("orders.search");
    expect(root.attributes["orpc_agent.surface"]).toBe("direct");
    expect(root.attributes["orpc_agent.actor_kind"]).toBe("user");
    expect(root.attributes["orpc_agent.outcome"]).toBe("completed");
    expect(root.attributes["orpc_agent.side_effect"]).toBe("read");
    expect(root.attributes["orpc_agent.risk"]).toBe("low");
    expect(String(root.attributes["orpc_agent.execution_id"])).toMatch(/^exe_/);
    expect(exec.attributes["orpc_agent.attempt"]).toBe(1);
  });

  test("approval-required ends the root span OK with the approval span child", async () => {
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), tracing: createOpenTelemetryTracing({ tracer }) });
    await runtime.invoke("orders.refund", { amount: 10 }, { actor, context: {} });

    const spans = spansByName();
    const root = spans.get("agent.capability_call")![0]!;
    const approval = spans.get("agent.approval_request")![0]!;
    expect(root.status.code).toBe(SpanStatusCode.OK); // a suspension is not an error
    expect(root.attributes["orpc_agent.outcome"]).toBe("approval-required");
    expect(String(root.attributes["orpc_agent.approval_id"])).toMatch(/^apr_/);
    expect(approval.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(spans.get("agent.procedure_execution")).toBeUndefined(); // nothing executed
  });

  test("failure: error status and error code attribute", async () => {
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), tracing: createOpenTelemetryTracing({ tracer }) });
    await runtime.invoke("orders.denied", {}, { actor, context: {} });
    const root = spansByName().get("agent.capability_call")![0]!;
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes["orpc_agent.outcome"]).toBe("failed");
    expect(root.attributes["orpc_agent.error_code"]).toBe("POLICY_DENIED");
  });

  test("parents under the active OTel context at invoke time", async () => {
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), tracing: createOpenTelemetryTracing({ tracer }) });
    const httpSpan = tracer.startSpan("POST /api/chat");
    await otelContext.with(trace.setSpan(otelContext.active(), httpSpan), () =>
      runtime.invoke("orders.search", { q: "x" }, { actor, context: {} }),
    );
    httpSpan.end();
    const root = spansByName().get("agent.capability_call")![0]!;
    expect(root.parentSpanContext?.spanId).toBe(httpSpan.spanContext().spanId);
  });
});

describe("attribute safety (SI-10)", () => {
  test("no payloads anywhere; actor id absent by default", async () => {
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), tracing: createOpenTelemetryTracing({ tracer }) });
    await runtime.invoke("orders.search", { q: "SECRET_QUERY" }, { actor, context: {} });
    for (const span of exporter.getFinishedSpans()) {
      const serialized = JSON.stringify(span.attributes);
      expect(serialized).not.toContain("SECRET_QUERY");
      expect(span.attributes["orpc_agent.actor_id"]).toBeUndefined();
    }
  });

  test("actorIdAttribute: true opts in to the actor id", async () => {
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry }), tracing: createOpenTelemetryTracing({ tracer, actorIdAttribute: true }) });
    await runtime.invoke("orders.search", { q: "x" }, { actor, context: {} });
    const root = spansByName().get("agent.capability_call")![0]!;
    expect(root.attributes["orpc_agent.actor_id"]).toBe("u_dana");
  });
});
