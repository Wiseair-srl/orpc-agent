import { describe, expect, test } from "vitest";
import { makeApp } from "../src/app";
import { chatTurn } from "../src/chat";
import { decideApproval, resumeApproved } from "../src/dashboard";

/**
 * The end-to-end flow, normative for the example
 * (docs/examples/customer-support-agent.md#the-end-to-end-flow): read →
 * eligibility → refund(649) → approval-required → decide-as-manager → resume
 * → completed → draft → send-with-inline-confirmation — with the exact audit
 * sequence (acceptance criterion 3).
 */

test("Dana's damaged-order refund, end to end", async () => {
  const app = makeApp();
  const dana = app.sessions.dana;

  // --- Chat turn 1: the model investigates and attempts the refund. --------
  const turn1 = await chatTurn(app, dana, [
    { toolName: "customers_search", args: { query: "alice@example.com" } },
    { toolName: "orders_list", args: { customerId: "c_alice" } },
    { toolName: "orders_checkRefundEligibility", args: { orderId: "ord_42" } },
    { toolName: "orders_refund", args: { orderId: "ord_42", amount: 649, reason: "damaged item" } },
    { text: "This refund needs manager approval — the request is pending." },
  ]);

  expect(turn1.toolResults.map((r) => r.toolName)).toEqual([
    "customers_search",
    "orders_list",
    "orders_checkRefundEligibility",
    "orders_refund",
  ]);
  const eligibility = turn1.toolResults[2]!.output as { status: string; data: unknown };
  expect(eligibility).toEqual({ status: "ok", data: { eligible: true, maxAmount: 649 } });
  const refundOutcome = turn1.toolResults[3]!.output as {
    status: string;
    approvalId: string;
    message: string;
  };
  expect(refundOutcome.status).toBe("approval-required");
  expect(refundOutcome.message).toBe("Awaiting approval: Refund of $649 exceeds $500.");
  expect(app.db.refunds).toHaveLength(0); // nothing executed

  // --- Priya approves in the dashboard; a worker resumes. ------------------
  await decideApproval(app, app.sessions.priya, refundOutcome.approvalId, {
    approved: true,
    comment: "Verified with customer",
  });
  const final = await resumeApproved(app, refundOutcome.approvalId, dana);
  if (final.status !== "completed") expect.unreachable();
  expect(final.output).toEqual({ refundId: "ref_77", amount: 649, status: "issued" });
  expect(app.db.orders.find((o) => o.id === "ord_42")?.status).toBe("refunded");

  // --- Chat turn 2: draft, then send with inline human confirmation. -------
  const turn2 = await chatTurn(app, dana, [
    { toolName: "messages_draft", args: { caseId: "case_7", text: "Your refund of $649 has been issued." } },
    { toolName: "messages_send", args: { draftId: "draft_1" } },
    { text: "Done — Alice has been refunded and notified." },
  ]);
  const sendOutcome = turn2.toolResults[1]!.output as { status: string; data: { messageId: string } };
  expect(sendOutcome.status).toBe("ok");
  expect(app.db.sentMessages).toHaveLength(1);
  expect(turn2.text).toBe("Done — Alice has been refunded and notified.");

  // --- The audit trail tells the whole story, in pipeline order. -----------
  const sequence = app.auditTrail.map((e) => `${e.type} ${e.capabilityId ?? ""}`.trim());
  expect(sequence).toEqual([
    "capabilities.discovered", // turn-1 tool set build
    "capability.requested customers.search",
    "capability.started customers.search",
    "capability.completed customers.search",
    "capability.requested orders.list",
    "capability.started orders.list",
    "capability.completed orders.list",
    "capability.requested orders.checkRefundEligibility",
    "capability.started orders.checkRefundEligibility",
    "capability.completed orders.checkRefundEligibility",
    "capability.requested orders.refund",
    "capability.approval_requested orders.refund",
    "capability.approved orders.refund",
    "capability.started orders.refund",
    "capability.completed orders.refund",
    "capabilities.discovered", // turn-2 tool set build
    "capability.requested messages.draft",
    "capability.started messages.draft",
    "capability.completed messages.draft",
    "capability.requested messages.send",
    "capability.approval_requested messages.send",
    "capability.approved messages.send",
    "capability.started messages.send",
    "capability.completed messages.send",
  ]);

  // Executions link correctly: the refund suspension and its resumption are
  // distinct executions tied to one approval id.
  const requested = app.auditTrail.find(
    (e) => e.type === "capability.approval_requested" && e.capabilityId === "orders.refund",
  )!;
  const started = app.auditTrail.find(
    (e) => e.type === "capability.started" && e.capabilityId === "orders.refund",
  )!;
  expect(started.executionId).not.toBe(requested.executionId);
  expect((started as { data: { approvalId: string } }).data.approvalId).toBe(
    refundOutcome.approvalId,
  );

  // The send confirmation was recorded as Dana confirming her own send —
  // by design for human-confirmation (rejectSelfApproval: false on the chat
  // runtime, documented in src/app.ts).
  const sendApproved = app.auditTrail.find(
    (e) => e.type === "capability.approved" && e.capabilityId === "messages.send",
  )!;
  expect((sendApproved as { data: { approver: { id: string } } }).data.approver.id).toBe("u_dana");
});

describe("chat-turn variants", () => {
  test("declining the send confirmation rejects without sending", async () => {
    const app = makeApp();
    app.ui.confirmSend = async (_req, session) => ({
      status: "rejected" as const,
      approver: app.actorFrom(session),
    });
    const turn = await chatTurn(app, app.sessions.dana, [
      { toolName: "messages_draft", args: { caseId: "case_7", text: "Hello." } },
      { toolName: "messages_send", args: { draftId: "draft_1" } },
      { text: "You declined the send." },
    ]);
    const outcome = turn.toolResults[1]!.output as { status: string; error: { code: string } };
    expect(outcome.status).toBe("error");
    expect(outcome.error.code).toBe("APPROVAL_REJECTED");
    expect(app.db.sentMessages).toHaveLength(0);
  });

  test("a manager-gated refund in chat defers to the coordinator (no inline decision)", async () => {
    const app = makeApp();
    const turn = await chatTurn(app, app.sessions.dana, [
      { toolName: "orders_refund", args: { orderId: "ord_42", amount: 649, reason: "damaged item" } },
      { text: "Pending approval." },
    ]);
    const outcome = turn.toolResults[0]!.output as { status: string };
    expect(outcome.status).toBe("approval-required");
    const pending = await app.coordinator.list!({ status: "pending" });
    expect(pending).toHaveLength(1);
  });
});
