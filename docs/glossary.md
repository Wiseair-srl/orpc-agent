# Glossary

> **Status:** Implemented in v0.1. This vocabulary is enforced across all documentation and code. When two terms are listed as "not interchangeable", the distinction is load-bearing — using one for the other has caused real design bugs elsewhere.

## Core terms

**Capability** — A governed application operation derived from an oRPC procedure: the procedure plus identity, description, exposure, classification, and execution policy. The central abstraction ([concepts](concepts/capabilities.md)).

**Procedure** — The oRPC unit of implementation: schemas, middleware, handler. Capabilities are procedures with `agent` metadata; the procedure remains the source of truth (ADR-001).

**Registry** — The typed collection assigning capabilities their dot-path ids and supporting filtering and introspection ([concepts](concepts/registry.md)).

**Runtime** — The governed execution engine every surface funnels through: validation, policies, approvals, bounds, invocation, normalization, evidence ([concepts](concepts/runtime.md)).

**Adapter** — A package exposing capabilities to one protocol or runtime (AI SDK, MCP, OpenTelemetry, testing). Thin by contract ([architecture](architecture/adapter-model.md)).

**Surface** (execution surface, exposure surface) — The kind of client reaching the runtime: `direct`, `aiSdk`, `mcp`, `workflow`, `test`. Exposure is granted per surface.

**Exposure** — The static, per-surface reachability map (`meta.expose`). Deny by default (SI-1).

**Actor** — The authenticated entity requesting (or approving) an execution: user, service, automation, or explicit anonymous. **The model is never the actor** (SI-3).

**Execution context** — Request-scoped application data (your oRPC context) available to middleware, handlers, and policies ([concepts](concepts/context.md)).

**Policy** — A deterministic function evaluating an execution request to allow / deny / hide / require-approval ([concepts](concepts/policies.md)).

**Approval** — A trusted, input-bound, single-use decision required before execution; a lifecycle, not a boolean ([concepts](concepts/approvals.md)).

**Invocation** — The act of requesting a capability through the runtime (`runtime.invoke`), producing an execution.

**Execution** — One governed run through the pipeline, identified by `executionId`, finalized with exactly one result envelope.

**Execution request** — The evaluated bundle: capability + actor + context + surface + validated input (what policies see).

**Discovery** — Listing capabilities for a surface (`runtime.describe`); a courtesy to clients, never authorization (SI-2).

**Audit event** — A structured lifecycle record (`AgentAuditEvent`) emitted to sinks; storage-neutral (ADR-010).

**Trace** — Span-based timing/causality telemetry via the `TracingAdapter`; sampled, short-lived, for engineers.

**Capability error** — The normalized `CapabilityError`: code, stage, model-safe public face, private cause ([concepts](concepts/errors.md)).

## Not interchangeable

**Tool vs capability** — A *tool* is one adapter's protocol representation of a capability on one surface (an AI SDK tool, an MCP tool). The internal, governed object is the *capability*. Docs and core code never call the internal object a tool (ADR-002).

**User vs actor** — A *user* is one kind of actor. Services, automations, and explicit anonymous callers are actors too; writing "user" where "actor" is meant hides the machine-caller cases that governance most needs to cover.

**Authentication vs authorization** — Authentication establishes *who* (adapter/app layer, produces the Actor). Authorization decides *whether* (middleware, policies). "Authenticated" never implies "authorized".

**Permission vs approval** — A *permission* is a standing property of an actor ("may refund"). An *approval* is a per-operation decision by someone else ("may refund **this** $649, once, before 15:00"). Permissions are checked; approvals are granted, consumed, and expire.

**Retry vs replay** — A *retry* is the runtime re-attempting a failed execution (same `executionId`, bounded, side-effect-aware). A *replay* is a workflow engine re-running orchestration code for determinism. Conflating them produces double effects ([idempotency-and-retries](security/idempotency-and-retries.md#retry-vs-replay-vs-re-invocation-terminology-that-prevents-incidents)).

**Audit vs tracing** — Audit answers *who did what, when, as decided by whom* — complete, never sampled, long-lived. Tracing answers *where did time go* — sampled, short-lived. Separate channels by design ([auditing](guides/auditing.md#audit-vs-tracing-vs-logs-vs-metrics)).

**Context vs memory** — *Context* is request-scoped application data. *Memory* (conversation history, long-term stores) belongs to your agent loop and is outside this framework. "Put it in context" and "the model remembers" are different systems.

**Workflow vs agent loop** — A *workflow* is deterministic orchestration (engine-driven, replayable). An *agent loop* is model-driven step selection. Both are runtime *clients* here — neither lives inside this framework.

**Hide vs deny** — `deny` admits existence ("you can't"); `hide` conceals it ("no such thing", externally `CAPABILITY_NOT_FOUND`). Choose by whether existence itself is sensitive (SI-8).

**Runtime retry vs model re-invocation** — The runtime retrying inside one execution vs the model calling the tool again (a new execution, new decisions). Audit distinguishes them; language should too.

## Shorthands used in these docs

**SI-n** — Security invariant n ([security-model](security/security-model.md#security-invariants-si-1--si-12)). **ADR-nnn** — Architecture decision record ([decisions](architecture/decisions.md)). **Stage n** — Pipeline stage ([execution-pipeline](architecture/execution-pipeline.md)). **Tn** — Threat ([threat-model](security/threat-model.md)). **Mn** — Milestone increment ([milestones](implementation/milestones.md)).
