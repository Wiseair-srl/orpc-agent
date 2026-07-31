import { afterAll, describe, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { os } from "@orpc/server";
import * as z from "zod";
import {
  agentProcedure,
  createAgentRuntime,
  defineGovernance,
  createCapabilityRegistry,
  type AgentAuditEvent,
  type AgentInvocationInfo,
} from "@orpc-agent/core";
import { AUDIT_DDL, createPgAuditSink } from "../src/audit";
import type { PgQuery } from "../src/query";

const db = new PGlite();
const pgliteQuery: PgQuery = (sql, params) => db.query(sql, params);
let ddlApplied = false;

async function freshTable(): Promise<void> {
  if (!ddlApplied) {
    await db.exec(AUDIT_DDL);
    ddlApplied = true;
  }
  await db.exec("truncate table orpc_agent_audit_events");
}

async function storedRows(): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query("select * from orpc_agent_audit_events order by id asc");
  return rows as Record<string, unknown>[];
}

afterAll(async () => {
  await db.close();
});

const AT = new Date("2026-07-27T10:00:00.000Z");

function event(overrides: Partial<AgentAuditEvent> & Pick<AgentAuditEvent, "type" | "data">) {
  return {
    timestamp: AT,
    surface: "aiSdk",
    actor: { id: "u_dana", kind: "user" },
    ...overrides,
  } as AgentAuditEvent;
}

describe("row mapping", () => {
  test("envelope fields become columns; data round-trips as jsonb; optionals null", async () => {
    await freshTable();
    const sink = createPgAuditSink({ query: pgliteQuery });

    await sink(
      event({
        type: "capability.requested",
        executionId: "exe_1",
        capabilityId: "orders.refund",
        correlationId: "run_9",
        inputHash: "a".repeat(64),
        data: { sideEffect: "write", risk: "high" },
      }),
    );
    await sink(
      event({
        type: "capabilities.discovered",
        data: { count: 2, surface: "aiSdk", digest: "d".repeat(64) },
      }),
    );
    await sink(
      event({
        type: "capability.failed",
        executionId: "exe_1",
        capabilityId: "orders.refund",
        data: {
          code: "POLICY_DENIED",
          stage: "policy",
          retryable: false,
          attempts: 1,
          policyDecisions: [{ policy: "refund-limit", type: "deny" }],
        },
      }),
    );

    const rows = await storedRows();
    expect(rows).toHaveLength(3);

    const requested = rows[0]!;
    expect(requested.type).toBe("capability.requested");
    expect((requested.at as Date).toISOString()).toBe(AT.toISOString());
    expect(requested.surface).toBe("aiSdk");
    expect(requested.actor_id).toBe("u_dana");
    expect(requested.actor_kind).toBe("user");
    expect(requested.execution_id).toBe("exe_1");
    expect(requested.capability_id).toBe("orders.refund");
    expect(requested.correlation_id).toBe("run_9");
    expect(requested.input_hash).toBe("a".repeat(64));
    expect(requested.data).toEqual({ sideEffect: "write", risk: "high" });

    const discovered = rows[1]!;
    expect(discovered.execution_id).toBeNull();
    expect(discovered.capability_id).toBeNull();
    expect(discovered.correlation_id).toBeNull();
    expect(discovered.input_hash).toBeNull();
    expect(discovered.data).toEqual({ count: 2, surface: "aiSdk", digest: "d".repeat(64) });

    expect((rows[2]!.data as Record<string, unknown>).policyDecisions).toEqual([
      { policy: "refund-limit", type: "deny" },
    ]);
  });

  test("construction guards: query required, table names validated", () => {
    expect(() =>
      createPgAuditSink({} as Parameters<typeof createPgAuditSink>[0]),
    ).toThrowError(/query is required/);
    expect(() => createPgAuditSink({ query: pgliteQuery, table: "x; drop" })).toThrowError(
      /Invalid table name/,
    );
  });
});

