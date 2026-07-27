import { describe, expect, test } from "vitest";
import { os } from "@orpc/server";
import * as z from "zod";
import { createAgentRuntime } from "../src/runtime/create";
import { createCapabilityRegistry } from "../src/registry";
import { createInMemoryApprovalCoordinator } from "../src/approvals/in-memory";
import { agentProcedure } from "../src/procedure";
import { definePolicy } from "../src/policy/define";
import { allow, deny, requireApproval } from "../src/policy/helpers";
import { canonicalJson, hashInput } from "../src/canonical";
import { capturedEvents, dana, mutableClock, priya } from "./helpers";
import type { ApprovalCoordinator } from "../src/approvals/types";
import type { AgentInvocationInfo } from "../src/types";

const base = agentProcedure(os.$context<{ agent?: AgentInvocationInfo }>());

const refundLimit = definePolicy("refund-limit", ({ input }) => {
  const { amount } = input as { amount: number };
  if (amount >= 5000) return deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.");
  if (amount > 500) return requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager" });
  return allow();
});

const executedWith: AgentInvocationInfo[] = [];
const refund = base
  .meta({
    agent: {
      description: "Refund an order.",
      expose: { direct: true, aiSdk: true },
      sideEffect: "write",
      risk: "high",
      policies: [refundLimit],
    },
  })
  .input(z.object({ orderId: z.string(), amount: z.number().positive(), reason: z.string().min(3) }))
  .output(z.object({ refundId: z.string(), amount: z.number() }))
  .handler(async ({ input, context }) => {
    executedWith.push(context.agent!);
    return { refundId: "ref_77", amount: input.amount };
  });

function makeRuntime(overrides?: {
  coordinator?: ApprovalCoordinator;
  rejectSelfApproval?: boolean;
  handler?: (req: import("../src/approvals/types").ApprovalRequest) => Promise<
    import("../src/approvals/types").ApprovalDecision | undefined
  >;
  policies?: import("../src/policy/types").AgentPolicy[];
  expiresInMs?: number;
}) {
  const clock = mutableClock();
  const audit = capturedEvents();
  const coordinator =
    overrides?.coordinator ?? createInMemoryApprovalCoordinator({ now: clock.now });
  const registry = createCapabilityRegistry({ orders: { refund } });
  const runtime = createAgentRuntime({
    registry,
    policies: overrides?.policies ?? [],
    approvals: {
      coordinator,
      ...(overrides?.handler ? { handler: overrides.handler } : {}),
      ...(overrides?.rejectSelfApproval !== undefined
        ? { rejectSelfApproval: overrides.rejectSelfApproval }
        : {}),
    },
    audit: audit.sink,
    now: clock.now,
    ...(overrides?.expiresInMs ? { defaults: { approvalExpiresInMs: overrides.expiresInMs } } : {}),
  });
  return { runtime, audit, clock, coordinator };
}

const options = { actor: dana, context: {} };
const REFUND_649 = { orderId: "ord_42", amount: 649, reason: "damaged item" };

