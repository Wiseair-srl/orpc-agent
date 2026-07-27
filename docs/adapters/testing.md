# Adapter: testing

> **Status:** Implemented in v0.1. Package: `@orpc-agent/testing`. Depends only on `@orpc-agent/core` — no model, no network, no protocol SDKs.

Governance you can't test deterministically is governance you don't have. This package makes exposure, policies, approvals, redaction, and audit behavior assertable in plain unit tests — **without invoking an LLM**. Surface id defaults to **`test`**, overridable per call to simulate any surface.

## The test runtime

```ts
import { createAgentTestRuntime, fakeActor, testClock } from "@orpc-agent/testing";

const t = createAgentTestRuntime({
  registry: capabilities,
  policies: [orgIsolation, refundLimit],
  actor: fakeActor({ kind: "user", attributes: { orgId: "org_1", permissions: ["orders:refund"] } }),
  context: { organizationId: "org_1", db: fakeDb },
  overrides: {
    "orders.refund": async ({ input }) => ({ refundId: "ref_test", amount: input.amount, status: "issued" }),
  },
  clock: testClock("2026-07-27T10:00:00Z"),
});
```

| Option | Purpose |
|---|---|
| `registry`, `policies` | The real production objects — test what ships |
| `actor`, `context` | Defaults for every call; per-call override for actor-matrix tests |
| `overrides` | Replace handlers by capability id — test governance without databases; omit to execute real handlers (integration mode) |
| `approvals` | `approvalProbe()` (default), `"auto-approve"`, `"auto-reject"`, or a custom coordinator |
| `clock` | Drives `now` — expiry tests without sleeping |

The test runtime wraps a real `createAgentRuntime` — same pipeline, same codepaths — with fakes injected at the defined seams (`now`, coordinator, sinks, handlers). It never reimplements governance.

## What you assert, by concern

```ts
// Exposure and visibility (SI-1, SI-8)
const listed = await t.describe("mcp");
expect(listed.map(d => d.id)).not.toContain("orders.refund");

const res = await t.invoke("orders.refund", input, { surface: "mcp" });
expect(res.status).toBe("failed");
expect(res.error.code).toBe("CAPABILITY_NOT_FOUND");        // concealed, not FORBIDDEN

// Policy decisions
const denied = await t.invoke("orders.refund", { ...input, amount: 9000 });
expect(denied.error.code).toBe("POLICY_DENIED");
expect(denied.error.publicMessage).toMatch(/cannot be issued/);

// Approval lifecycle (SI-4, SI-5)
const pending = await t.invoke("orders.refund", { ...input, amount: 649 });
expect(pending.status).toBe("approval-required");

await t.approvals.approve(pending.approval.id, fakeActor({ id: "u_manager" }));
const done = await t.resume(pending.approval.id);
expect(done.status).toBe("completed");

const again = await t.resume(pending.approval.id);
expect(again.error.code).toBe("APPROVAL_CONSUMED");          // single-use

// Self-approval rejected
await t.approvals.approve(p2.approval.id, t.defaultActor);
expect((await t.resume(p2.approval.id)).error.code).toBe("APPROVAL_SELF_APPROVAL");

// Expiry via the clock
t.clock.advance("16m");
expect((await t.resume(p3.approval.id)).error.code).toBe("APPROVAL_EXPIRED");

// Redaction (what models may see)
const ok = await t.invoke("customers.get", { id: "c_1" });
expect(ok.output.paymentMethods).toBeUndefined();

// Timeout & cancellation (SI-12) — with an override that honors the signal
const slow = await t.invoke("orders.search", q, { timeoutMs: 10 });   // per-call override in tests
expect(slow.status).toBe("cancelled");
expect(slow.error.code).toBe("TIMEOUT");

// Audit trail
expect(t.audit.ofType("capability.denied")).toHaveLength(1);
expect(t.audit.events().map(e => e.type)).toEqual(expect.arrayContaining([
  "capability.requested", "capability.approval_requested", "capability.approved",
  "capability.started", "capability.completed",
]));
```

## Fakes

| Fake | Contract |
|---|---|
| `fakeActor(partial?)` | Well-formed `Actor` with stable defaults (`{ id: "test-user", kind: "user" }`) |
| `testClock(startIso?)` | `.now()`, `.advance("15m" \| ms)` — injected as runtime `now` and coordinator clock |
| `approvalProbe()` | In-memory coordinator + test API: `.pending()`, `.approve(id, approver?)`, `.reject(id, approver?)`; exposed as `t.approvals` |
| `capturedAudit()` | Sink + query API: `.events()`, `.ofType(type)`, `.clear()`; exposed as `t.audit`. Doubles as the reference `AuditSink` implementation |

`"auto-approve"` / `"auto-reject"` configure an inline handler with a distinct `approver` (`{ id: "auto-approver", kind: "automation" }`) so self-approval checks stay honest even in shortcuts.

## Adapter conformance

A conformance checklist, implemented as a describe-block factory, that every adapter package runs against a shared fixture registry. As built in v0.1 it ships as in-repo test infrastructure (`test-fixtures/conformance.ts`, exercised by both `@orpc-agent/ai-sdk` and `@orpc-agent/mcp`) rather than a public export — see [ADR-012](../architecture/decisions.md#adr-012-as-built-api-deltas-for-v01). The checks:

1. Discovery lists exactly the exposed, non-hidden capabilities for the adapter's surface.
2. Raw arguments reach the runtime unvalidated (a schema-invalid call yields `INPUT_INVALID` *from the runtime*).
3. All four envelope statuses translate deterministically; concealed errors serialize the generic shape (SI-9).
4. Tool-name mapping is bijective; collisions fail at build.
5. Cancellation propagates from the protocol signal to the handler (observed via an override that records `signal.aborted`).

## Testing philosophy

- **Test policies as functions** first (`refundLimit({ ...request })` returns a decision — they're pure), then **as wired** through `t.invoke` (ordering, precedence, fail-closed behavior).
- **Use overrides for governance tests, real handlers for contract tests.** Governance tests shouldn't need a database; handler tests shouldn't need policies in the way (`policies: []`).
- **Every SI invariant has a test shape above** — the required test matrix in the [implementation brief](../implementation/brief.md#required-test-matrix) is written in this package's vocabulary.

## Related

- [Guide: testing capabilities](../guides/testing-capabilities.md) (task-oriented walkthrough) · [Reference: configuration](../reference/configuration.md#adapter-options)
