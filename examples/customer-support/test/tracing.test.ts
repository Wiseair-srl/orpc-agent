import { expect, test } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createOpenTelemetryTracing } from "@orpc-agent/opentelemetry";
import { makeApp } from "../src/app";
import { decideApproval, resumeApproved } from "../src/dashboard";

/**
 * Acceptance criterion 6: the OpenTelemetry in-memory exporter shows the
 * documented span tree with no payload attributes.
 */

test("the documented span tree, payload-free", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const app = makeApp({
    tracing: createOpenTelemetryTracing({ tracer: provider.getTracer("example") }),
  });
  const dana = app.sessions.dana;

  const pending = await app.runtime.invoke(
    "orders.refund",
    { orderId: "ord_42", amount: 649, reason: "damaged item" },
    { actor: app.actorFrom(dana), context: app.contextFor(dana), surface: "aiSdk" },
  );
  if (pending.status !== "approval-required") expect.unreachable();
  await decideApproval(app, app.sessions.priya, pending.approval.id, { approved: true });
  await resumeApproved(app, pending.approval.id, dana);

  const spans = exporter.getFinishedSpans();
  const names = spans.map((s) => s.name).sort();
  expect(names).toEqual([
    "agent.approval_request",
    "agent.capability_call", // suspension (exe_01)
    "agent.capability_call", // resumption (exe_02)
    "agent.policy_evaluation",
    "agent.procedure_execution",
  ]);

  const roots = spans.filter((s) => s.name === "agent.capability_call");
  const children = spans.filter((s) => s.name !== "agent.capability_call");
  for (const child of children) {
    expect(roots.map((r) => r.spanContext().spanId)).toContain(
      child.parentSpanContext?.spanId,
    );
  }

  // No payloads, no actor ids by default (SI-10).
  for (const span of spans) {
    const attributes = JSON.stringify(span.attributes);
    expect(attributes).not.toContain("damaged item");
    expect(attributes).not.toContain("ord_42");
    expect(span.attributes["orpc_agent.actor_id"]).toBeUndefined();
  }
  const resumption = roots.find((r) => r.attributes["orpc_agent.outcome"] === "completed")!;
  expect(resumption.attributes["orpc_agent.capability_id"]).toBe("orders.refund");
  expect(String(resumption.attributes["orpc_agent.approval_id"])).toMatch(/^apr_/);
});
