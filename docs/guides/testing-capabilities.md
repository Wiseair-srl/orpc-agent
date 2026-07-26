# Guide: testing capabilities

> **Status:** Design draft — Proposed API. Package reference: [adapters/testing.md](../adapters/testing.md).

Governance is code; test it like code. Everything below runs deterministically in CI — no model, no network. The examples use Vitest; any runner works.

## Setup pattern

One helper per app builds the test runtime with production registry + policies and per-test knobs:

```ts
// test/helpers.ts
import { createAgentTestRuntime, fakeActor, testClock } from "@orpc-agent/testing";
import { capabilities } from "../src/capabilities";
import { governancePolicies } from "../src/policies";

export function makeRuntime(overrides: Parameters<typeof createAgentTestRuntime>[0] extends infer O ? Partial<O> : never = {}) {
  return createAgentTestRuntime({
    registry: capabilities,
    policies: governancePolicies,
    actor: fakeActor({ attributes: { orgId: "org_1", permissions: ["orders:refund"] } }),
    context: { organizationId: "org_1" },
    overrides: {
      // stub handlers so governance tests need no database
      "orders.refund": async ({ input }) => ({ refundId: "ref_t", amount: input.amount, status: "issued" }),
      "orders.search": async () => ({ orders: [] }),
    },
    clock: testClock("2026-07-27T10:00:00Z"),
    ...overrides,
  });
}
```

Note: the test runtime accepts per-call conveniences (`actor`, `context`, `surface`, `timeoutMs`) that don't exist on the production `invoke` signature — test ergonomics, clearly test-only.

## The five suites every app should have

### 1. Exposure (SI-1, SI-8)

```ts
test("refund is not reachable over mcp", async () => {
  const t = makeRuntime();
  expect((await t.describe("mcp")).map(d => d.id)).not.toContain("orders.refund");

  const r = await t.invoke("orders.refund", REFUND_INPUT, { surface: "mcp" });
  expect(r.status).toBe("failed");
  expect(r.error.code).toBe("CAPABILITY_NOT_FOUND");          // concealed, not FORBIDDEN
  expect(t.audit.ofType("capability.denied")[0].data.reason).toBe("not-exposed"); // truth in audit
});
```

Add the inverse (`aiSdk` lists it) and a snapshot of `describe("mcp")` ids — surface drift then shows up as a failing snapshot, i.e. a reviewed diff.

### 2. Policy decisions

```ts
test.each([
  [400,  "completed"],
  [649,  "approval-required"],
  [9000, "failed"],                 // POLICY_DENIED
])("refund of $%i → %s", async (amount, status) => {
  const t = makeRuntime();
  const r = await t.invoke("orders.refund", { orderId: "o1", amount, reason: "dmg" });
  expect(r.status).toBe(status);
});

test("policy exceptions fail closed", async () => {
  const boom = definePolicy("boom", () => { throw new Error("db down"); });
  const t = makeRuntime({ policies: [boom] });
  const r = await t.invoke("orders.search", { query: "x" });
  expect(r.error.code).toBe("POLICY_FAILED");                  // SI-7
});
```

Test policies as pure functions too (cheap, exhaustive) — the wired tests then only cover ordering/precedence/audit.

### 3. Approval lifecycle (SI-4, SI-5)

```ts
test("approve → resume → consumed", async () => {
  const t = makeRuntime();
  const p = await t.invoke("orders.refund", { orderId: "o1", amount: 649, reason: "dmg" });
  expect(p.status).toBe("approval-required");

  await t.approvals.approve(p.approval.id, fakeActor({ id: "u_manager" }));
  expect((await t.resume(p.approval.id)).status).toBe("completed");
  expect((await t.resume(p.approval.id)).error.code).toBe("APPROVAL_CONSUMED");
});

test("self-approval is rejected", async () => {
  const t = makeRuntime();
  const p = await t.invoke("orders.refund", { orderId: "o1", amount: 649, reason: "dmg" });
  await t.approvals.approve(p.approval.id, t.defaultActor);    // same identity as requester
  expect((await t.resume(p.approval.id)).error.code).toBe("APPROVAL_SELF_APPROVAL");
});

test("expiry via clock", async () => {
  const t = makeRuntime();
  const p = await t.invoke("orders.refund", { orderId: "o1", amount: 649, reason: "dmg" });
  t.clock.advance("16m");
  await t.approvals.approve(p.approval.id, fakeActor({ id: "u_manager" }));   // decide throws or...
  expect((await t.resume(p.approval.id)).error.code).toBe("APPROVAL_EXPIRED");
});
```

### 4. Redaction and error faces (SI-9, SI-10)

```ts
test("model-visible output is redacted", async () => {
  const t = makeRuntime({ overrides: { "customers.get": async () => FULL_CUSTOMER } });
  const r = await t.invoke("customers.get", { id: "c1" });
  expect(r.output.paymentMethods).toBeUndefined();
  expect(r.output.email).toMatch(/\*\*\*/);
});

test("undeclared handler errors are concealed", async () => {
  const t = makeRuntime({ overrides: { "orders.search": async () => { throw new Error("pg: secret_table"); } } });
  const r = await t.invoke("orders.search", { query: "x" });
  expect(r.error.exposeToModel).toBe(false);
  expect(r.error.publicMessage).toBe("The operation failed.");
  expect(r.error.publicMessage).not.toMatch(/secret_table/);
});
```

### 5. Bounded execution (SI-11, SI-12)

```ts
test("timeout cancels and reports", async () => {
  const t = makeRuntime({
    overrides: { "orders.search": ({ signal }) =>
      new Promise((_, rej) => signal!.addEventListener("abort", () => rej(signal!.reason))) },
  });
  const r = await t.invoke("orders.search", { query: "x" }, { timeoutMs: 10 });
  expect(r.status).toBe("cancelled");
  expect(r.error.code).toBe("TIMEOUT");
});

test("writes are not auto-retried", async () => {
  let calls = 0;
  const t = makeRuntime({ overrides: { "orders.refund": async () => { calls++; throw new CapabilityError({ code: "EXECUTION_FAILED", retryable: true, /* ... */ }); } } });
  await t.invoke("orders.refund", { orderId: "o1", amount: 100, reason: "dmg" });
  expect(calls).toBe(1);                                        // SI-11: no retry without idempotent+config
});
```

## Integration mode

Drop `overrides` to execute real handlers against a test database — same suites, real effects. Recommended split: governance suites with stubs on every PR; a smaller integration suite (one read, one approval-gated write — mirroring the reference app) on merge.

## What not to test here

Model behavior ("does GPT pick the right tool") is prompt engineering, not governance — evaluate it in your eval harness. This layer's promise is narrower and testable: *whatever* the model asks for, these are the outcomes.
