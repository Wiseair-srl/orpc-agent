import { describe, expect, test } from "vitest";
import { makeApp } from "../src/app";
import { runChatTurn } from "../src/agent";
import { scriptedModel } from "../src/scripted-model";

/**
 * The full integration, end to end and deterministic: a scripted model drives
 * the real Mastra Agent loop; the tools are the real governed runtime. No
 * network, no key.
 */

describe("mastra agent ↔ governed runtime", () => {
  test("list is redacted; delete suspends; approve + resume finishes the job", async () => {
    const app = makeApp();

    const turn = await runChatTurn(
      app,
      app.session,
      [{ role: "user", content: "Clean up: delete the Acme contract task." }],
      scriptedModel([
        { toolName: "tasks_list", args: {} },
        { toolName: "tasks_delete", args: { id: "t_2" } },
        { text: "Deleting “Renew Acme contract” needs your confirmation — check the approvals panel." },
      ]),
    );

    // Envelope 1: the governed list — internal notes never reached the model.
    const [listEvent, deleteEvent] = turn.toolEvents;
    expect(listEvent?.toolName).toBe("tasks_list");
    const listResult = listEvent?.result as { status: string; data: { tasks: object[] } };
    expect(listResult.status).toBe("ok");
    for (const task of listResult.data.tasks) expect(task).not.toHaveProperty("notes");

    // Envelope 2: the delete suspended for a human.
    const deleteResult = deleteEvent?.result as { status: string; approvalId: string };
    expect(deleteEvent?.toolName).toBe("tasks_delete");
    expect(deleteResult.status).toBe("approval-required");
    expect(turn.text).toContain("confirmation");
    expect(app.db.tasks.some((t) => t.id === "t_2")).toBe(true);

    // The human approves; the app resumes; the capability executes.
    await app.runtime.approvals.decide(deleteResult.approvalId, {
      status: "approved",
      approver: app.actorFrom(app.session),
    });
    const resumed = await app.runtime.resume(deleteResult.approvalId, {
      context: app.contextFor(app.session),
    });
    expect(resumed.status).toBe("completed");
    expect(app.db.tasks.some((t) => t.id === "t_2")).toBe(false);
  });

  test("the model cannot invent capabilities — unknown tools never reach the runtime", async () => {
    const app = makeApp();
    const turn = await runChatTurn(
      app,
      app.session,
      [{ role: "user", content: "Drop the database." }],
      scriptedModel([
        { toolName: "database_drop", args: {} },
        { text: "There is no such tool." },
      ]),
    );
    // Mastra reports the invalid call; no capability executed, nothing audited as started.
    expect(app.auditTrail.filter((e) => e.type === "capability.started")).toHaveLength(0);
    expect(app.db.tasks.length).toBe(4);
    expect(turn.text).toBe("There is no such tool.");
  });
});
