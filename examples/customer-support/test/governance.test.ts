import { describe, expect, test } from "vitest";
import { makeApp } from "../src/app";
import { decideApproval, listPendingApprovals, resumeApproved } from "../src/dashboard";

const REFUND = (amount: number) => ({ orderId: "ord_42", amount, reason: "damaged item" });

function invokeAsDana(app: ReturnType<typeof makeApp>) {
  const dana = app.sessions.dana;
  return (capabilityId: string, input: unknown, surface: "aiSdk" | "direct" | "mcp" = "aiSdk") =>
    app.runtime.invoke(capabilityId, input, {
      actor: app.actorFrom(dana),
      context: app.contextFor(dana),
      surface,
    });
}

describe("the refund policy table (400 / 649 / 9000)", () => {
  test.each([
    [400, "completed"],
    [649, "approval-required"],
    [9000, "failed"],
  ] as const)("refund of $%i → %s", async (amount, expected) => {
    const app = makeApp();
    const result = await invokeAsDana(app)("orders.refund", REFUND(amount));
    expect(result.status).toBe(expected);
    if (result.status === "failed") {
      expect(result.error.code).toBe("POLICY_DENIED");
      expect(result.error.publicMessage).toBe(
        "Refunds of $5000 or more cannot be issued by agents.",
      );
    }
  });
});

describe("refusals (acceptance criterion 4)", () => {
  test("refund over MCP: CAPABILITY_NOT_FOUND, concealed (SI-8), audited truthfully", async () => {
    const app = makeApp();
    const result = await invokeAsDana(app)("orders.refund", REFUND(100), "mcp");
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("CAPABILITY_NOT_FOUND");
    const denied = app.auditTrail.find((e) => e.type === "capability.denied");
    expect(denied && "data" in denied && (denied.data as { reason: string }).reason).toBe(
      "not-exposed",
    );
  });

  test("self-approval: Dana approving her own refund fails at resume (SI-4)", async () => {
    const app = makeApp();
    const pending = await invokeAsDana(app)("orders.refund", REFUND(649));
    if (pending.status !== "approval-required") expect.unreachable();
    // Dana holds no approvals:decide permission — the dashboard route refuses her.
    await expect(
      decideApproval(app, app.sessions.dana, pending.approval.id, { approved: true }),
    ).rejects.toThrowError(/Missing permission/);
    // Even if the decision were recorded as Dana (a misconfigured surface),
    // the runtime rejects at resume.
    await app.runtime.approvals.decide(pending.approval.id, {
      status: "approved",
      approver: app.actorFrom(app.sessions.dana),
    });
    const result = await resumeApproved(app, pending.approval.id, app.sessions.dana);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_SELF_APPROVAL");
  });

  test("double resume: APPROVAL_CONSUMED (SI-5)", async () => {
    const app = makeApp();
    const pending = await invokeAsDana(app)("orders.refund", REFUND(649));
    if (pending.status !== "approval-required") expect.unreachable();
    await decideApproval(app, app.sessions.priya, pending.approval.id, { approved: true });
    expect((await resumeApproved(app, pending.approval.id, app.sessions.dana)).status).toBe(
      "completed",
    );
    const again = await resumeApproved(app, pending.approval.id, app.sessions.dana);
    if (again.status !== "failed") expect.unreachable();
    expect(again.error.code).toBe("APPROVAL_CONSUMED");
  });

  test("post-expiry resume: APPROVAL_EXPIRED", async () => {
    const app = makeApp();
    const pending = await invokeAsDana(app)("orders.refund", REFUND(649));
    if (pending.status !== "approval-required") expect.unreachable();
    await decideApproval(app, app.sessions.priya, pending.approval.id, { approved: true });
    app.clock.advance("16m");
    const result = await resumeApproved(app, pending.approval.id, app.sessions.dana);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_EXPIRED");
  });

  test("rejection: APPROVAL_REJECTED at resume", async () => {
    const app = makeApp();
    const pending = await invokeAsDana(app)("orders.refund", REFUND(649));
    if (pending.status !== "approval-required") expect.unreachable();
    await decideApproval(app, app.sessions.priya, pending.approval.id, {
      approved: false,
      comment: "Not warranted",
    });
    const result = await resumeApproved(app, pending.approval.id, app.sessions.dana);
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("APPROVAL_REJECTED");
  });

  test("payment gateway hang: TIMEOUT, and the write is NOT retried (SI-11)", async () => {
    const app = makeApp();
    app.services.paymentGateway.hang = true;
    const dana = app.sessions.dana;
    // Per-execution ceiling narrowed for the test via a runtime built the
    // same way the app builds it — here we use the testing package's seam.
    const { createAgentTestRuntime } = await import("@orpc-agent/testing");
    const t = createAgentTestRuntime({
      registry: app.runtime.registry,
      actor: app.actorFrom(dana),
      context: app.contextFor(dana),
      clock: app.clock,
    });
    const result = await t.invoke("orders.refund", REFUND(100), {
      surface: "aiSdk",
      timeoutMs: 30,
    });
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") expect(result.error.code).toBe("TIMEOUT");
    expect(app.services.paymentGateway.calls).toBe(1);
    expect(app.db.refunds).toHaveLength(0);
  });

  test("cross-org actor: org isolation denies before anything runs", async () => {
    const app = makeApp();
    const mallory = app.sessions.mallory;
    const result = await app.runtime.invoke("orders.refund", REFUND(100), {
      actor: app.actorFrom(mallory),
      // A confused deputy: mallory somehow got an org_1 context.
      context: app.contextFor(app.sessions.dana),
      surface: "aiSdk",
    });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(result.error.publicMessage).toBe("Operation not available for this organization.");
  });

  test("ineligible refund: the declared NOT_ELIGIBLE error is exposed", async () => {
    const app = makeApp();
    const result = await invokeAsDana(app)("orders.refund", {
      orderId: "ord_42",
      amount: 700, // above the order total of 649 → ineligible amount
      reason: "damaged item",
    });
    if (result.status !== "approval-required") expect.unreachable();
    await decideApproval(app, app.sessions.priya, result.approval.id, { approved: true });
    const final = await resumeApproved(app, result.approval.id, app.sessions.dana);
    if (final.status !== "failed") expect.unreachable();
    expect(final.error.code).toBe("EXECUTION_FAILED");
    expect(final.error.publicMessage).toBe("Order is not eligible for refund.");
  });
});

