import { describe, expect, test } from "vitest";
import { CapabilityError, definePolicy } from "@orpc-agent/core";
import {
  approvalProbe,
  capturedAudit,
  createAgentTestRuntime,
  fakeActor,
  testClock,
} from "../src/index";
import { REFUND_INPUT, capabilities, orgIsolation } from "./fixtures";

function makeRuntime(
  overrides: Partial<Parameters<typeof createAgentTestRuntime>[0]> = {},
) {
  return createAgentTestRuntime({
    registry: capabilities,
    policies: [orgIsolation],
    actor: fakeActor({ attributes: { orgId: "org_1", permissions: ["orders:refund"] } }),
    context: { organizationId: "org_1" },
    overrides: {
      "orders.refund": async ({ input }) => ({
        refundId: "ref_t",
        amount: (input as { amount: number }).amount,
        status: "issued",
      }),
      "orders.search": async () => ({ orders: [] }),
    },
    clock: testClock("2026-07-27T10:00:00Z"),
    ...overrides,
  });
}

describe("suite 1 — exposure (SI-1, SI-8)", () => {
  test("refund is not reachable over mcp", async () => {
    const t = makeRuntime();
    expect((await t.describe("mcp")).map((d) => d.id)).not.toContain("orders.refund");

    const r = await t.invoke("orders.refund", REFUND_INPUT, { surface: "mcp" });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.error.code).toBe("CAPABILITY_NOT_FOUND"); // concealed, not FORBIDDEN
    expect(t.audit.ofType("capability.denied")[0]!.data.reason).toBe("not-exposed"); // truth in audit
  });

  test("aiSdk lists it; describe snapshot per surface", async () => {
    const t = makeRuntime();
    expect((await t.describe("aiSdk")).map((d) => d.id)).toEqual([
      "orders.search",
      "orders.refund",
      "customers.get",
    ]);
    expect((await t.describe("mcp")).map((d) => d.id)).toEqual([
      "orders.search",
      "customers.get",
    ]);
  });
});

describe("suite 2 — policy decisions", () => {
  test.each([
    [400, "completed"],
    [649, "approval-required"],
    [9000, "failed"], // POLICY_DENIED
  ] as const)("refund of $%i → %s", async (amount, status) => {
    const t = makeRuntime();
    const r = await t.invoke("orders.refund", { orderId: "o1", amount, reason: "dmg" });
    expect(r.status).toBe(status);
    if (r.status === "failed") expect(r.error.code).toBe("POLICY_DENIED");
  });

  test("policy exceptions fail closed (SI-7)", async () => {
    const boom = definePolicy("boom", () => {
      throw new Error("db down");
    });
    const t = makeRuntime({ policies: [boom] });
    const r = await t.invoke("orders.search", { query: "x" });
    if (r.status !== "failed") expect.unreachable();
    expect(r.error.code).toBe("POLICY_FAILED");
  });
});

describe("suite 3 — approval lifecycle (SI-4, SI-5)", () => {
  const gated = { orderId: "o1", amount: 649, reason: "dmg" };

  test("approve → resume → consumed", async () => {
    const t = makeRuntime();
    const p = await t.invoke("orders.refund", gated);
    expect(p.status).toBe("approval-required");
    if (p.status !== "approval-required") return;

    await t.approvals.approve(p.approval.id, fakeActor({ id: "u_manager" }));
    expect((await t.resume(p.approval.id)).status).toBe("completed");
    const again = await t.resume(p.approval.id);
    if (again.status !== "failed") expect.unreachable();
    expect(again.error.code).toBe("APPROVAL_CONSUMED");
  });

  test("self-approval is rejected", async () => {
    const t = makeRuntime();
    const p = await t.invoke("orders.refund", gated);
    if (p.status !== "approval-required") expect.unreachable();
    await t.approvals.approve(p.approval.id, t.defaultActor); // same identity as requester
    const r = await t.resume(p.approval.id);
    if (r.status !== "failed") expect.unreachable();
    expect(r.error.code).toBe("APPROVAL_SELF_APPROVAL");
  });

  test("expiry via clock", async () => {
    const t = makeRuntime();
    const p = await t.invoke("orders.refund", gated);
    if (p.status !== "approval-required") expect.unreachable();
    t.clock.advance("16m");
    await t.approvals.approve(p.approval.id, fakeActor({ id: "u_manager" })); // decide throws inside; probe swallows
    const r = await t.resume(p.approval.id);
    if (r.status !== "failed") expect.unreachable();
    expect(r.error.code).toBe("APPROVAL_EXPIRED");
  });

  test("pending approvals are queryable", async () => {
    const t = makeRuntime();
    const p = await t.invoke("orders.refund", gated);
    if (p.status !== "approval-required") expect.unreachable();
    const pending = await t.approvals.pending();
    expect(pending.map((r) => r.id)).toEqual([p.approval.id]);
    expect(pending[0]!.reasons).toEqual(["Refund of $649 exceeds $500"]);
  });
});

describe("suite 4 — redaction and error faces (SI-9, SI-10)", () => {
  test("model-visible output is redacted", async () => {
    const t = makeRuntime();
    const r = await t.invoke<{ email: string; paymentMethods?: unknown }>("customers.get", {
      id: "c1",
    });
    if (r.status !== "completed") expect.unreachable();
    expect(r.output.paymentMethods).toBeUndefined();
    expect(r.output.email).toMatch(/\*\*\*/);
  });

  test("undeclared handler errors are concealed", async () => {
    const t = makeRuntime({
      overrides: {
        "orders.search": async () => {
          throw new Error("pg: secret_table");
        },
      },
    });
    const r = await t.invoke("orders.search", { query: "x" });
    if (r.status !== "failed") expect.unreachable();
    expect(r.error.exposeToModel).toBe(false);
    expect(r.error.publicMessage).toBe("The operation failed.");
    expect(r.error.publicMessage).not.toMatch(/secret_table/);
  });
});

