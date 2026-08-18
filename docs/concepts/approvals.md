# Approvals

> Normative approval semantics. The end-to-end wiring is in [guides/human-approval.md](../guides/human-approval.md).

An **approval** is a trusted decision required before a capability executes. It is a *lifecycle*, not a boolean: requested, pending, decided, expiring, consumed — each transition attributable and audited.

Two invariants define the design ([ADR-006](../architecture/decisions.md#adr-006-approvals-are-external-and-input-bound)):

1. **Models cannot approve themselves** (SI-4). A decision must originate from a trusted human, deterministic policy, or an external authorized system. Any flow where model output constitutes the approval is theater.
2. **Approval binds the exact operation** (SI-5). The record ties capability id + requesting actor + a hash of the canonical validated input. Change anything → new approval. Execute once → consumed.

## Lifecycle

```text
            requireApproval() / meta.approval.required
                            |
                            v
   +-----------------  PENDING  ------------------+
   |            (expiresAt running)               |
   v                    v                         v
REJECTED            APPROVED                  EXPIRED
   |                    |                         
   |                    v  runtime.resume(id, { context })
   |         integrity checks: approved? unexpired?
   |         unconsumed? hash match? approver != requester?
   |                    |
   |                    v
   |                CONSUMED  --> execution proceeds (stages 9-15)
   |
   +--> terminal; a new invocation creates a NEW request
   (CANCELLED: application withdrew the request before decision)
```

Distinct acts, deliberately separated:

- **Approving** an operation (coordinator `decide`) records a decision. It executes nothing.
- **Executing** an approved operation (`runtime.resume`) re-enters the pipeline with integrity checks and fresh execution-phase policies.
- **Retrying** an approved operation: runtime-managed retries inside the same execution are covered by the consumed record; a **new invocation** — even with identical input — requires a new approval.
- **Changing input** after approval is impossible by construction: the stored input is what executes, and its hash must match.
- **Expiration** bounds the window in which a stale "yes" can act.

## Requesting approval

Two routes converge into identical requests at pipeline stage 8:

```ts
// Static: every invocation gates
meta: { agent: { approval: { required: true, type: "human-confirmation" }, ... } }

// Conditional: policy-driven
requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager", expiresInMs: 3_600_000 })
```

The runtime creates the record, emits `capability.approval_requested`, and returns:

```ts
const result = await runtime.invoke("orders.refund", input, { actor, context, surface: "aiSdk" });
// result.status === "approval-required"; result.approval.id, .reasons, .expiresAt
```

What the requester (and the model, via adapters) sees is the pending record — never a way to decide it.

## Deciding

Your application surfaces pending approvals to authorized approvers (dashboard, Slack, CLI — your choice) and records decisions through the coordinator:

```ts
await runtime.approvals.decide(approvalId, {
  status: "approved",
  approver: { id: "u_manager_7", kind: "user", displayName: "Priya" },
  comment: "Verified with customer",
});
```

*Who may approve* is your application's authorization question — gate the decide endpoint like any privileged operation. The runtime enforces the structural rules: pending-only transitions, expiry, and approver ≠ requester (`APPROVAL_SELF_APPROVAL`; disable only via `rejectSelfApproval: false` with a documented reason).

Approval UIs display `redact.approvalInput(input)` when defined — approvers see what they need; the hash still binds the full input.

## Resuming

```ts
const final = await runtime.resume(approvalId, { context: freshContext });
```

Resume runs as the **original actor** (identity is bound in the record; no re-attribution), with the approver recorded in `context.agent.approval`. The caller supplies fresh application context — live handles are not serializable, and stale context is exactly what execution-phase policies exist to catch.

When an *adapter* relays resume on behalf of an external session (the MCP resume tool), it passes the binding guards `expectedActor` / `expectedSurface`: the record's requester and surface must match, or the resume fails concealed — indistinguishable from an unknown id to the caller, truthfully coded in audit (`APPROVAL_RESUME_MISMATCH`). Guards restrict who may *trigger* execution; they never change who it runs as.

Every way this can fail has its own code — pending, rejected, expired, already consumed, input mismatch, self-approval, guard mismatch — so the caller never has to guess which check refused ([reference/errors](../reference/errors.md)).

## Two operating modes

**Inline handler** — synchronous decision inside the same call. For CLI confirmation prompts, auto-approval rules, or delegating to an external system that responds within the request:

```ts
approvals: {
  handler: async (req) =>
    req.types.includes("manager") && (await slackApprovalWithTimeout(req))
      ? { status: "approved", approver: SLACK_BRIDGE_ACTOR }
      : { status: "rejected", approver: SLACK_BRIDGE_ACTOR },
}
```

**Coordinator + resume** — the durable shape: `invoke` returns `approval-required`; the app persists, notifies, collects the decision, and later calls `resume`. Core ships `createInMemoryApprovalCoordinator` (dev/test only — records die with the process); `@orpc-agent/postgres` ships the reference persistent one, and any other store implements `ApprovalCoordinator` directly. The interface is the durability seam ([ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based)); workflow-engine-backed coordinators are the planned path for long-lived, restart-surviving approvals.

## Input integrity mechanics

- Canonical serialization: JSON with lexicographically sorted object keys, UTF-8, no insignificant whitespace; SHA-256 over the bytes.
- Hashed value: the **validated** input (post parsing/defaults), the same value that will execute (SI-6).
- Approval-gated capabilities therefore require JSON-serializable validated input; otherwise the invocation fails with `APPROVAL_UNSERIALIZABLE_INPUT` rather than gating on an unverifiable value.
- On resume the stored input is re-hashed and compared (tamper check on the store), then re-validated against the *current* schema (deploys happen between request and decision).

## Related

- Guide: [human-approval.md](../guides/human-approval.md) (end-to-end wiring) · Reference: [runtime.md](../reference/runtime.md#runtime-approvals)
- Security: [security-model.md](../security/security-model.md) · Example: [customer-support-agent.md](../examples/customer-support-agent.md)
