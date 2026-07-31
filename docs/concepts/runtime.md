# Agent runtime

> **Status:** Stable — 1.0.

The **runtime** is the governed execution engine. Every capability invocation — from the AI SDK adapter, an MCP client, a workflow step, a test, or your own server code — funnels through it. There is exactly one execution path, so there is exactly one place where governance is enforced.

```ts
const governance = defineGovernance({
  registry: capabilities,
  policies: [orgIsolation, refundLimit],
});

const runtime = createAgentRuntime({
  governance,                                 // the governed surface, as one declared value
  approvals: { coordinator: approvalStore },  // the per-instance wiring
  audit: auditSink,
  tracing: createOpenTelemetryTracing(),
});
```

## What the runtime does

For each invocation (normative detail: [execution pipeline](../architecture/execution-pipeline.md)):

1. **Resolves and gates** — id lookup, surface exposure (deny by default).
2. **Validates** — input against the procedure's schema; later, output against its schema.
3. **Evaluates policies** — deterministic decisions: allow, deny, hide, require-approval.
4. **Coordinates approvals** — suspends, binds input by hash, resumes with integrity checks.
5. **Bounds execution** — timeout + caller cancellation as one composed `AbortSignal`.
6. **Invokes the procedure** — through oRPC's call path, so your middleware runs unchanged.
7. **Retries** — only within explicit, side-effect-aware eligibility rules.
8. **Normalizes errors** — everything becomes a `CapabilityError` with a model-safe face.
9. **Emits evidence** — audit events and trace spans for every stage that matters.

## What the runtime refuses to do

- **Authenticate.** Adapters and your app own identity; the runtime verifies an `Actor` is present and well-formed, nothing more.
- **Authorize application-level questions.** "May Dana refund order 42?" is your middleware's question; the runtime guarantees middleware runs, and adds agent-specific gates *around* it ([ADR-008](../architecture/decisions.md#adr-008-existing-orpc-middleware-remains-authoritative)).
- **Persist.** Approval storage and audit storage are interfaces; core ships only an in-memory coordinator for dev/test ([ADR-010](../architecture/decisions.md#adr-010-audit-events-are-structured-and-storage-neutral)).
- **Call models.** The runtime has no idea LLMs exist ([ADR-003](../architecture/decisions.md#adr-003-core-is-provider-neutral)).

## The result envelope

`invoke` never throws for governed outcomes; it returns one of four statuses:

```ts
const result = await runtime.invoke("orders.refund", input, { actor, context });

switch (result.status) {
  case "completed":         result.output;   // redacted output
  case "approval-required": result.approval; // suspended; surface to an approver
  case "failed":            result.error;    // CapabilityError (denials, validation, handler errors)
  case "cancelled":         result.error;    // TIMEOUT or CANCELLED
}
```

Why an envelope instead of exceptions: `approval-required` is a *normal* outcome, not an error; adapters need a deterministic, exhaustive set of cases to translate; and control flow by exception across an adapter boundary loses type information. Direct callers who prefer throwing use `unwrap(result)`.

## Discovery

```ts
const descriptors = await runtime.describe("aiSdk", { actor, context });
```

Discovery returns minimal, policy-filtered descriptors (id, description, input JSON Schema, classifications, `requiresApproval` hint). It is a courtesy to clients, never a security boundary — the pipeline re-checks everything on invoke (SI-2).

## One runtime or several?

A runtime binds a registry to one governance configuration. Common shapes:

- **One runtime for the app** — typical; per-request data flows through `actor`/`context`, not runtime construction.
- **Surface-specific runtimes** — an MCP deployment with a narrowed registry and stricter policies alongside a fuller internal runtime.
- **Test runtimes** — `@orpc-agent/testing` builds deterministic ones with fakes ([adapters/testing.md](../adapters/testing.md)).

Runtimes are stateless per invocation and safe for concurrent use; state lives in the coordinator and your sinks.

## Related

- Normative: [execution-pipeline.md](../architecture/execution-pipeline.md) · API: [reference/runtime.md](../reference/runtime.md)
- [Policies](policies.md) · [Approvals](approvals.md) · [Errors](errors.md) · [Lifecycle walkthrough](lifecycle.md)