describe("suite 5 — bounded execution (SI-11, SI-12)", () => {
  test("timeout cancels and reports", async () => {
    const t = makeRuntime({
      overrides: {
        "orders.search": ({ signal }) =>
          new Promise((_, rej) =>
            signal!.addEventListener("abort", () => rej(signal!.reason), { once: true }),
          ),
      },
    });
    const r = await t.invoke("orders.search", { query: "x" }, { timeoutMs: 10 });
    expect(r.status).toBe("cancelled");
    if (r.status !== "cancelled") return;
    expect(r.error.code).toBe("TIMEOUT");
  });

  test("writes are not auto-retried", async () => {
    let calls = 0;
    const t = makeRuntime({
      overrides: {
        "orders.refund": async () => {
          calls++;
          throw new CapabilityError({ code: "EXECUTION_FAILED", retryable: true });
        },
      },
    });
    const r = await t.invoke("orders.refund", REFUND_INPUT);
    expect(r.status).toBe("failed");
    expect(calls).toBe(1); // SI-11: no retry without idempotent+config
  });

  test("audit trail is queryable through t.audit", async () => {
    const t = makeRuntime();
    const p = await t.invoke("orders.refund", { orderId: "o1", amount: 649, reason: "dmg" });
    if (p.status !== "approval-required") expect.unreachable();
    await t.approvals.approve(p.approval.id, fakeActor({ id: "u_manager" }));
    await t.resume(p.approval.id);
    expect(t.audit.events().map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "capability.requested",
        "capability.approval_requested",
        "capability.approved",
        "capability.started",
        "capability.completed",
      ]),
    );
  });
});

describe("test runtime seams", () => {
  test("auto-approve executes gated capabilities with a distinct automation approver", async () => {
    const t = makeRuntime({ approvals: "auto-approve" });
    const r = await t.invoke("orders.refund", { orderId: "o1", amount: 649, reason: "dmg" });
    expect(r.status).toBe("completed");
    const approved = t.audit.ofType("capability.approved")[0]!;
    expect(approved.data.approver).toEqual({ id: "auto-approver", kind: "automation" });
  });

  test("auto-reject fails gated capabilities without executing", async () => {
    const t = makeRuntime({ approvals: "auto-reject" });
    const r = await t.invoke("orders.refund", { orderId: "o1", amount: 649, reason: "dmg" });
    if (r.status !== "failed") expect.unreachable();
    expect(r.error.code).toBe("APPROVAL_REJECTED");
  });

  test("per-call actor override supports actor-matrix tests", async () => {
    const t = makeRuntime();
    const wrongOrg = await t.invoke(
      "orders.search",
      { query: "x" },
      { actor: fakeActor({ id: "intruder", attributes: { orgId: "org_2" } }) },
    );
    if (wrongOrg.status !== "failed") expect.unreachable();
    expect(wrongOrg.error.code).toBe("POLICY_DENIED");
  });

  test("per-call timeoutMs overrides capability meta timeouts", async () => {
    const t = makeRuntime({
      overrides: {
        "orders.search": ({ signal }) =>
          new Promise((_, rej) =>
            signal!.addEventListener("abort", () => rej(signal!.reason), { once: true }),
          ),
      },
    });
    const r = await t.invoke("orders.search", { query: "x" }, { timeoutMs: 15 });
    expect(r.status).toBe("cancelled");
  });

  test("overrides referencing unknown capabilities fail loudly", () => {
    expect(() => makeRuntime({ overrides: { "no.such": async () => ({}) } })).toThrowError(
      /unknown capabilities/,
    );
  });

  test("real handlers run when overrides are omitted (integration mode)", async () => {
    const t = createAgentTestRuntime({ registry: capabilities });
    const r = await t.invoke<{ refundId: string }>("orders.refund", REFUND_INPUT);
    if (r.status !== "completed") expect.unreachable();
    expect(r.output.refundId).toBe("ref_real");
  });
});

describe("fakes", () => {
  test("fakeActor has stable defaults", () => {
    expect(fakeActor()).toEqual({ id: "test-user", kind: "user" });
    expect(fakeActor({ id: "x", kind: "service" }).kind).toBe("service");
  });

  test("testClock advances by string durations", () => {
    const clock = testClock("2026-01-01T00:00:00Z");
    clock.advance("15m");
    clock.advance("30s");
    clock.advance(500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:15:30.500Z");
    expect(() => clock.advance("15x" as never)).toThrow();
  });

  test("capturedAudit doubles as a plain sink", () => {
    const sink = capturedAudit();
    sink({
      type: "capabilities.discovered",
      timestamp: new Date(),
      surface: "test",
      actor: { id: "a", kind: "user" },
      data: { capabilityIds: [] },
    });
    expect(sink.events()).toHaveLength(1);
    expect(sink.ofType("capabilities.discovered")).toHaveLength(1);
    sink.clear();
    expect(sink.events()).toHaveLength(0);
  });

  test("approvalProbe works standalone as a coordinator", async () => {
    const probe = approvalProbe();
    const record = await probe.create({
      id: "apr_1",
      capabilityId: "x",
      surface: "test",
      actor: fakeActor(),
      input: {},
      inputHash: "h",
      reasons: [],
      types: [],
      risk: "low",
      sideEffect: "read",
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(record.status).toBe("pending");
    expect(await probe.pending()).toHaveLength(1);
    await probe.approve("apr_1");
    expect((await probe.get("apr_1"))!.status).toBe("approved");
  });
});
