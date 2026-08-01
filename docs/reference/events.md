# Reference: events and tracing

> Event names are stable and are never repurposed. Fields may be **added** in a minor; removing one, or changing what it means, is a breaking change that ships only in a major — it has happened once, to `capabilities.discovered` ([migration](../migration/1-to-2.md)).

Package: `@orpc-agent/core` (emission, types); `@orpc-agent/opentelemetry` (span implementation). Distinctions between audit, tracing, logs, and metrics: [guides/auditing.md](../guides/auditing.md#audit-vs-tracing-vs-logs-vs-metrics).

## Audit events

```ts
type AuditSink = (event: AgentAuditEvent) => void | Promise<void>;
```

Every event shares the envelope:

```ts
type AuditEnvelope = {
  type: AgentAuditEventType;
  timestamp: Date;
  surface: ExposureSurface;
  actor: { id: string; kind: Actor["kind"] };   // attributes stripped by default
  executionId?: string;                          // absent on capabilities.discovered
  capabilityId?: string;
  correlationId?: string;
  inputHash?: string;                            // present from stage 5 onward
};
```

**Raw inputs and outputs are never included** (SI-10). Payload-bearing observability is an explicit application choice via `redact` hooks and custom sinks.

### Event catalog

| `type` | Emitted | Event-specific `data` |
|---|---|---|
| `capabilities.discovered` | Per `describe()` call | `count: number`, `surface`, `digest: string`, `capabilityIds?: string[]` (verbose only) |
| `capability.requested` | Pipeline stage 2 | `sideEffect?`, `risk?` (absent if unresolved) |
| `capability.denied` | Stages 3, 4, 7 | `reason: "unknown" \| "not-exposed" \| "hidden" \| "policy-denied" \| "policy-failed"`, `publicCode`, `policyDecisions?` |
| `capability.approval_requested` | Stage 8 | `approvalId`, `reasons`, `types`, `expiresAt` |
| `capability.approved` | Coordinator `decide` | `approvalId`, `approver: {id, kind}`, `comment?` |
| `capability.rejected` | Coordinator `decide` | `approvalId`, `approver: {id, kind}`, `comment?` |
| `capability.started` | Stage 10 | `attempt: 1`, `approvalId?` |
| `capability.retried` | Stage 11 re-attempt | `attempt`, `previousErrorCode` |
| `capability.completed` | Stage 14 | `durationMs`, `attempts` |
| `capability.failed` | Terminal failure | `code`, `stage`, `retryable`, `attempts`, `executedBeforeFailure?: boolean`, `policyDecisions?` |
| `capability.cancelled` | Terminal abort | `code: "TIMEOUT" \| "CANCELLED"`, `durationMs` |

`capabilities.discovered` is **constant-size by default** ([ADR-017](../architecture/decisions.md#adr-017-discovery-takes-a-scope-and-a-budget)). It answers *did this actor's visible catalog change, and when* with a `digest` of the sorted id list: equal digests ⇒ equal catalogs. The digest **algorithm is not part of the contract** — compare digests across events, never parse one, reconstruct ids from one, or store one as a durable identifier. `count` and `surface` are the other two fields; `surface` is also on the envelope, and is repeated here so a forwarded `data` payload stands alone.

The full id list is available at the verbose audit level:

```ts
audit: { sinks: [sink], verbose: true }   // adds data.capabilityIds
```

Off by default because this event fires on every `describe`: a host that re-composes per step emits it per step, per turn, per concurrent user, and an unbounded array in a routine event is forwarded, stored, and re-sent every time. If you forward audit events to a client, note that the id list is one actor's authorized surface — filter per actor before it leaves your server.

`policyDecisions` records every evaluated policy's stance — `{ policy: string; type: PolicyDecision["type"] | "error" }[]` — because stage 7 evaluates all policies precisely so this record is complete. `"error"` marks a policy that threw or timed out (recorded honestly; the combined outcome is `POLICY_FAILED`, fail closed).

`capability.denied` deliberately contains the **true** reason even when the external error was the concealed `CAPABILITY_NOT_FOUND` (SI-8 conceals from clients, never from your audit trail).

### Delivery semantics

- Default: best-effort. Sink return values are awaited off the critical path; a throwing sink invokes `onSinkError` and never fails the execution.
- `strict: true`: the `capability.started` write is awaited **before** stage 11 executes; failure aborts with `AUDIT_UNAVAILABLE`. Use where "no record ⇒ no execution" is required.
- Ordering: events for one `executionId` are emitted in pipeline order; cross-execution ordering is not guaranteed.
- Delivery is at-most-once per sink; sinks needing durability implement their own buffering.

## Trace spans

Span names emitted by the runtime (via the neutral `TracingAdapter`):

| Span | Wraps |
|---|---|
| `agent.capability_call` | Entire invocation (stages 2–15); root unless the adapter provides a parent |
| `agent.policy_evaluation` | Stage 7 / stage 9 evaluation batch |
| `agent.approval_request` | Stage 8 creation (and inline-handler wait) |
| `agent.procedure_execution` | Stage 11, one per attempt |

`agent.run` and `agent.model_call` are **conventions for the application's agent loop** (the AI SDK's own telemetry typically provides them); the runtime does not emit them, but the OpenTelemetry adapter documents how to parent `agent.capability_call` under them ([adapters/opentelemetry.md](../adapters/opentelemetry.md)).

### Recommended attributes

```text
orpc_agent.capability_id     "orders.refund"
orpc_agent.surface           "aiSdk"
orpc_agent.actor_kind        "user"          (actor id only if your backend policy allows)
orpc_agent.side_effect       "write"
orpc_agent.risk              "high"
orpc_agent.execution_id      "exe_..."
orpc_agent.attempt           2
orpc_agent.outcome           "completed" | "approval-required" | "failed" | "cancelled"
orpc_agent.error_code        "POLICY_DENIED" (on failure)
orpc_agent.approval_id       (when applicable)
```

Raw inputs/outputs are excluded by default (SI-10); nothing in core writes them to spans.
