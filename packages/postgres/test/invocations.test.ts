import { afterAll, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPgInvocationJournal, INVOCATIONS_DDL } from "../src/invocations";
import type { InvocationRecord } from "@orpc-agent/core/server";
const db = new PGlite();
const query = (sql: string, params?: unknown[]) => db.query<Record<string, unknown>>(sql, params);
const journal = createPgInvocationJournal({ query });
afterAll(() => db.close());
function record(id: string): InvocationRecord {
  return { scope: "tenant-user", invocationId: id, capabilityId: "orders.write", input: { id: "order" }, inputHash: "hash", contractDigest: "digest", idempotencyKey: "stable-effect-key", claimToken: "owner", state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
test("Postgres claims are atomic across instances; pending rows never become reusable", async () => {
  await db.exec(INVOCATIONS_DDL);
  const second = createPgInvocationJournal({ query });
  const results = await Promise.all([journal.claim(record("one")), second.claim({ ...record("one"), claimToken: "other" })]);
  expect(results.filter((r) => r.claimed)).toHaveLength(1);
  expect(results[0]?.record.claimToken).toBe(results[1]?.record.claimToken);
  expect((await journal.claim(record("one"))).claimed).toBe(false);
  await expect(journal.settle("tenant-user", "one", "wrong", { status: "outcome-unknown", invocationId: "one" })).rejects.toThrow("ownership");
  const owner = results[0]!.record.claimToken;
  await second.settle("tenant-user", "one", owner, { status: "completed", executionId: "execution", invocationId: "one", output: { value: true } });
  expect(await journal.get("tenant-user", "one")).toMatchObject({ state: "settled", outcome: { status: "completed", output: { value: true } } });
  expect(await journal.get("other-user", "one")).toBeNull();
});
test("Postgres approval continuation uses CAS and preserves effect identity", async () => {
  await db.exec(INVOCATIONS_DDL);
  await journal.claim(record("approval"));
  await journal.settle("tenant-user", "approval", "owner", { status: "approval-required", invocationId: "approval", executionId: "exe", approval: { id: "apr", capabilityId: "orders.write", status: "pending", reasons: [], types: [], requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString() } });
  expect(await journal.findApproval("tenant-user", "apr")).toMatchObject({ invocationId: "approval", approvalId: "apr" });
  const claims = await Promise.all([journal.claimResume("tenant-user", "approval", "apr", "resume-owner"), journal.claimResume("tenant-user", "approval", "apr", "competitor")]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const pending = await journal.get("tenant-user", "approval");
  expect(pending).toMatchObject({ state: "pending", idempotencyKey: "stable-effect-key", approvalId: "apr" });
  expect(pending).not.toHaveProperty("outcome");
  await journal.settle("tenant-user", "approval", pending!.claimToken, { status: "completed", invocationId: "approval", executionId: "resume-exe", output: "done" });
  expect(await journal.findApproval("tenant-user", "apr")).toMatchObject({ state: "settled", outcome: { status: "completed" } });
  expect(await journal.claimResume("tenant-user", "approval", "apr", "repeat")).toBe(false);
});
