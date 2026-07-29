# Lifecycle walkthrough

> **Status:** Stable — 1.0. This is the narrative companion to the normative [execution pipeline](../architecture/execution-pipeline.md); stage numbers below refer to that document.

Follow one real request end to end: a support agent asks the assistant to refund order `ord_42` for **$649**. The capability `orders.refund` is exposed to `aiSdk`, classified `write`/`high`, and a policy requires manager approval above $500.

## Act 1 — The model asks

The application's chat endpoint has already authenticated Dana (support agent) and built tools for this request:

```ts
const tools = toAISDKTools(runtime, {
  actor: { id: "u_dana", kind: "user", attributes: { orgId: "org_1", permissions: ["orders:refund"] } },
  context: appContext,
});
```

The model, having searched the customer and checked eligibility through *other capabilities*, calls the tool `orders_refund` with `{ orderId: "ord_42", amount: 649, reason: "damaged item" }`. The adapter maps the tool name back to `orders.refund` and calls `runtime.invoke` with `surface: "aiSdk"` (stage 1). Note what did *not* happen: the model never gained identity — Dana is the actor (SI-3).

## Act 2 — The runtime gates

Stages 2–7 run in order: `capability.requested` is emitted; the id resolves; `expose.aiSdk === true` passes; the input validates against the Zod schema (649 is a positive number, the reason is a string); Dana's actor is well-formed; then policies evaluate — `orgIsolation` allows, `refundLimit` sees `amount > 500` and returns `require-approval`.

Combined decision: approval required. The runtime hashes the validated input, stores an `ApprovalRequest` via the coordinator, emits `capability.approval_requested`, and returns:

```ts
{ status: "approval-required", executionId: "exe_01", approval: { id: "apr_9", reasons: ["Refund of $649 exceeds $500"], expiresAt: ... } }
```

The adapter turns this into a structured tool result; the model tells Dana: *"This refund needs manager approval — request apr_9 is pending."* Nothing executed. The model cannot approve apr_9; no capability for deciding approvals exists on this surface (SI-4).

## Act 3 — A human decides

The support dashboard lists pending approvals (via `runtime.approvals.list`). Manager Priya reviews apr_9 — the UI shows `redact.approvalInput(input)`: order, amount, reason — and approves:

```ts
await runtime.approvals.decide("apr_9", { status: "approved", approver: { id: "u_priya", kind: "user" } });
```

`capability.approved` is emitted. Approving executed nothing — deciding and executing are separate acts.

## Act 4 — Resumption with integrity

The dashboard (or a worker) resumes:

```ts
const result = await runtime.resume("apr_9", { context: freshAppContext });
```

Stage 8's resume checks run: record approved, unexpired, unconsumed; stored input re-hashes to the bound hash (SI-5 — had anyone edited the amount in storage, `APPROVAL_INPUT_MISMATCH`); Priya ≠ Dana passes the self-approval check; the record is atomically consumed. A new execution `exe_02` begins, linked to apr_9, running **as Dana** with `context.agent.approval = { id: "apr_9", approver: u_priya }`.

Stage 9 re-runs execution-phase policies (none opted in here), stage 10 arms a 30s timeout signal and emits `capability.started`, and stage 11 calls the procedure through oRPC — where the app's own middleware re-verifies Dana's session, org, and the `orders:refund` permission, exactly as it would for a button click ([ADR-008](../architecture/decisions.md#adr-008-existing-orpc-middleware-remains-authoritative)). The handler issues the refund through the payment service, passing `signal` downstream.

## Act 5 — The governed exit

The output validates against `RefundResult` (stage 12); `redact.output` strips the gateway reference (stage 13); `capability.completed` records 1.8s and one attempt (stage 14); the span `agent.capability_call` closes. The envelope returns:

```ts
{ status: "completed", executionId: "exe_02", output: { refundId: "ref_77", amount: 649, status: "issued" } }
```

The dashboard notifies the chat; the model drafts a customer message with `messages.draft` (no approval — it only creates a draft) and then calls `messages.send`, which carries `approval: { required: true, type: "human-confirmation" }` — so Dana explicitly confirms the send. The audit trail now tells the whole story:

```text
capability.requested        exe_01  orders.refund   actor u_dana   aiSdk
capability.approval_requested exe_01 apr_9          reasons: [">$500"]
capability.approved                 apr_9           approver u_priya
capability.started          exe_02  orders.refund   approval apr_9
capability.completed        exe_02  durationMs 1804
capability.requested        exe_03  messages.draft  ...completed
capability.requested        exe_04  messages.send   ...approval_requested/approved/completed
```

## The failure branches you didn't see

Every act had exits: an unexposed capability or policy `hide` would have looked like `CAPABILITY_NOT_FOUND` (SI-8); a bad amount would have returned `INPUT_INVALID` with issue paths for the model to fix; Priya rejecting → `capability.rejected`, resume → `APPROVAL_REJECTED`; waiting past expiry → `APPROVAL_EXPIRED`; a second resume → `APPROVAL_CONSUMED`; a payment-gateway hang → the composite signal fires → `TIMEOUT` (retryable, but never auto-retried for a `write` — SI-11); Dana closing the tab mid-call → `CANCELLED`.

Each branch is a typed envelope, an audit event, and a span — not an exception swallowed in an adapter.

## Related

- Normative stages: [execution-pipeline.md](../architecture/execution-pipeline.md) · Full example app: [customer-support-agent.md](../examples/customer-support-agent.md)