describe("full lifecycle", () => {
  test("invoke → approval-required → decide → resume → completed, as the original actor", async () => {
    const { runtime, audit } = makeRuntime();
    executedWith.length = 0;

    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    const approval = pending.approval;
    expect(approval.status).toBe("pending");
    expect(approval.reasons).toEqual(["Refund of $649 exceeds $500"]);
    expect(approval.types).toEqual(["manager"]);
    expect(approval.capabilityId).toBe("orders.refund");
    expect(approval.actor.id).toBe("u_dana");
    expect(approval.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.sideEffect).toBe("write");
    expect(approval.risk).toBe("high");
    // Default expiry: 15 minutes.
    expect(approval.expiresAt.getTime() - approval.requestedAt.getTime()).toBe(900_000);

    await runtime.approvals.decide(approval.id, {
      status: "approved",
      approver: priya,
      comment: "Verified with customer",
    });

    const final = await runtime.resume(approval.id, { context: {} });
    if (final.status !== "completed") expect.unreachable();
    expect(final.output).toEqual({ refundId: "ref_77", amount: 649 });
    // New executionId, linked to the approval in events.
    expect(final.executionId).not.toBe(pending.executionId);

    // The handler ran as Dana with the approver recorded.
    expect(executedWith).toHaveLength(1);
    expect(executedWith[0]!.actor.id).toBe("u_dana");
    expect(executedWith[0]!.approval).toEqual({ id: approval.id, approver: priya });

    // Audit sequence for the whole story.
    expect(audit.types()).toEqual([
      "capability.requested",
      "capability.approval_requested",
      "capability.approved",
      "capability.started",
      "capability.completed",
    ]);
    const started = audit.ofType("capability.started")[0]!;
    expect(started.data.approvalId).toBe(approval.id);
    expect(started.executionId).toBe(final.executionId);
    const approved = audit.ofType("capability.approved")[0]!;
    expect(approved.actor).toEqual({ id: "u_priya", kind: "user" });
    expect(approved.data.comment).toBe("Verified with customer");
  });

  test("record is consumed exactly once; a second resume fails APPROVAL_CONSUMED", async () => {
    const { runtime } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });

    expect((await runtime.resume(pending.approval.id, { context: {} })).status).toBe("completed");
    const again = await runtime.resume(pending.approval.id, { context: {} });
    if (again.status !== "failed") expect.unreachable();
    expect(again.error.code).toBe("APPROVAL_CONSUMED");
  });

  test("concurrent resume: atomic consumption lets exactly one execute", async () => {
    const { runtime } = makeRuntime();
    executedWith.length = 0;
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });

    const [a, b] = await Promise.all([
      runtime.resume(pending.approval.id, { context: {} }),
      runtime.resume(pending.approval.id, { context: {} }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["completed", "failed"]);
    const failed = a.status === "failed" ? a : b;
    if (failed.status !== "failed") expect.unreachable();
    expect(failed.error.code).toBe("APPROVAL_CONSUMED");
    expect(executedWith).toHaveLength(1);
  });
});

describe("failure codes", () => {
  test("APPROVAL_PENDING: resume before a decision exists (retryable)", async () => {
    const { runtime } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    const result = await runtime.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_PENDING");
    expect(result.error.retryable).toBe(true);
  });

  test("APPROVAL_REJECTED: resume after rejection", async () => {
    const { runtime, audit } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, {
      status: "rejected",
      approver: priya,
      comment: "Not warranted",
    });
    expect(audit.ofType("capability.rejected")).toHaveLength(1);
    const result = await runtime.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_REJECTED");
  });

  test("APPROVAL_EXPIRED: resume after expiry (clock-driven); decide after expiry throws", async () => {
    const { runtime, clock } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });

    clock.advance(16 * 60 * 1000);
    const result = await runtime.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_EXPIRED");

    // Deciding an expired pending record throws at the coordinator.
    const second = await runtime.invoke("orders.refund", REFUND_649, options);
    if (second.status !== "approval-required") expect.unreachable();
    clock.advance(16 * 60 * 1000);
    await expect(
      runtime.approvals.decide(second.approval.id, { status: "approved", approver: priya }),
    ).rejects.toThrowError(/not pending|expired/);
  });

  test("APPROVAL_SELF_APPROVAL: approver identity equals requester (SI-4)", async () => {
    const { runtime } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: dana });
    const result = await runtime.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_SELF_APPROVAL");
  });

  test("rejectSelfApproval: false permits requester-approved execution", async () => {
    const { runtime } = makeRuntime({ rejectSelfApproval: false });
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: dana });
    const result = await runtime.resume(pending.approval.id, { context: {} });
    expect(result.status).toBe("completed");
  });

  test("APPROVAL_INPUT_MISMATCH: stored input no longer matches its hash", async () => {
    const clock = mutableClock();
    const inner = createInMemoryApprovalCoordinator({ now: clock.now });
    // A corrupting store: returns tampered input on read.
    const corrupting: ApprovalCoordinator = {
      ...inner,
      create: (r) => inner.create(r),
      decide: (id, d) => inner.decide(id, d),
      markConsumed: (id, e) => inner.markConsumed(id, e),
      async get(id) {
        const record = await inner.get(id);
        if (!record) return null;
        return { ...record, input: { ...(record.input as object), amount: 5 } };
      },
    };
    const { runtime } = makeRuntime({ coordinator: corrupting });
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });
    const result = await runtime.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_INPUT_MISMATCH");
    expect(result.error.exposeToModel).toBe(false);
  });

  test("APPROVAL_UNSERIALIZABLE_INPUT: approval gate on unhashable validated input", async () => {
    const gated = base
      .meta({
        agent: {
          description: "Gated, schema-less.",
          expose: { direct: true },
          sideEffect: "write",
          risk: "high",
          approval: { required: true },
        },
      })
      .handler(async () => ({}));
    const registry = createCapabilityRegistry({ gated });
    const runtime = createAgentRuntime({ registry });
    const result = await runtime.invoke("gated", { fn: () => 1 }, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_UNSERIALIZABLE_INPUT");
    expect(result.error.exposeToModel).toBe(false);
  });

  test("resume of an unknown approval id fails without throwing", async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.resume("apr_nope", { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.stage).toBe("approval");
  });
});

