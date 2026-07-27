import { makeApp } from "./app";
import { runChatTurn } from "./agent";
import { scriptedModel } from "./scripted-model";

/**
 * The documented flow, scripted — `pnpm demo` runs the real Mastra Agent
 * against the real governed runtime with a deterministic model, so it works
 * from a clean checkout with no key. The web app (`pnpm dev`) is the same
 * flow with a live model and buttons.
 */

const app = makeApp();

const board = () =>
  app.db.tasks.map((t) => `  [${t.status.padEnd(5)}] ${t.id}  ${t.title}`).join("\n");

console.log("The board:\n" + board() + "\n");
console.log('You: "Move the flaky test task to done, then delete the Acme contract task."\n');

const turn = await runChatTurn(
  app,
  app.session,
  [{ role: "user", content: "Move the flaky test task to done, then delete the Acme contract task." }],
  scriptedModel([
    { toolName: "tasks_list", args: {} },
    { toolName: "tasks_move", args: { id: "t_3", status: "done" } },
    { toolName: "tasks_delete", args: { id: "t_2" } },
    {
      text: "Moved “Fix flaky signup test” to done. Deleting “Renew Acme contract” is destructive and needs your confirmation.",
    },
  ]),
);

for (const event of turn.toolEvents) {
  console.log(`  tool ${event.toolName} ${JSON.stringify(event.args)}`);
  console.log(`       → ${JSON.stringify(event.result)}`);
}
console.log(`  assistant: ${turn.text}\n`);

const [pending] = (await app.runtime.approvals.list?.({ status: "pending" })) ?? [];
if (!pending) throw new Error("expected a pending approval");
console.log(`Approvals panel: ${pending.capabilityId} ${JSON.stringify(pending.input)} — you click Approve.\n`);

await app.runtime.approvals.decide(pending.id, {
  status: "approved",
  approver: app.actorFrom(app.session),
});
const resumed = await app.runtime.resume(pending.id, { context: app.contextFor(app.session) });
console.log(`resume → ${JSON.stringify(resumed.status === "completed" ? resumed.output : resumed)}\n`);

console.log("The board now:\n" + board() + "\n");

console.log("Audit ledger:");
for (const event of app.auditTrail) {
  console.log(`  ${event.type.padEnd(32)} ${(event.capabilityId ?? "").padEnd(14)} ${event.surface}`);
}
