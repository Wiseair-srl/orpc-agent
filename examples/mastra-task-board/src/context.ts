import type { Actor, AgentInvocationInfo } from "@orpc-agent/core";

/**
 * The application's world: one demo session, an in-memory task store, and the
 * service layer handlers call. Everything is deterministic and self-contained
 * so the example runs (and its tests pass) without external systems.
 */

export type Session = {
  userId: string;
  name: string;
};

/** Stand-in for real authentication — a production app derives this per request. */
export const DEMO_SESSION: Session = { userId: "u_you", name: "You" };

export function actorFrom(session: Session): Actor {
  return { id: session.userId, kind: "user", displayName: session.name };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "normal" | "urgent";

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Internal notes — redacted before anything reaches a model. */
  notes?: string;
  createdBy: string;
};

export type Db = ReturnType<typeof seedDb>;

export function seedDb() {
  const tasks: Task[] = [
    {
      id: "t_1",
      title: "Draft Q3 launch announcement",
      status: "todo",
      priority: "normal",
      createdBy: "u_you",
    },
    {
      id: "t_2",
      title: "Renew Acme contract",
      status: "todo",
      priority: "urgent",
      notes: "Direct line for their CFO: +1 555 0142 — do not share outside the team.",
      createdBy: "u_you",
    },
    {
      id: "t_3",
      title: "Fix flaky signup test",
      status: "doing",
      priority: "normal",
      createdBy: "u_you",
    },
    {
      id: "t_4",
      title: "Ship onboarding email sequence",
      status: "done",
      priority: "normal",
      createdBy: "u_you",
    },
  ];
  let nextId = 5;
  return { tasks, nextId: () => `t_${nextId++}` };
}

// ---------------------------------------------------------------------------
// Services (what capability handlers call)
// ---------------------------------------------------------------------------

export function makeServices(db: Db) {
  return {
    tasks: {
      async list() {
        return db.tasks;
      },
      async byId(id: string) {
        return db.tasks.find((t) => t.id === id) ?? null;
      },
      async create(input: { title: string; priority: TaskPriority }, createdBy: string) {
        const task: Task = { id: db.nextId(), status: "todo", createdBy, ...input };
        db.tasks.push(task);
        return task;
      },
      async move(id: string, status: TaskStatus) {
        const task = db.tasks.find((t) => t.id === id);
        if (!task) return null;
        task.status = status;
        return task;
      },
      async remove(id: string) {
        const index = db.tasks.findIndex((t) => t.id === id);
        if (index === -1) return null;
        const [removed] = db.tasks.splice(index, 1);
        return removed ?? null;
      },
    },
  };
}

export type Services = ReturnType<typeof makeServices>;

export type AppContext = {
  db: Db;
  services: Services;
  session: Session;
  now: () => Date;
  /** Injected by the runtime on agent-originated calls; undefined otherwise. */
  agent?: AgentInvocationInfo;
};

export function createAppContext(
  session: Session,
  shared: { db: Db; services: Services; now: () => Date },
): AppContext {
  return { db: shared.db, services: shared.services, session, now: shared.now };
}