describe("input binding (SI-5)", () => {
  test("canonical JSON is key-order independent and value-sensitive", async () => {
    expect(canonicalJson({ a: 1, b: { d: [1, 2], c: "x" } })).toBe(
      canonicalJson({ b: { c: "x", d: [1, 2] }, a: 1 }),
    );
    expect(await hashInput({ a: 1, b: 2 })).toBe(await hashInput({ b: 2, a: 1 }));
    expect(await hashInput({ a: 1 })).not.toBe(await hashInput({ a: 2 }));
    expect(await hashInput([1, 2])).not.toBe(await hashInput([2, 1]));
    // Dates serialize via toJSON.
    expect(canonicalJson(new Date("2026-01-01T00:00:00Z"))).toBe('"2026-01-01T00:00:00.000Z"');
    // Function-valued properties would make the hash bind LESS than what
    // executes — rejected, unlike permissive JSON.stringify.
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(canonicalJson({ present: 1, absent: undefined })).toBe('{"present":1}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson(10n)).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow();
  });

  test("the stored validated input executes on resume — not whatever the caller has now", async () => {
    const { runtime } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });
    const final = await runtime.resume(pending.approval.id, { context: {} });
    if (final.status !== "completed") expect.unreachable();
    expect((final.output as { amount: number }).amount).toBe(649);
  });

  test("resume re-validates against the current schema (deploys change)", async () => {
    // Two runtimes over one coordinator simulate a redeploy with a tighter schema.
    const clock = mutableClock();
    const coordinator = createInMemoryApprovalCoordinator({ now: clock.now });
    const looseRegistry = createCapabilityRegistry({ orders: { refund } });
    const loose = createAgentRuntime({
      registry: looseRegistry,
      approvals: { coordinator },
      now: clock.now,
    });

    const strictRefund = base
      .meta({
        agent: {
          description: "Refund (tightened).",
          expose: { direct: true },
          sideEffect: "write",
          risk: "high",
        },
      })
      .input(
        z.object({
          orderId: z.string(),
          amount: z.number().positive().max(500),
          reason: z.string().min(3),
        }),
      )
      .handler(async () => ({ refundId: "x", amount: 0 }));
    const tightened = createAgentRuntime({
      registry: createCapabilityRegistry({ orders: { refund: strictRefund } }),
      approvals: { coordinator },
      now: clock.now,
    });

    const pending = await loose.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await loose.approvals.decide(pending.approval.id, { status: "approved", approver: priya });

    const result = await tightened.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("INPUT_INVALID");
    // Not consumed: the gate failed before consumption.
    const record = await coordinator.get(pending.approval.id);
    expect(record!.status).toBe("approved");
  });
});

describe("execution-phase policies at resume", () => {
  test("stage 9 re-runs execution-phase policies with the approval record present", async () => {
    const seenApprovals: (string | undefined)[] = [];
    let worldIsStale = false;
    const freshness = definePolicy(
      "freshness",
      ({ approval }) => {
        seenApprovals.push(approval?.id);
        return worldIsStale ? deny(undefined, "The world changed.") : allow();
      },
      { phases: ["execution"] },
    );
    const { runtime } = makeRuntime({ policies: [freshness] });
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(pending.approval.id, { status: "approved", approver: priya });

    worldIsStale = true;
    const result = await runtime.resume(pending.approval.id, { context: {} });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(seenApprovals).toEqual([pending.approval.id]);
  });
});

