import { describe, expect, test } from "vitest";
import { call } from "@orpc/server";
import { makeApp } from "../src/app";
import { listTasks } from "../src/capabilities";

function invoke(app: ReturnType<typeof makeApp>) {
  return (capabilityId: string, input: unknown) =>
    app.runtime.invoke(capabilityId, input, {
      actor: app.actorFrom(app.session),
      context: app.contextFor(app.session),
      surface: "aiSdk",
    });
}

describe("discovery", () => {
  test("the model sees all four capabilities, delete flagged as requiring approval", async () => {
    const app = makeApp();
    const descriptors = await app.runtime.describe("aiSdk", {
      actor: app.actorFrom(app.session),
      context: app.contextFor(app.session),
    });
    expect(descriptors.map((d) => d.id).sort()).toEqual([
      "tasks.create",
      "tasks.delete",
      "tasks.list",
      "tasks.move",
    ]);
    expect(descriptors.find((d) => d.id === "tasks.delete")?.requiresApproval).toBe(true);
  });
});

describe("redaction (stage 13)", () => {
  test("internal notes reach the board UI but never the model", async () => {
    const app = makeApp();

    // The UI path: the same procedure as a plain oRPC call — notes included.
    const direct = await call(listTasks, {}, { context: app.contextFor(app.session) });
    expect(direct.tasks.find((t) => t.id === "t_2")?.notes).toContain("555 0142");

    // The agent path: through the runtime — notes stripped before output.
    const governed = await invoke(app)("tasks.list", {});
    if (governed.status !== "completed") expect.unreachable();
    const tasks = (governed.output as { tasks: Record<string, unknown>[] }).tasks;
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task).not.toHaveProperty("notes");
  });
});

describe("approvals", () => {
  test("normal create completes; urgent create suspends with the policy's reason", async () => {
    const app = makeApp();
    const ok = await invoke(app)("tasks.create", { title: "Water the plants", priority: "normal" });
    expect(ok.status).toBe("completed");

    const urgent = await invoke(app)("tasks.create", {
      title: "Call the datacenter",
      priority: "urgent",
    });
    if (urgent.status !== "approval-required") expect.unreachable();
    expect(urgent.approval.reasons).toContain("Urgent tasks page the on-call rotation");
    // Suspended means not executed: the task is not on the board.
    expect(app.db.tasks.some((t) => t.title === "Call the datacenter")).toBe(false);
  });

  test("delete suspends (static gate), approve + resume executes exactly once", async () => {
    const app = makeApp();
    const pending = await invoke(app)("tasks.delete", { id: "t_1" });
    if (pending.status !== "approval-required") expect.unreachable();
    expect(app.db.tasks.some((t) => t.id === "t_1")).toBe(true);

    await app.runtime.approvals.decide(pending.approval.id, {
      status: "approved",
      approver: app.actorFrom(app.session),
    });
    const resumed = await app.runtime.resume(pending.approval.id, {
      context: app.contextFor(app.session),
    });
    expect(resumed.status).toBe("completed");
    expect(app.db.tasks.some((t) => t.id === "t_1")).toBe(false);

    // A consumed approval never fires twice (SI-5).
    const again = await app.runtime.resume(pending.approval.id, {
      context: app.contextFor(app.session),
    });
    if (again.status !== "failed") expect.unreachable();
    expect(again.error.code).toBe("APPROVAL_CONSUMED");
  });

  test("rejecting keeps the task and refuses resume", async () => {
    const app = makeApp();
    const pending = await invoke(app)("tasks.delete", { id: "t_1" });
    if (pending.status !== "approval-required") expect.unreachable();

    await app.runtime.approvals.decide(pending.approval.id, {
      status: "rejected",
      approver: app.actorFrom(app.session),
    });
    const resumed = await app.runtime.resume(pending.approval.id, {
      context: app.contextFor(app.session),
    });
    if (resumed.status !== "failed") expect.unreachable();
    expect(resumed.error.code).toBe("APPROVAL_REJECTED");
    expect(app.db.tasks.some((t) => t.id === "t_1")).toBe(true);
  });
});

describe("audit", () => {
  test("an approved delete leaves the full governed trail", async () => {
    const app = makeApp();
    const pending = await invoke(app)("tasks.delete", { id: "t_4" });
    if (pending.status !== "approval-required") expect.unreachable();
    await app.runtime.approvals.decide(pending.approval.id, {
      status: "approved",
      approver: app.actorFrom(app.session),
    });
    await app.runtime.resume(pending.approval.id, { context: app.contextFor(app.session) });

    const sequence = app.auditTrail
      .filter((e) => e.capabilityId === "tasks.delete")
      .map((e) => e.type);
    expect(sequence).toEqual([
      "capability.requested",
      "capability.approval_requested",
      "capability.approved",
      "capability.started",
      "capability.completed",
    ]);
  });
});
