# Guide: long-running jobs as workflow steps

> **Status:** Recipe over the stable 1.0 API — the `workflow` surface is reserved for a future adapter but usable today from workflow glue code ([adapter model](../architecture/adapter-model.md#surface-identity)). Streaming governance remains out of scope until designed ([Q11](../open-questions.md#q11)); first-adapter choice remains open ([Q7](../open-questions.md#q7)).

A bank sync that runs for six minutes does not fit one governed invocation — nor should it: one opaque six-minute call gives governance nothing to see. The blessed interim (and arguably the better end state) is to **slice the job into per-batch capabilities and let a workflow engine drive them as steps**, each step a normal governed invoke.

## The shape

The engine owns scheduling, persistence, and retry-of-steps; each step's body calls `runtime.invoke` with `surface: "workflow"` and the run's id as `correlationId` ([ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based) — core never becomes the engine). Shown with [Mastra](https://mastra.ai) workflows; the pattern is engine-agnostic on purpose:

```ts
// One governed step. unwrap() throws on failed envelopes so the engine's
// step-retry semantics see an ordinary exception.
const importPage = createStep({
  id: "import-page",
  execute: async ({ inputData, runId }) => {
    const result = await runtime.invoke(
      "transactions.importPage",
      { cursor: inputData.cursor, batchSize: 200 },
      { actor: SYNC_ACTOR, context: await createJobContext(SYNC_ACTOR), surface: "workflow", correlationId: runId },
    );
    return unwrap(result);   // { imported, nextCursor }
  },
});

// The engine loops steps until nextCursor is null; each iteration is a
// separately governed, separately audited execution.
```

The capabilities need `expose: { workflow: true, ... }` — a deliberate, review-visible decision distinct from `direct` because this caller **replays** ([capability-exposure](capability-exposure.md)).

## What slicing buys

- **Bounded executions.** Each step lives inside `meta.timeoutMs` (per-attempt, SI-12); a two-hour job needs no two-hour timeout anywhere.
- **Progress for free.** One logical job = N audit events stitched by `correlationId` — that is the intended model, not a compromise: `capability.completed` per page IS the progress feed, queryable from the same audit table that serves compliance.
- **Small blast radius.** A failure kills one batch, not the job; the engine resumes from the last completed step.

```sql
-- "How far did last night's sync get?"
select count(*) filter (where type = 'capability.completed') as pages
from agent_audit_events where correlation_id = 'run_2026_07_27';
```

## Replays and idempotency

Engines re-run steps — after crashes, on retry policies, during recovery. Every step-exposed capability should either declare `idempotent: true` honestly (imports keyed on external ids, upserts) or tolerate re-execution at the application level. The runtime treats each engine-driven call as a fresh execution (it is one — distinct `executionId`, same `correlationId`); SI-11's write-retry rules govern only the runtime's *own* retries within a step.

## Approval gates inside a workflow

A gated step comes back as `approval-required` instead of a result. Map it to the engine's suspension primitive:

```ts
execute: async ({ inputData, runId, suspend }) => {
  const result = await runtime.invoke("payments.execute", inputData.payment, {
    actor: SYNC_ACTOR, context: await createJobContext(SYNC_ACTOR),
    surface: "workflow", correlationId: runId,
  });
  if (result.status === "approval-required") {
    // Engine sleeps; your approvals dashboard decides; the resume worker
    // calls runtime.resume(approvalId) and then wakes the workflow with the
    // outcome. Approval binding (SI-5) and expiry apply unchanged.
    return suspend({ approvalId: result.approval.id });
  }
  return unwrap(result);
},
```

Deciding and executing stay exactly the [human-approval](human-approval.md) flow — the engine only adds "and then wake the workflow". Mind `defaults.approvalExpiresInMs`: overnight jobs need gates measured in hours.

For fully unattended runs, prefer policies that don't gate trusted workflow actors at all ([headless-invocations](headless-invocations.md#exposure-and-policy-for-unattended-callers)) — an approval no one will answer is just a slow failure.

## What this recipe is not

- **Not streaming.** Each step returns a complete value; per-chunk governance is a future design ([Q11](../open-questions.md#q11)). Event-iterator procedures still cannot be capabilities.
- **Not the workflow adapter.** A packaged adapter (engine choice: [Q7](../open-questions.md#q7)) would formalize this glue; the recipe is deliberately thin so that adapter can absorb it without breaking anyone.

## Related

- [Guide: headless invocations](headless-invocations.md) · [Concepts: approvals](../concepts/approvals.md) · [ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based)
