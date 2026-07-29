# Architecture overview

> **Status:** Stable — 1.0. describes the architecture as built. Packages are published to npm at 1.0.0.

This document is the normative starting point for understanding oRPC Agent. It defines the system's thesis, its layers, and the boundaries between them. Every other document assumes the model described here.

## Thesis

An AI agent must not call business logic directly. It requests a **capability**: a governed application operation derived from an ordinary oRPC procedure.

oRPC applications already have typed procedures with input/output schemas, context, middleware, and error contracts. oRPC Agent does not replace any of that. It adds the layer that was missing between agent runtimes and those procedures: explicit exposure, execution policies, approvals, audit, and tracing — applied uniformly no matter which surface invokes the procedure.

> Define a capability once. Expose it through multiple governed surfaces.

The same `orders.refund` procedure can serve the application UI, an AI SDK tool loop, an MCP client, a workflow step, and a deterministic test — with one implementation, one schema pair, one authorization story, and one audit trail.

## System layers

```text
        Model provider / agent runtime
        (OpenAI, Anthropic, local, ...)
                      |
                      v
              Protocol adapter
      @orpc-agent/ai-sdk   @orpc-agent/mcp
        (future: workflow, A2A, CLI)
                      |
                      v
             oRPC Agent runtime
              @orpc-agent/core
   exposure -> validation -> policies -> approvals
     -> timeout/cancellation -> audit -> tracing
                      |
                      v
              oRPC capabilities
     ordinary oRPC procedures + agent metadata
       (middleware and app authorization run
        here, unchanged and authoritative)
                      |
                      v
      Application services and infrastructure
        (database, queues, email, billing, ...)
```

Responsibilities per layer:

| Layer | Owns | Explicitly does not own |
|---|---|---|
| Adapter | Protocol translation, transport authentication, actor/context construction, model-safe serialization | Authorization decisions, business logic, validation authority |
| Runtime | Exposure checks, input/output validation, policy evaluation, approval lifecycle, timeout/cancellation, retries, error normalization, audit and trace emission | Storing data, calling model providers, replacing app authorization |
| Capability (procedure) | Business logic, oRPC middleware, application authorization, typed errors | Knowing which protocol invoked it |
| Application | Persistence, external services, identity provider | — |

## The five core objects

1. **Capability** — an oRPC procedure enriched with `AgentMeta` (description, exposure, side-effect and risk classification, execution policy metadata). See [concepts/capabilities.md](../concepts/capabilities.md).
2. **Capability registry** — a typed collection assigning each capability a stable hierarchical ID (`orders.refund`) and supporting filtering, introspection, and adapter conversion. See [concepts/registry.md](../concepts/registry.md).
3. **Agent runtime** — the governed execution engine. Every invocation from every surface funnels through `runtime.invoke`, which runs the [canonical execution pipeline](execution-pipeline.md). See [concepts/runtime.md](../concepts/runtime.md).
4. **Policy** — a deterministic function evaluating an execution request into `allow`, `deny`, `hide`, or `require-approval`. See [concepts/policies.md](../concepts/policies.md).
5. **Approval** — a lifecycle object binding a trusted decision to one capability, one actor, and one exact validated input. See [concepts/approvals.md](../concepts/approvals.md).

## The security spine

Three questions are answered independently, possibly with different results ([ADR-005](decisions.md#adr-005-discovery-and-execution-authorization-are-separate)):

1. **Discovery** — may this client know the capability exists? (`runtime.describe`, filtered by exposure + discovery-phase policies)
2. **Invocation** — may this actor request it? (exposure check + invocation-phase policies)
3. **Execution** — may this exact validated input execute in the current context? (execution-phase policies + oRPC middleware + application authorization + approval)

Hiding a tool from a model is never authorization (SI-2). Authorization is enforced again when the procedure executes, inside the application's own middleware, which remains authoritative ([ADR-008](decisions.md#adr-008-existing-orpc-middleware-remains-authoritative)).

The full set of security invariants (SI-1 … SI-12) is defined in [security/security-model.md](../security/security-model.md) and is binding for the implementation.

## What flows where

```text
 describe(surface)                       invoke(id, input, { actor, context })
        |                                        |
        v                                        v
+------------------+                 +--------------------------+
| exposure filter  |                 | resolve id + exposure    |
| discovery-phase  |                 | validate input           |
| policies (hide)  |                 | invocation policies      |
+------------------+                 | approval gate            |
        |                            | execution policies       |
        v                            | timeout + signal         |
 CapabilityDescriptor[]              | oRPC call (middleware +  |
 (id, description,                   |   handler)               |
  input JSON Schema,                 | output validation        |
  sideEffect, risk,                  | redaction                |
  requiresApproval)                  +--------------------------+
                                                 |
                                                 v
                                        ExecutionResult
                          completed | approval-required | failed | cancelled
```

Models see the minimum: descriptors omit output schemas by default, errors expose only `publicMessage` for errors marked model-safe, and outputs pass through the capability's redaction function before serialization.

## Package map

Five packages, one dependency direction (details in [package-boundaries.md](package-boundaries.md)):

```text
@orpc-agent/core          <- no model provider, no protocol SDK
   ^        ^        ^
   |        |        |
@orpc-agent/ai-sdk   @orpc-agent/mcp   @orpc-agent/opentelemetry
   ^
   |
@orpc-agent/testing  (depends only on core)
```

Core is provider-neutral ([ADR-003](decisions.md#adr-003-core-is-provider-neutral)). Adapters are peers of each other; none is required by another ([adapter-model.md](adapter-model.md)).

## What oRPC Agent is not

- Not an agent loop or orchestration framework — bring Vercel AI SDK, OpenAI Agents SDK, LangGraph, Mastra, or your own loop.
- Not a workflow engine — durable execution integrates via adapters ([ADR-007](decisions.md#adr-007-durable-execution-is-adapter-based)).
- Not an auth system, database, vector store, or UI framework.
- Not a replacement for oRPC — it consumes oRPC procedures and would be pointless without them.

## Reading order for implementers

1. This overview.
2. [execution-pipeline.md](execution-pipeline.md) — the normative runtime lifecycle.
3. [package-boundaries.md](package-boundaries.md) and [adapter-model.md](adapter-model.md).
4. [decisions.md](decisions.md) — the ADRs.
5. The [reference](../reference/core.md) section — proposed API contracts.
6. [security/security-model.md](../security/security-model.md) — binding invariants.
7. [implementation/brief.md](../implementation/brief.md) — the build order.
