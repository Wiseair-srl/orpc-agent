# Guide: human approval

> Semantics: [concepts/approvals.md](../concepts/approvals.md). This guide wires the full loop: gate → surface → decide → resume — plus the inline variant.

## 1. Gate the capability

Conditional (policy) or static (meta) — both converge at pipeline stage 8:

```ts
export const refundLimit = definePolicy("refund-limit", ({ capability, input }) =>
  capability.id === "orders.refund" && (input as RefundInput).amount > 500
    ? requireApproval({ reason: `Refund of $${(input as RefundInput).amount} exceeds $500`, approvalType: "manager" })
    : allow());

// or, for always-gated operations:
.meta({ agent: { approval: { required: true, type: "human-confirmation" }, /* ... */ } })
```

Gate sparingly. Approvals only work when approvers actually read them; a queue of forty daily rubber-stamps is worse than three real decisions ([prompt-injection.md](../security/prompt-injection.md#what-the-framework-will-not-claim)).

## 2. Return the suspension to the requester

```ts
const result = await runtime.invoke("orders.refund", input, { actor, context, surface: "aiSdk" });
if (result.status === "approval-required") {
  // result.approval: { id, reasons, types, expiresAt, ... }
  // adapters already translate this for models; your UI shows "pending approval"
}
```

Nothing executed; the model/user is told why and by when a decision is needed.

## 3. Build the approver surface

Your app owns this UI (dashboard page, Slack message, CLI). It reads pending requests and records decisions — gate it like any privileged endpoint (who may approve is *your* authorization question):

```ts
// GET /admin/approvals
const pending = await runtime.approvals.list?.({ status: "pending" });
// render: capabilityId, requester, reasons, expiresAt,
// and the display input: meta.redact.approvalInput?.(input) ?? input

// POST /admin/approvals/:id/decision   (behind requirePermission("approvals:decide"))
await runtime.approvals.decide(id, {
  status: body.approved ? "approved" : "rejected",
  approver: { id: session.userId, kind: "user", displayName: session.name },
  comment: body.comment,
});
```

Design the card for a ten-second read: **what** (capability + redacted input), **who asked** (actor), **why gated** (reasons), **when it dies** (expiresAt). The runtime enforces the structural rules — pending-only, expiry, approver ≠ requester (SI-4).

Match expiry to the surface: the 15-minute default (`defaults.approvalExpiresInMs`) assumes the approver is present. A dashboard someone checks a few times a day needs hours (`meta.approval.expiresInMs` per gate, or the runtime default) — otherwise requests expire before anyone sees them and every approval becomes a re-ask.

## 4. Execute the approved operation

Deciding records intent; executing is separate and explicit:

```ts
// same request handler, a worker, or a queue consumer:
const final = await runtime.resume(approvalId, { context: await createAppContext(/* fresh */) });

switch (final.status) {
  case "completed":  await notifyRequester(final.output); break;
  case "failed":     await notifyRequester(final.error.publicMessage); break;  // e.g. APPROVAL_EXPIRED
  case "cancelled":  /* timeout during execution */ break;
}
```

Resume runs as the **original requester** with integrity checks (hash match, single-use consumption, fresh execution-phase policies) — [the lifecycle walkthrough](../concepts/lifecycle.md#act-4-resumption-with-integrity) shows each check firing.

Close the loop back to the conversation: post the outcome into the chat thread (your app's job — the adapter can't, the model call is long gone).

Over MCP the adapter can close most of this loop for you: `approvals.url` puts a deep link to this approver surface in the suspension envelope, and `approvals.resumeTool` lets the requesting session execute the operation once it's approved — deciding still happens here, never over MCP ([adapter doc](../adapters/mcp.md#closing-the-approval-loop-from-chat)).

## Inline confirmation

When the human is *present* and latency is seconds, skip the suspend/resume machinery:

```ts
const runtime = createAgentRuntime({
  governance,
  approvals: {
    handler: async (req) => {
      const yes = await promptUserInUI(req);          // modal, CLI prompt, Slack interactive msg
      return {
        status: yes ? "approved" : "rejected",
        approver: { id: currentApprover.id, kind: "user" },
      };
    },
  },
});
```

`invoke` blocks through the decision and returns `completed`/`failed` directly. Use for human-confirmation gates (`messages.send` in the reference app); use the coordinator flow when decisions take minutes-to-days or must survive restarts.

## Production coordinator

The default in-memory coordinator **loses records on restart** — dev/test only. On Postgres, use the reference implementation and you're done:

```ts
import { createPgApprovalCoordinator, APPROVALS_DDL } from "@orpc-agent/postgres";

const runtime = createAgentRuntime({
  governance,
  approvals: {
    coordinator: createPgApprovalCoordinator({
      query: (sql, params) => pool.query(sql, params),
    }),
  },
});
```

Details, DDL, and the JSON round-trip caveat for `Date`-bearing inputs: [adapters/postgres.md](../adapters/postgres.md). On any other store, implement the five-method interface yourself:

```ts
export function createDbApprovalCoordinator(db: Database): ApprovalCoordinator {
  return {
    async create(req)  { await db.approvals.insert(serialize(req)); return read(req.id); },
    async get(id)      { return maybe(await db.approvals.byId(id)); },
    async decide(id, decision) { /* UPDATE ... WHERE id AND status='pending' AND expires_at > now; throw on 0 rows */ },
    async markConsumed(id, executionId) {
      // MUST be atomic: UPDATE ... SET status='consumed', consumed_by=$2
      // WHERE id=$1 AND status='approved' AND consumed_by IS NULL; throw on 0 rows (T8)
    },
    async list(filter) { /* ... */ },
  };
}
```

Contract points that matter: `decide` and `markConsumed` are compare-and-set operations; expiry is evaluated against the coordinator's clock; store the validated input verbatim — the hash check (SI-5) detects drift. Run the shared contract suite (`test-fixtures/approval-coordinator-contract.ts`) against your implementation — it is the same suite the in-memory and Postgres coordinators pass. Workflow-engine-backed coordinators are the planned durable path ([ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based)).

## Checklist

- [ ] Gates on operations where a human pause changes outcomes (not everything)
- [ ] Approver endpoint behind real authorization
- [ ] Approval card readable in ten seconds (`redact.approvalInput` set for rich inputs)
- [ ] Outcome posted back to the requesting conversation/UI
- [ ] Production coordinator persistent + atomic; in-memory only in dev
- [ ] Tests: pending → approve → resume → consumed; reject; expire; self-approval ([testing-capabilities.md](testing-capabilities.md))
