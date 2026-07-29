import { afterAll, describe, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { os } from "@orpc/server";
import * as z from "zod";
import {
  agentProcedure,
  createAgentRuntime,
  defineGovernance,
  createCapabilityRegistry,
  type ApprovalCoordinator,
  type AgentInvocationInfo,
} from "@orpc-agent/core";
import { describeApprovalCoordinatorContract } from "../../../test-fixtures/approval-coordinator-contract";
import { APPROVALS_DDL, createPgApprovalCoordinator } from "../src/approvals";
import type { PgQuery } from "../src/query";

// ---- Contract suite over pglite (in-process Postgres, no docker) ----

const db = new PGlite();
const pgliteQuery: PgQuery = (sql, params) => db.query(sql, params);
let ddlApplied = false;

async function freshTable(): Promise<void> {
  if (!ddlApplied) {
    await db.exec(APPROVALS_DDL);
    ddlApplied = true;
  }
  await db.exec("truncate table orpc_agent_approvals");
}

afterAll(async () => {
  await db.close();
});

describeApprovalCoordinatorContract("postgres (pglite)", async (now) => {
  await freshTable();
  return createPgApprovalCoordinator({ query: pgliteQuery, now });
});

// ---- Construction guards ----

describe("construction", () => {
  test("requires a query function", () => {
    expect(() =>
      createPgApprovalCoordinator({} as Parameters<typeof createPgApprovalCoordinator>[0]),
    ).toThrowError(/query is required/);
  });

  test("rejects unsafe table names (never interpolated unvalidated)", () => {
    for (const table of ["x; drop table users", 'a"b', "1abc", "UPPER", "a.b.c", ""]) {
      expect(() => createPgApprovalCoordinator({ query: pgliteQuery, table })).toThrowError(
        /Invalid table name/,
      );
    }
    expect(() =>
      createPgApprovalCoordinator({ query: pgliteQuery, table: "governance.approvals" }),
    ).not.toThrow();
  });
});

// ---- Full pipeline over the persistent coordinator ----
// The lifecycle the guide promises: invoke → suspend → decide → resume →
// consumed, with the record surviving in real SQL between every step.

describe("runtime integration (pglite)", () => {
  const base = agentProcedure(os.$context<{ agent?: AgentInvocationInfo }>());
  const send = base
    .meta({
      agent: {
        description: "Send a message.",
        expose: { direct: true },
        sideEffect: "external",
        risk: "high",
        approval: { required: true, type: "manager" },
      },
    })
    .input(z.object({ draftId: z.string() }))
    .handler(async () => ({ messageId: "m_1" }));

  test("invoke → decide → resume → consumed, exactly once", async () => {
    await freshTable();
    const coordinator = createPgApprovalCoordinator({ query: pgliteQuery });
    const runtime = createAgentRuntime({ governance: defineGovernance({ registry: createCapabilityRegistry({ messages: { send } }) }), approvals: { coordinator } });
    const actor = { id: "u_dana", kind: "user" as const };

    const pending = await runtime.invoke(
      "messages.send",
      { draftId: "d_1" },
      { actor, context: {} },
    );
    if (pending.status !== "approval-required") expect.unreachable();

    // The suspension is durable: a second coordinator over the same database
    // (a "restarted process") sees and decides it.
    const afterRestart: ApprovalCoordinator = createPgApprovalCoordinator({ query: pgliteQuery });
    const stored = await afterRestart.get(pending.approval.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.input).toEqual({ draftId: "d_1" });

    await runtime.approvals.decide(pending.approval.id, {
      status: "approved",
      approver: { id: "u_priya", kind: "user" },
    });

    const final = await runtime.resume(pending.approval.id, { context: {} });
    if (final.status !== "completed") expect.unreachable();
    expect(final.output).toEqual({ messageId: "m_1" });

    const again = await runtime.resume(pending.approval.id, { context: {} });
    if (again.status !== "failed") expect.unreachable();
    expect(again.error.code).toBe("APPROVAL_CONSUMED");

    const consumed = await afterRestart.get(pending.approval.id);
    expect(consumed?.status).toBe("consumed");
    expect(consumed?.consumedByExecutionId).toBe(final.executionId);
  });
});

// ---- The same contract + a genuine two-connection race, on a real server ----
// Opt-in: TEST_DATABASE_URL=postgres://… pnpm test

const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("postgres (pg driver)", () => {
  const raceTable = `orpc_agent_approvals_race_${process.pid}`;

  async function withPool<T>(fn: (pool: import("pg").Pool) => Promise<T>): Promise<T> {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  }

  describeApprovalCoordinatorContract("postgres (pg driver)", async (now) => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    await pool.query(APPROVALS_DDL);
    await pool.query("truncate table orpc_agent_approvals");
    // The pool outlives the test harmlessly; contract tests are short-lived.
    return createPgApprovalCoordinator({ query: (sql, params) => pool.query(sql, params), now });
  });

  test("T8 race: concurrent markConsumed on two real connections — one winner", async () => {
    await withPool(async (pool) => {
      await pool.query(APPROVALS_DDL.replaceAll("orpc_agent_approvals", raceTable));
      await pool.query(`truncate table ${raceTable}`);

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        const now = () => new Date();
        const viaA = createPgApprovalCoordinator({
          query: (sql, params) => a.query(sql, params),
          table: raceTable,
          now,
        });
        const viaB = createPgApprovalCoordinator({
          query: (sql, params) => b.query(sql, params),
          table: raceTable,
          now,
        });

        const request = {
          id: "apr_race",
          capabilityId: "orders.refund",
          surface: "aiSdk" as const,
          actor: { id: "u_dana", kind: "user" as const },
          input: { amount: 649 },
          inputHash: "0".repeat(64),
          reasons: ["race"],
          types: ["manager"],
          risk: "high" as const,
          sideEffect: "write" as const,
          requestedAt: now(),
          expiresAt: new Date(Date.now() + 60_000),
        };
        await viaA.create(request);
        await viaA.decide("apr_race", {
          status: "approved",
          approver: { id: "u_priya", kind: "user" },
        });

        const outcomes = await Promise.allSettled([
          viaA.markConsumed("apr_race", "exe_a"),
          viaB.markConsumed("apr_race", "exe_b"),
        ]);
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
        const final = await viaA.get("apr_race");
        expect(final?.status).toBe("consumed");
      } finally {
        a.release();
        b.release();
        await pool.query(`drop table if exists ${raceTable}`);
      }
    });
  }, 20_000);
});
