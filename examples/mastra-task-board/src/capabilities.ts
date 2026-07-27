import { ORPCError, os } from "@orpc/server";
import * as z from "zod";
import { agentProcedure } from "@orpc-agent/core";
import type { AppContext } from "./context";
import { urgentNeedsApproval } from "./policies";

/**
 * Four capabilities, defined once, serving two clients:
 *
 *   - the board UI calls them as plain oRPC procedures (`/rpc`) — ordinary
 *     application traffic, governed by middleware/app authorization only;
 *   - the Mastra agent calls them through the governed runtime (`aiSdk`
 *     surface) — exposure, validation, policies, approvals, redaction, audit.
 *
 * That asymmetry is the point: same business logic, and the model end gets
 * the extra governance because it is untrusted input.
 */

const requireSession = os.$context<AppContext>().middleware(async ({ context, next }) => {
  // Stand-in for real auth middleware — the same check guards both surfaces.
  if (!context.session?.userId) {
    throw new ORPCError("UNAUTHORIZED", { message: "No session." });
  }
  return next();
});

export const agentBase = agentProcedure(os.$context<AppContext>()).use(requireSession);

const TaskOut = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  priority: z.enum(["normal", "urgent"]),
  notes: z.string().optional(),
  createdBy: z.string(),
});

export const listTasks = agentBase
  .meta({
    agent: {
      description:
        "List every task on the board with its id, title, status (todo/doing/done), and priority. Use this first to find task ids.",
      expose: { aiSdk: true, test: true },
      sideEffect: "read",
      risk: "low",
      tags: ["tasks"],
      redact: {
        // Internal notes never reach a model; the board UI still sees them.
        output: (o) => {
          const { tasks } = o as { tasks: z.infer<typeof TaskOut>[] };
          return { tasks: tasks.map(({ notes: _notes, ...task }) => task) };
        },
      },
    },
  })
  .input(z.strictObject({}))
  .output(z.object({ tasks: z.array(TaskOut) }))
  .handler(async ({ context }) => ({ tasks: await context.services.tasks.list() }));

export const createTask = agentBase
  .meta({
    agent: {
      description:
        'Create a task on the board (status starts at "todo"). Priority "urgent" pages the on-call rotation and needs human sign-off.',
      expose: { aiSdk: true, test: true },
      sideEffect: "write",
      risk: "medium",
      tags: ["tasks"],
      policies: [urgentNeedsApproval],
    },
  })
  .input(
    z.strictObject({
      title: z.string().min(3).max(120),
      priority: z.enum(["normal", "urgent"]),
    }),
  )
  .output(TaskOut)
  .handler(async ({ input, context }) =>
    context.services.tasks.create(input, context.agent ? "agent" : context.session.userId),
  );

export const moveTask = agentBase
  .meta({
    agent: {
      description: "Move a task to another column: todo, doing, or done.",
      expose: { aiSdk: true, test: true },
      sideEffect: "write",
      risk: "low",
      tags: ["tasks"],
    },
  })
  .input(z.strictObject({ id: z.string(), status: z.enum(["todo", "doing", "done"]) }))
  .output(TaskOut)
  .handler(async ({ input, context }) => {
    const task = await context.services.tasks.move(input.id, input.status);
    if (!task) throw new ORPCError("NOT_FOUND", { message: "Task not found." });
    return task;
  });

export const deleteTask = agentBase
  .meta({
    agent: {
      description: "Delete a task from the board permanently.",
      expose: { aiSdk: true, test: true },
      sideEffect: "destructive",
      risk: "high",
      tags: ["tasks"],
      approval: { required: true, type: "human-confirmation" },
    },
  })
  .input(z.strictObject({ id: z.string() }))
  .output(z.object({ deleted: z.boolean(), id: z.string(), title: z.string() }))
  .handler(async ({ input, context }) => {
    const removed = await context.services.tasks.remove(input.id);
    if (!removed) throw new ORPCError("NOT_FOUND", { message: "Task not found." });
    return { deleted: true, id: removed.id, title: removed.title };
  });

/**
 * One nested structure, two uses: the oRPC router the board UI calls at
 * `/rpc`, and the capability registry the agent runtime governs. Capability
 * ids follow the paths: `tasks.list`, `tasks.create`, `tasks.move`,
 * `tasks.delete`.
 */
export const router = {
  tasks: { list: listTasks, create: createTask, move: moveTask, delete: deleteTask },
};

export type AppRouter = typeof router;
