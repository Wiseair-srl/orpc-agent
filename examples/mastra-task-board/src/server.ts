import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RPCHandler } from "@orpc/server/fetch";
import * as z from "zod";
import type { ApprovalRecord, ExecutionResult } from "@orpc-agent/core";
import { makeApp } from "./app";
import { router } from "./capabilities";
import { DEMO_SESSION, actorFrom } from "./context";
import { resolveModel, runChatTurn } from "./agent";

// Optional .env at the example root (OPENROUTER_API_KEY, OPENROUTER_MODEL).
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // no .env — AI features stay disabled unless the vars are already set
}

const app = makeApp();
const model = resolveModel();

/**
 * Surface 1 — the board UI. Plain oRPC over HTTP: ordinary application
 * traffic hitting the same procedures the agent uses, with middleware/app
 * authorization and no agent governance in between.
 */
const rpcHandler = new RPCHandler(router);

/** Surface 2 — the agent (and its human oversight), as JSON endpoints. */
const server = new Hono();

server.use("/rpc/*", async (c, next) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: app.contextFor(DEMO_SESSION),
  });
  if (matched) return response;
  await next();
});

server.get("/api/health", (c) =>
  c.json({ ok: true, aiEnabled: model !== null, model: model?.id ?? null }),
);

/** What the model can see right now — the runtime's discovery pipeline. */
server.get("/api/agent/capabilities", async (c) => {
  const descriptors = await app.runtime.describe("aiSdk", {
    actor: actorFrom(DEMO_SESSION),
    context: app.contextFor(DEMO_SESSION),
  });
  return c.json(
    descriptors.map((d) => ({
      id: d.id,
      description: d.description,
      sideEffect: d.sideEffect,
      risk: d.risk,
      requiresApproval: d.requiresApproval ?? false,
    })),
  );
});

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(40),
});

server.post("/api/chat", async (c) => {
  if (!model) {
    return c.json(
      {
        error:
          "AI features are disabled. Put OPENROUTER_API_KEY (and optionally OPENROUTER_MODEL) in examples/mastra-task-board/.env and restart.",
      },
      503,
    );
  }
  const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid chat body." }, 400);

  try {
    const turn = await runChatTurn(app, DEMO_SESSION, parsed.data.messages, model.model);
    return c.json({ ...turn, pendingApprovals: await pendingApprovalCards() });
  } catch (error) {
    console.error("[chat]", error);
    return c.json({ error: "The model call failed. Check the server log and your OpenRouter key/model." }, 502);
  }
});

server.get("/api/approvals", async (c) => c.json(await pendingApprovalCards()));

const DecideBody = z.object({ approved: z.boolean() });

/**
 * Deciding records intent; executing is a separate act. On approval the
 * runtime re-enters the pipeline (`resume`) with the integrity checks —
 * same input hash, unexpired, not yet consumed — and only then runs the
 * capability.
 */
server.post("/api/approvals/:id", async (c) => {
  const parsed = DecideBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid decision body." }, 400);
  const id = c.req.param("id");

  try {
    await app.runtime.approvals.decide(id, {
      status: parsed.data.approved ? "approved" : "rejected",
      approver: actorFrom(DEMO_SESSION),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Decision failed." }, 409);
  }

  if (!parsed.data.approved) {
    return c.json({ resolution: { status: "rejected" as const } });
  }

  const result = await app.runtime.resume(id, { context: app.contextFor(DEMO_SESSION) });
  return c.json({ resolution: serializeResult(result) });
});

/** The governed trail: everything the agent asked for, was denied, or did. */
server.get("/api/audit", (c) =>
  c.json(
    app.auditTrail.slice(-120).map((event) => ({
      at: event.timestamp,
      type: event.type,
      capabilityId: event.capabilityId ?? null,
      surface: event.surface,
      actor: event.actor.id,
      data: event.data,
    })),
  ),
);

async function pendingApprovalCards() {
  const pending = (await app.runtime.approvals.list?.({ status: "pending" })) ?? [];
  return pending.map((record: ApprovalRecord) => {
    const input = record.input as Record<string, unknown>;
    // Server-side enrichment for the card: resolve the task title behind an id.
    const task =
      typeof input?.id === "string" ? app.db.tasks.find((t) => t.id === input.id) : undefined;
    return {
      id: record.id,
      capabilityId: record.capabilityId,
      reasons: record.reasons,
      input: record.input,
      taskTitle: task?.title ?? null,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
    };
  });
}

function serializeResult(result: ExecutionResult<unknown>) {
  switch (result.status) {
    case "completed":
      return { status: "completed" as const, output: result.output };
    case "approval-required":
      return { status: "approval-required" as const, approvalId: result.approval.id };
    case "failed":
    case "cancelled":
      return {
        status: result.status,
        error: { code: result.error.code, message: result.error.publicMessage },
      };
  }
}

// Production mode: serve the built frontend. In dev, Vite serves it and
// proxies /api and /rpc here.
const webDist = fileURLToPath(new URL("../web/dist", import.meta.url));
if (existsSync(webDist)) {
  const root = relative(process.cwd(), webDist);
  server.use("*", serveStatic({ root }));
  server.use("*", serveStatic({ root, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: server.fetch, port }, () => {
  console.log(`task board on http://localhost:${port}`);
  console.log(
    model
      ? `AI enabled — model: ${model.id} (via OpenRouter)`
      : "AI disabled — set OPENROUTER_API_KEY in examples/mastra-task-board/.env to enable chat",
  );
});
