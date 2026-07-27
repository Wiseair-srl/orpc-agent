import { makeApp } from "./app";
import { chatTurn } from "./chat";
import { decideApproval, listPendingApprovals, resumeApproved } from "./dashboard";

/**
 * Runnable version of the documented end-to-end flow. `pnpm demo` prints each
 * step and the resulting audit trail.
 */

const app = makeApp();
const dana = app.sessions.dana;

console.log('Dana: "Customer alice@example.com says her order arrived damaged — refund it and let her know."\n');

const turn1 = await chatTurn(app, dana, [
  { toolName: "customers_search", args: { query: "alice@example.com" } },
  { toolName: "orders_list", args: { customerId: "c_alice" } },
  { toolName: "orders_checkRefundEligibility", args: { orderId: "ord_42" } },
  { toolName: "orders_refund", args: { orderId: "ord_42", amount: 649, reason: "damaged item" } },
  { text: "This refund needs manager approval — the request is pending." },
]);
for (const result of turn1.toolResults) {
  console.log(`  tool ${result.toolName} →`, JSON.stringify(result.output));
}
console.log(`  assistant: ${turn1.text}\n`);

const pendingCards = await listPendingApprovals(app, app.sessions.priya);
console.log("Priya's approvals dashboard:", JSON.stringify(pendingCards, null, 2), "\n");

const approvalId = pendingCards[0]!.id;
await decideApproval(app, app.sessions.priya, approvalId, {
  approved: true,
  comment: "Verified with customer",
});
console.log(`Priya approved ${approvalId}. Worker resumes...\n`);

const final = await resumeApproved(app, approvalId, dana);
console.log("resume →", JSON.stringify(final), "\n");

const turn2 = await chatTurn(app, dana, [
  { toolName: "messages_draft", args: { caseId: "case_7", text: "Your refund of $649 has been issued." } },
  { toolName: "messages_send", args: { draftId: "draft_1" } },
  { text: "Done — Alice has been refunded and notified." },
]);
for (const result of turn2.toolResults) {
  console.log(`  tool ${result.toolName} →`, JSON.stringify(result.output));
}
console.log(`  assistant: ${turn2.text}\n`);

console.log("Audit trail:");
for (const event of app.auditTrail) {
  const executionId = event.executionId ? ` ${event.executionId.slice(0, 12)}` : "";
  console.log(`  ${event.type.padEnd(32)}${(event.capabilityId ?? "").padEnd(32)}${executionId}`);
}
