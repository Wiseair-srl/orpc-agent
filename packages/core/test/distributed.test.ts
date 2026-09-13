import { describe, expect, test } from "vitest";
import { os, createRouterClient, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { z } from "zod";
import { agentProcedure } from "../src/procedure";
import { createCapabilityRegistry } from "../src/registry";
import { defineGovernance } from "../src/governance";
import { createAgentRuntime } from "../src/runtime/create";
import { createInMemoryApprovalCoordinator } from "../src/approvals/in-memory";
import { createCapabilityGateway, createInMemoryInvocationJournal } from "../src/server/index";
import { createCapabilityClient } from "../src/client/index";
import { createHttpCapabilityClient } from "../src/http";
import type { Actor, AgentInvocationInfo } from "../src/types";
import type { AgentAuditEvent } from "../src/events";
import type { CapabilityGatewayOperation } from "../src/server/index";

function fixture({ approval = false, handler, audit, requestTimeoutMs }: { approval?: boolean; handler?: () => Promise<unknown>; audit?: (event: AgentAuditEvent) => Promise<void>; requestTimeoutMs?: number } = {}) {
  const invocations: AgentInvocationInfo[] = [];
  const actor: Actor = { id: "one", kind: "user", attributes: { role: "new" } };
  let namespace = "tenant-one";
  let revision = "one";
  let denied = false;
  const authorization: { operation: CapabilityGatewayOperation; input?: unknown }[] = [];
  const coordinator = createInMemoryApprovalCoordinator();
  const journal = createInMemoryInvocationJournal();
  const operation = agentProcedure(os.$context<{ agent?: AgentInvocationInfo }>())
    .meta({ agent: { description: "Write a resource", expose: { aiSdk: true }, sideEffect: "write", risk: "high", approval: { required: approval }, adapters: { aiSdk: { toolName: "resource_write" } } } })
    .input(z.object({ resourceId: z.string() }))
    .handler(async ({ input, context }) => { invocations.push(context.agent!); return handler ? handler() : { resourceId: input.resourceId, at: new Date("2026-09-13T00:00:00Z") }; });
  const governance = defineGovernance({ registry: createCapabilityRegistry({ resource: { write: operation } }) });
  const gateway = () => createCapabilityGateway<{}, { agent?: AgentInvocationInfo }>({
    authenticate: async () => ({ actor: structuredClone(actor), namespace, context: {} }),
    authorize: async ({ operation, input }) => { authorization.push({ operation, input }); if (denied) throw new ORPCError("FORBIDDEN"); },
    createRuntime: () => createAgentRuntime({ governance, approvals: { coordinator }, audit: audit ?? (() => {}) }),
    journal, surface: "aiSdk", revision, requestTimeoutMs,
    ...(requestTimeoutMs ? { auditDrainTimeoutMs: 5 } : {}),
  });
  const client = () => createCapabilityClient({ rpc: createRouterClient(gateway(), { context: {} }) });
  return { client, gateway, invocations, coordinator, journal, authorization, actor, setNamespace: (v: string) => { namespace = v; }, setRevision: (v: string) => { revision = v; }, deny: () => { denied = true; } };
}

describe("distributed governance", () => {
  test("native HTTP discovery and invocation need no registry in the client; output Dates are ISO", async () => {
    const f = fixture();
    const handler = new RPCHandler(f.gateway());
    const client = createHttpCapabilityClient({ url: "http://localhost/capabilities", fetch: async (request, init) => {
      const { response } = await handler.handle(new Request(request, init), { prefix: "/capabilities", context: {} });
      return response!;
    } });
    const descriptors = await client.describe();
    expect(descriptors[0]).toMatchObject({ version: 1, id: "resource.write", path: ["resource", "write"], toolNames: { aiSdk: "resource_write" }, discovery: "discoverable" });
    const result = await client.invoke("resource.write", { resourceId: "a" }, { invocationId: "run-1" });
    expect(result).toMatchObject({ status: "completed", invocationId: "run-1", output: { at: "2026-09-13T00:00:00.000Z" } });
    expect(f.invocations[0]?.surface).toBe("aiSdk");
  });

  test("transport retry reuses result; changed input/capability conflicts; receipt remains private", async () => {
    const f = fixture();
    const client = f.client();
    const one = await client.invoke("resource.write", { resourceId: "a" }, { invocationId: "1", correlationId: "conversation-1" });
    expect(await client.invoke("resource.write", { resourceId: "a" }, { invocationId: "1" })).toEqual(one);
    expect(await client.invoke("resource.write", { resourceId: "b" }, { invocationId: "1" })).toMatchObject({ status: "failed", error: { code: "INVOCATION_CONFLICT" } });
    expect(f.invocations).toHaveLength(1);
    expect(f.invocations[0]?.correlationId).toBe("conversation-1");
    const receipt = await client.getInvocation("1");
    expect(receipt).toMatchObject({ state: "settled", outcome: one });
    expect(receipt).not.toHaveProperty("input");
    expect(receipt).not.toHaveProperty("idempotencyKey");
    expect(f.authorization.at(-1)).toEqual({ operation: "getInvocation", input: { resourceId: "a" } });
  });

  test("concurrent pending request is outcome unknown and never executes twice", async () => {
    let release!: () => void;
    const f = fixture({ handler: () => new Promise((resolve) => { release = () => resolve("done"); }) });
    const first = f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    await expect.poll(() => f.invocations.length).toBe(1);
    expect(await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" })).toEqual({ status: "outcome-unknown", invocationId: "1" });
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(f.invocations).toHaveLength(1);
  });

  test("receipt and approval lookup are isolated by actor and tenant, even with the same ID", async () => {
    const f = fixture({ approval: true });
    const result = await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    if (result.status !== "approval-required") throw new Error("Expected approval");
    expect(result.approval).not.toHaveProperty("input");
    f.actor.id = "two";
    expect(await f.client().getInvocation("1")).toBeNull();
    expect(await f.client().getApproval(result.approval.id)).toBeNull();
    f.actor.id = "one";
    f.setNamespace("tenant-two");
    expect(await f.client().getInvocation("1")).toBeNull();
    expect(await f.client().getApproval(result.approval.id)).toBeNull();
  });

  test("approval across new runtimes preserves correlation, stable key and current requester attributes", async () => {
    const f = fixture({ approval: true });
    const result = await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1", correlationId: "run-1" });
    if (result.status !== "approval-required") throw new Error("Expected approval");
    const again = await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    expect(again).toEqual(result);
    expect(await f.client().resumeApproval(result.approval.id, { invocationId: "1" })).toEqual(result);
    await f.coordinator.decide(result.approval.id, { status: "approved", approver: { id: "manager", kind: "user" } });
    f.actor.attributes = { role: "fresh" };
    const resumed = await f.client().resumeApproval(result.approval.id, { invocationId: "1", correlationId: "forged-run" });
    expect(resumed.status).toBe("completed");
    expect(await f.client().resumeApproval(result.approval.id, { invocationId: "1" })).toEqual(resumed);
    expect(f.invocations).toHaveLength(1);
    expect(f.invocations[0]).toMatchObject({ correlationId: "run-1", actor: { id: "one", attributes: { role: "fresh" } }, approval: { approver: { id: "manager" } } });
    expect(f.invocations[0]?.idempotencyKey).toMatch(/^idk_[a-f0-9]{64}$/);
  });

  test("changed deployment revision blocks stale approval before consumption", async () => {
    const f = fixture({ approval: true });
    const result = await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    if (result.status !== "approval-required") throw new Error("Expected approval");
    await f.coordinator.decide(result.approval.id, { status: "approved", approver: { id: "manager", kind: "user" } });
    f.setRevision("two");
    expect(await f.client().resumeApproval(result.approval.id, { invocationId: "1" })).toMatchObject({ status: "failed", error: { code: "CONTRACT_MISMATCH" } });
    expect((await f.coordinator.get(result.approval.id))?.status).toBe("approved");
    expect(f.invocations).toHaveLength(0);
  });

  test("authorization is freshly enforced for cached receipts", async () => {
    const f = fixture();
    await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    f.deny();
    await expect(f.client().getInvocation("1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.invocations).toHaveLength(1);
  });

  test("wire request cannot select actor, surface or namespace", async () => {
    const f = fixture();
    const rpc = createRouterClient(f.gateway(), { context: {} });
    await expect(rpc.invoke({ capabilityId: "resource.write", input: { resourceId: "a" }, invocationId: "1", surface: "direct" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.invocations).toHaveLength(0);
  });

  test("output serialization failure leaves a reconcilable pending claim and prevents replay", async () => {
    const f = fixture({ handler: async () => new Map([["unsupported", true]]) });
    expect(await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" })).toEqual({ status: "outcome-unknown", invocationId: "1" });
    expect(await f.client().getInvocation("1")).toMatchObject({ state: "pending" });
    await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    expect(f.invocations).toHaveLength(1);
  });

  test("audit drain failure does not erase a settled receipt or repeat an effect", async () => {
    const f = fixture({ audit: async () => { throw new Error("audit offline"); } });
    expect(await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" })).toEqual({ status: "outcome-unknown", invocationId: "1" });
    expect(await f.client().getInvocation("1")).toMatchObject({ state: "settled", outcome: { status: "completed" } });
    await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    expect(f.invocations).toHaveLength(1);
  });

  test("total request deadline bounds audit drain and exposes unknown completion", async () => {
    const f = fixture({ requestTimeoutMs: 20, handler: async () => new Promise(() => {}) });
    const start = performance.now();
    const outcome = await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
    expect(["cancelled", "outcome-unknown"]).toContain(outcome.status);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

test("a signal-ignoring late write remains unknown and cannot be repeated", async () => {
  let release!: () => void;
  let effects = 0;
  const f = fixture({ requestTimeoutMs: 30, handler: () => new Promise((resolve) => { release = () => { effects++; resolve("committed"); }; }) });
  const outcome = await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "late" });
  expect(outcome).toEqual({ status: "outcome-unknown", invocationId: "late" });
  release();
  await Promise.resolve();
  expect(effects).toBe(1);
  expect(await f.client().getInvocation("late")).toMatchObject({ state: "pending" });
  expect(await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "late" })).toEqual(outcome);
  expect(f.invocations).toHaveLength(1);
});
test("an error after the handler enters never asserts the effect failed", async () => {
  let effects = 0;
  const f = fixture({ handler: async () => { effects++; throw new Error("post-commit failure"); } });
  expect(await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" })).toEqual({ status: "outcome-unknown", invocationId: "1" });
  expect(await f.client().getInvocation("1")).toMatchObject({ state: "pending" });
  await f.client().invoke("resource.write", { resourceId: "a" }, { invocationId: "1" });
  expect(effects).toBe(1);
});
