# Roadmap

> **Status:** v0.1 implemented and **published to npm** at 0.1.0 ([Q1 resolved](docs/open-questions.md#q1)); the v0.2 "Durability seams" core is **implemented** (release flows through the changesets pipeline). Scope commitments below are firm.

## Now — v0.2 "Durability seams" (implemented)

Driven by the first production consumer (an ~85-capability finance app):

- `@orpc-agent/postgres` — reference `ApprovalCoordinator` + `AuditSink` over a driver-agnostic query seam; DDL as exported strings; the shared coordinator contract suite runs against in-memory, pglite, and a real server incl. a two-connection consumption race ([Q8](docs/open-questions.md#q8) resolved via [ADR-013](docs/architecture/decisions.md#adr-013-postgres-reference-persistence-package))
- Core: startup footgun warnings (`warnings: false` to silence), schema-conversion cache invalidation + descriptor isolation ([ADR-014](docs/architecture/decisions.md#adr-014-as-built-api-deltas-for-v02))
- MCP: `session.authInfo` typed as the SDK's `AuthInfo`
- Guides: [headless invocations](docs/guides/headless-invocations.md), [workflow steps](docs/guides/workflow-steps.md), [MCP authentication](docs/guides/mcp-authentication.md) (Better Auth worked example), host-loop approval interop ([ai-sdk adapter](docs/adapters/ai-sdk.md))

Still on the 0.2 line, order by demand:

- First workflow-engine adapter for the `workflow` surface ([Q7](docs/open-questions.md#q7) — Mastra currently leads the candidate list)
- MCP: dynamic `list_changed`; elicitation-based confirmation prototype behind a flag ([Q4](docs/open-questions.md#q4))
- Community schema-converter adoption for Valibot/ArkType ([Q3](docs/open-questions.md#q3))
- API stabilization pass: experimental → stable for core definition APIs

## Shipped — v0.1 "Governed core" (published)

The smallest coherent release proving the thesis: *define a capability once, expose it through multiple governed surfaces.*

- `@orpc-agent/core` — capability metadata + registry, 15-stage runtime, policies, in-memory approvals with input-hash binding, structured errors, audit events, tracing interface, timeout/cancellation, eligibility-gated retries, Zod v4 JSON-Schema conversion
- `@orpc-agent/ai-sdk` — AI SDK v5 tools over the runtime
- `@orpc-agent/testing` — deterministic governance testing, no LLM required
- `@orpc-agent/opentelemetry` — tracing adapter
- `@orpc-agent/mcp` — MCP server adapter *(final increment; slips to 0.2 rather than delaying the release)*
- `examples/customer-support` — the reference application (one read flow, one approval-gated write flow, and the full governance suite)

Definition of done: the [acceptance criteria](docs/implementation/brief.md#acceptance-criteria). Increment plan: [milestones](docs/implementation/milestones.md).

## Later — exploratory (no commitment)

- Streaming (event-iterator) capabilities with per-chunk governance semantics ([Q11](docs/open-questions.md#q11))
- Framework-level rate limits/quotas ([Q9](docs/open-questions.md#q9))
- Declarative policy input constraints ([Q6](docs/open-questions.md#q6))
- Capability inventory/report tooling (CI surface-diff action)
- Metrics emission; additional adapters (CLI, A2A) — each begins as a design doc against the [adapter contract](docs/architecture/adapter-model.md)

## Non-goals (permanent)

These are boundaries, not backlog ([overview](docs/architecture/overview.md#what-orpc-agent-is-not)):

- Agent loops, planners, prompt management, memory stores
- A workflow engine, scheduler, or job queue of our own
- Bundled databases for approvals or audit
- Authentication/authorization providers
- UI frameworks or hosted dashboards
- Exactly-once execution claims
- Support for non-oRPC procedure systems in core

## How this roadmap changes

Scope moves between tiers only via ADR (for architectural shifts) or maintainer consensus recorded in [GOVERNANCE.md](GOVERNANCE.md). Open questions graduate here when resolved; nothing ships to "Now" while its blocking question is open.
