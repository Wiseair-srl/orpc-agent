# Adapter: OpenTelemetry

> **Status:** Stable — 1.0. Package: `@orpc-agent/opentelemetry`. Peer: `@opentelemetry/api`, `@orpc-agent/core`.

Implements core's neutral `TracingAdapter` interface with real OpenTelemetry spans. Core stays OTel-free ([ADR-003](../architecture/decisions.md#adr-003-core-is-provider-neutral)); this package is ~a page of mapping code plus conventions, which is exactly the point.

## Usage

```ts
import { createAgentRuntime, defineGovernance } from "@orpc-agent/core";
import { createOpenTelemetryTracing } from "@orpc-agent/opentelemetry";

const runtime = createAgentRuntime({
  governance: defineGovernance({ registry: capabilities, policies }),
  tracing: createOpenTelemetryTracing(),   // uses trace.getTracer("orpc-agent")
});
```

The application owns its OTel SDK setup (provider, exporter, sampler, propagators) — this package only creates spans through `@opentelemetry/api` and inherits whatever SDK is registered. No SDK registered → API no-ops → zero overhead, by OTel design.

### Options

| Option | Default | Notes |
|---|---|---|
| `tracer` | `trace.getTracer("orpc-agent")` | Bring your own tracer/instrumentation scope |
| `actorIdAttribute` | `false` | When `true`, adds `orpc_agent.actor_id` to spans. Off by default: trace backends often have wider read access than audit stores ([sensitive-data](../security/sensitive-data.md#traces)) |

## Span tree

For one governed invocation inside a chat turn:

```text
POST /api/chat                        (your HTTP instrumentation)
└── ai.generateText                   (AI SDK telemetry, if enabled)
    └── ai.toolCall orders_refund
        └── agent.capability_call     ← this package, via the runtime
            ├── agent.policy_evaluation
            ├── agent.approval_request        (when stage 8 engages)
            └── agent.procedure_execution     (one per attempt)
                └── pg.query / http.request   (your downstream instrumentation)
```

Parenting: spans attach to the **active OTel context** at `invoke` time, so the capability call lands under your HTTP/AI SDK spans automatically. `agent.run` / `agent.model_call` naming belongs to the loop layer (the AI SDK's own telemetry or your instrumentation); the runtime deliberately emits only capability-level spans ([reference/events.md](../reference/events.md#trace-spans)).

## Attributes

The safe set from [reference/events.md](../reference/events.md#recommended-attributes) (`orpc_agent.capability_id`, `.surface`, `.actor_kind`, `.side_effect`, `.risk`, `.execution_id`, `.attempt`, `.outcome`, `.error_code`, `.approval_id`). Structurally absent: raw inputs, raw outputs, actor attributes, error causes (SI-10). Adding payload attributes requires writing your own `TracingAdapter` wrapper — deliberate friction, the code diff is the review point.

Span status: `ok` for `completed` and `approval-required` (a suspension is not an error), `error` with the error code for `failed`/`cancelled`.

## Tracing vs audit (don't merge them)

| | Traces | Audit events |
|---|---|---|
| Question | Why was it slow / where did it fail? | Who did what, when, with what decision? |
| Consumer | Engineers, APM | Security, compliance, product |
| Retention | Days–weeks, sampled | Long, complete |
| Sampling | Yes — and that's fine | Never — completeness is the product |

Same `executionId` appears in both, so you can pivot from an audit record to its trace. Emitting audit events *as* span events would subject them to sampling and trace retention — that's why the two channels are separate ([ADR-010](../architecture/decisions.md#adr-010-audit-events-are-structured-and-storage-neutral), [guides/auditing.md](../guides/auditing.md)).

## Metrics

Not in v0.1. The audit stream is a sufficient source to derive counters (completions, denials, approval latency) in your pipeline; native OTel metrics are a Planned consideration.

## Related

- [Reference: events](../reference/events.md) · [Auditing guide](../guides/auditing.md) · [Sensitive data](../security/sensitive-data.md)