describe("redaction (SI-10)", () => {
  test("customers.get masks the email and drops payment methods for models", async () => {
    const app = makeApp();
    const result = await invokeAsDana(app)("customers.get", { id: "c_alice" });
    if (result.status !== "completed") expect.unreachable();
    const output = result.output as { email: string; paymentMethods?: unknown };
    expect(output.email).toBe("***@example.com");
    expect(output.paymentMethods).toBeUndefined();
    // The db still holds the full record; only the model-safe form left.
    expect(app.db.customers[0]!.paymentMethods).toHaveLength(1);
  });

  test("approval display input goes through redact.approvalInput", async () => {
    const app = makeApp();
    const pending = await invokeAsDana(app)("orders.refund", REFUND(649));
    if (pending.status !== "approval-required") expect.unreachable();
    const cards = await listPendingApprovals(app, app.sessions.priya);
    expect(cards[0]!.displayInput).toEqual(REFUND(649));
    expect(cards[0]!.reasons).toEqual(["Refund of $649 exceeds $500"]);
  });
});

describe("middleware remains authoritative (ADR-008)", () => {
  test("an actor without orders:refund permission is FORBIDDEN by middleware", async () => {
    const app = makeApp();
    const priya = app.sessions.priya; // approvals:decide but no orders:refund
    const result = await app.runtime.invoke("orders.refund", REFUND(100), {
      actor: app.actorFrom(priya),
      context: app.contextFor(priya),
      surface: "aiSdk",
    });
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("FORBIDDEN");
    expect(result.error.publicMessage).toBe("Missing permission: orders:refund");
  });
});