describe("batching", () => {
  test("terminal events buffer to a size-triggered multi-row insert; promises settle at flush", async () => {
    await freshTable();
    const sink = createPgAuditSink({ query: pgliteQuery, batch: { size: 3, flushMs: 60_000 } });

    const first = sink(event({ type: "capability.requested", data: {} }));
    const second = sink(event({ type: "capability.completed", data: { durationMs: 5, attempts: 1 } }));
    // Nothing hit the table yet — buffered, timer far away.
    await new Promise((r) => setTimeout(r, 10));
    expect(await storedRows()).toHaveLength(0);

    const third = sink(event({ type: "capability.cancelled", data: { code: "TIMEOUT", durationMs: 9 } }));
    await Promise.all([first, second, third]);
    const rows = await storedRows();
    expect(rows.map((r) => r.type)).toEqual([
      "capability.requested",
      "capability.completed",
      "capability.cancelled",
    ]);
  });

  test("capability.started bypasses the buffer — written through even mid-batch", async () => {
    await freshTable();
    const sink = createPgAuditSink({ query: pgliteQuery, batch: { size: 50, flushMs: 60_000 } });

    void sink(event({ type: "capability.requested", data: {} }));
    await sink(event({ type: "capability.started", executionId: "exe_1", data: { attempt: 1 } }));

    const rows = await storedRows();
    expect(rows.map((r) => r.type)).toEqual(["capability.started"]);

    await sink.flush();
    expect((await storedRows()).map((r) => r.type)).toEqual([
      "capability.started",
      "capability.requested",
    ]);
  });

  test("the timer flushes without reaching size", async () => {
    await freshTable();
    const sink = createPgAuditSink({ query: pgliteQuery, batch: { size: 50, flushMs: 20 } });
    await sink(event({ type: "capability.requested", data: {} }));
    expect(await storedRows()).toHaveLength(1);
  });

  test("close() flushes the remainder; later events write through", async () => {
    await freshTable();
    const sink = createPgAuditSink({ query: pgliteQuery, batch: { size: 50, flushMs: 60_000 } });
    void sink(event({ type: "capability.requested", data: {} }));
    await sink.close();
    expect(await storedRows()).toHaveLength(1);
    await sink(event({ type: "capability.completed", data: { durationMs: 1, attempts: 1 } }));
    expect(await storedRows()).toHaveLength(2);
  });

  test("a failed flush rejects every buffered event's promise individually", async () => {
    const failing = createPgAuditSink({
      query: async () => {
        throw new Error("connection lost");
      },
      batch: { size: 2, flushMs: 60_000 },
    });
    const first = failing(event({ type: "capability.requested", data: {} }));
    const second = failing(event({ type: "capability.completed", data: { durationMs: 1, attempts: 1 } }));
    await expect(first).rejects.toThrowError(/connection lost/);
    await expect(second).rejects.toThrowError(/connection lost/);
  });
});

// ---- Strict mode: the reason the started-bypass rule exists ----

describe("strict mode with a real runtime", () => {
  const base = agentProcedure(os.$context<{ agent?: AgentInvocationInfo }>());

  function makeEcho(onExecute?: (executionId: string) => Promise<void>) {
    return base
      .meta({
        agent: {
          description: "Echo.",
          expose: { direct: true },
          sideEffect: "write",
          risk: "low",
          idempotent: true,
        },
      })
      .input(z.object({ text: z.string() }))
      .handler(async ({ input, context }) => {
        await onExecute?.(context.agent!.executionId);
        return { echoed: input.text };
      });
  }

  test("the started row exists before the procedure runs — audit-before-effect (T12)", async () => {
    await freshTable();
    const sink = createPgAuditSink({ query: pgliteQuery, batch: { size: 50, flushMs: 60_000 } });

    let startedRowsSeenFromHandler = -1;
    const echo = makeEcho(async (executionId) => {
      const { rows } = await db.query(
        "select 1 from orpc_agent_audit_events where type = 'capability.started' and execution_id = $1",
        [executionId],
      );
      startedRowsSeenFromHandler = rows.length;
    });

    const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ echo }) }), audit: { sinks: [sink], strict: true } });
    const result = await runtime.invoke(
      "echo",
      { text: "hi" },
      { actor: { id: "svc.job", kind: "service" }, context: {} },
    );
    expect(result.status).toBe("completed");
    expect(startedRowsSeenFromHandler).toBe(1);
  });

  test("a failing sink blocks execution with AUDIT_UNAVAILABLE", async () => {
    const failing = createPgAuditSink({
      query: async () => {
        throw new Error("db down");
      },
    });
    const echo = makeEcho();
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ echo }) }), audit: { sinks: [failing], strict: true } });
    const result = await runtime.invoke(
      "echo",
      { text: "hi" },
      { actor: { id: "svc.job", kind: "service" }, context: {} },
    );
    if (result.status !== "failed") expect.unreachable();
    expect(result.error.code).toBe("AUDIT_UNAVAILABLE");
  });

  test("best-effort mode routes batched-flush failures to onSinkError per event", async () => {
    const failing = createPgAuditSink({
      query: async () => {
        throw new Error("db down");
      },
      batch: { size: 1, flushMs: 10 },
    });
    const errors: string[] = [];
    const echo = makeEcho();
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ echo }) }), audit: {
        sinks: [failing],
        onSinkError: (_error, failedEvent) => {
          errors.push(failedEvent.type);
        },
      } });
    const result = await runtime.invoke(
      "echo",
      { text: "hi" },
      { actor: { id: "svc.job", kind: "service" }, context: {} },
    );
    expect(result.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toContain("capability.requested");
    expect(errors).toContain("capability.started");
    expect(errors).toContain("capability.completed");
  });
});