describe("static approval gate", () => {
  test("meta.approval.required gates every invocation with merged reason/type", async () => {
    const send = base
      .meta({
        agent: {
          description: "Send message.",
          expose: { direct: true },
          sideEffect: "external",
          risk: "high",
          approval: { required: true, type: "human-confirmation", expiresInMs: 60_000 },
        },
      })
      .input(z.object({ draftId: z.string() }))
      .handler(async () => ({ messageId: "m_1" }));
    const registry = createCapabilityRegistry({ send });
    const audit = capturedEvents();
    const runtime = createAgentRuntime({ registry, audit: audit.sink });
    const result = await runtime.invoke("send", { draftId: "d_1" }, options);
    if (result.status !== "approval-required") expect.unreachable();
    expect(result.approval.types).toEqual(["human-confirmation"]);
    expect(result.approval.reasons).toEqual(["Approval is required for send."]);
    expect(
      result.approval.expiresAt.getTime() - result.approval.requestedAt.getTime(),
    ).toBe(60_000);
  });
});

describe("inline handler mode", () => {
  test("approved inline: executes in the same call with approval events", async () => {
    const { runtime, audit } = makeRuntime({
      handler: async (req) =>
        req.types.includes("manager")
          ? { status: "approved", approver: { id: "slack-bridge", kind: "service" } }
          : undefined,
    });
    const result = await runtime.invoke("orders.refund", REFUND_649, options);
    if (result.status !== "completed") expect.unreachable();
    expect(audit.types()).toEqual([
      "capability.requested",
      "capability.approval_requested",
      "capability.approved",
      "capability.started",
      "capability.completed",
    ]);
  });

  test("rejected inline: APPROVAL_REJECTED in the same call", async () => {
    const { runtime } = makeRuntime({
      handler: async () => ({
        status: "rejected",
        approver: { id: "slack-bridge", kind: "service" },
      }),
    });
    const result = await runtime.invoke("orders.refund", REFUND_649, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_REJECTED");
  });

  test("inline self-approval is rejected under the default setting", async () => {
    const { runtime } = makeRuntime({
      handler: async () => ({ status: "approved", approver: dana }),
    });
    const result = await runtime.invoke("orders.refund", REFUND_649, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_SELF_APPROVAL");
  });

  test("handler returning undefined defers to the coordinator (suspend/resume)", async () => {
    const { runtime } = makeRuntime({ handler: async () => undefined });
    const result = await runtime.invoke("orders.refund", REFUND_649, options);
    expect(result.status).toBe("approval-required");
  });

  test("a throwing inline handler fails the execution without throwing", async () => {
    const { runtime } = makeRuntime({
      handler: async () => {
        throw new Error("prompt UI crashed");
      },
    });
    const result = await runtime.invoke("orders.refund", REFUND_649, options);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.stage).toBe("approval");
  });
});

describe("coordinator contract", () => {
  test("list filters by status, capability, and actor", async () => {
    const { runtime, coordinator } = makeRuntime();
    await runtime.invoke("orders.refund", REFUND_649, options);
    const second = await runtime.invoke("orders.refund", { ...REFUND_649, amount: 700 }, options);
    if (second.status !== "approval-required") expect.unreachable();
    await runtime.approvals.decide(second.approval.id, { status: "rejected", approver: priya });

    const pending = await coordinator.list!({ status: "pending" });
    expect(pending).toHaveLength(1);
    const forDana = await coordinator.list!({ actorId: "u_dana" });
    expect(forDana).toHaveLength(2);
    const forCap = await coordinator.list!({ capabilityId: "orders.refund", status: "rejected" });
    expect(forCap).toHaveLength(1);
  });

  test("markConsumed refuses non-approved records", async () => {
    const { runtime, coordinator } = makeRuntime();
    const pending = await runtime.invoke("orders.refund", REFUND_649, options);
    if (pending.status !== "approval-required") expect.unreachable();
    await expect(coordinator.markConsumed(pending.approval.id, "exe_x")).rejects.toThrowError(
      /cannot be consumed/,
    );
  });
});
