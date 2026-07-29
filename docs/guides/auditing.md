# Guide: auditing

> **Status:** Implemented in v0.1. Event catalog: [reference/events.md](../reference/events.md). Design rationale: [ADR-010](../architecture/decisions.md#adr-010-audit-events-are-structured-and-storage-neutral).

The runtime emits a complete, structured record of every governed interaction — including the denied ones. Persistence is yours: **no sink configured means no audit trail stored**, and that should feel as wrong as running without backups.

## Audit vs tracing vs logs vs metrics

Four telemetry channels, four jobs — don't collapse them:

| Channel | Question | Completeness | Retention |
|---|---|---|---|
| **Audit events** | Who did what, when, and what was decided? | Every event, never sampled | Long (compliance-driven) |
| **Traces** | Where did time go; where did it break? | Sampled is fine | Short |
| **Logs** | What did the code say while running? | Unstructured, best-effort | Medium |
| **Metrics** | How much / how fast, in aggregate? | Pre-aggregated | Long, lossy |

Audit events share `executionId` with traces — pivot from a record to its trace when investigating. Deriving metrics *from* the audit stream is good practice; deriving audit *from* sampled traces is a compliance hole.

## Minimal wiring

On Postgres, the reference sink is one line ([adapters/postgres.md](../adapters/postgres.md)):

```ts
import { createPgAuditSink, AUDIT_DDL } from "@orpc-agent/postgres";

const runtime = createAgentRuntime({
  governance,
  audit: { sinks: [createPgAuditSink({ query: (sql, params) => pool.query(sql, params) })] },
});
```

On any other store, a sink is just a function:

```ts
audit: async (event) => {
  await db.agentAuditEvents.insert({
    type: event.type,
    at: event.timestamp,
    executionId: event.executionId,
    capabilityId: event.capabilityId,
    surface: event.surface,
    actorId: event.actor.id,
    actorKind: event.actor.kind,
    correlationId: event.correlationId,
    inputHash: event.inputHash,
    data: event.data,          // jsonb; payload-free by contract (SI-10)
  });
},
```

An append-only table with indexes on `(capabilityId, at)`, `(actorId, at)`, `(executionId)` answers most questions you'll ever ask it — the reference sink's `AUDIT_DDL` is exactly that table.

Multiple sinks compose (`audit: [dbSink, siemSink]`) — each isolated: one sink failing never blocks another, and in default mode never blocks execution (`onSinkError` receives failures).

## Choosing strict mode

```ts
audit: { sinks: [dbSink], strict: true }
```

| Mode | Semantics | Use when |
|---|---|---|
| default (best-effort) | Events emitted async; sink failure → `onSinkError`, execution proceeds | Availability wins; audit is operational |
| `strict` | `capability.started` is awaited **before** the procedure runs; sink failure aborts with `AUDIT_UNAVAILABLE` | "No record ⇒ no execution" is a compliance requirement (T12) |

Strict mode gates only the *started* write (the one that proves an execution was attempted); terminal events remain async — a crashed process can lose a `completed` event but never an execution without its `started`.

## What to alert on

The stream is designed for anomaly queries; start with these:

```sql
-- Probing: denials by reason over time (reason "unknown"/"not-exposed"/"hidden" = someone fishing)
SELECT data->>'reason', count(*) FROM agent_audit_events
WHERE type = 'capability.denied' AND at > now() - interval '1 hour' GROUP BY 1;

-- Approval pressure: requests vs approvals per capability (flood = injection or UX failure)
SELECT capability_id, count(*) FILTER (WHERE type = 'capability.approval_requested') AS asked,
       count(*) FILTER (WHERE type = 'capability.approved') AS granted
FROM agent_audit_events WHERE at > now() - interval '1 day' GROUP BY 1;

-- Behavior shift: destructive/external capability calls per actor vs their baseline
-- Repetition: same actor + capability + inputHash > N times per hour (loop or replay)
```

`policyDecisions` on denied/failed events tells you *which* policy fired — alert on `POLICY_FAILED` specifically: it means a policy is broken and failing closed (SI-7), which is safe but urgent.

## Reading a story from the trail

One approval-gated refund, as stored ([full walkthrough](../concepts/lifecycle.md)):

```text
capability.requested          exe_01  orders.refund  u_dana  aiSdk
capability.approval_requested exe_01  apr_9  reasons=[">$500"]
capability.approved                   apr_9  approver=u_priya
capability.started            exe_02  orders.refund  approval=apr_9
capability.completed          exe_02  durationMs=1804 attempts=1
```

Two executions (suspension then resumption), linked by the approval id; requester and approver distinct (SI-4 visible in data); no payloads, one `inputHash` — verifiable, not readable (SI-10).

## Payload-carrying audit (the deliberate exception)

Some domains must store inputs/outputs. Do it consciously in your sink, not by asking the framework to:

```ts
audit: async (event) => {
  const base = rowFrom(event);
  if (event.type === "capability.started" && HIGH_STAKES.has(event.capabilityId!)) {
    base.inputSnapshot = await vault.store(event.executionId!, currentInputFor(event));  // your custody chain
  }
  await db.agentAuditEvents.insert(base);
}
```

You now own encryption, retention, access control, and right-to-erasure for those snapshots — which is precisely why it isn't a framework flag ([sensitive-data.md](../security/sensitive-data.md#audit-events)).

## Checklist

- [ ] At least one durable sink in every non-dev environment
- [ ] `strict` mode where compliance demands audit-before-effect
- [ ] Alerts: denial spikes, `POLICY_FAILED`, approval floods, repetition
- [ ] Retention policy matching your compliance regime
- [ ] Audit store's own access control (it contains behavior data about your users)
