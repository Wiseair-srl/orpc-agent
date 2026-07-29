# Roadmap

> **Status:** **1.0.0 published to npm** — semver applies strictly from here ([release process](docs/contributing/release-process.md)). The lines below record how it got here and what is next; scope commitments are firm.

## Now — after 1.0

- First workflow-engine adapter for the `workflow` surface ([Q7](docs/open-questions.md#q7) — Mastra currently leads the candidate list)
- MCP: dynamic `list_changed`; elicitation-based confirmation prototype behind a flag ([Q4](docs/open-questions.md#q4))
- Community schema-converter adoption for Valibot/ArkType ([Q3](docs/open-questions.md#q3))

## Shipped — 1.0 "Governance contract"

Runtime-level policies become part of the recorded contract ([ADR-016](docs/architecture/decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract)), and the API drops its remaining choices:

- `defineGovernance({ registry, policies })` — the governed surface as one declared value, and the only form `createAgentRuntime` accepts. A runtime built from it cannot evaluate a policy list no exported value names, and tooling can read it without a runtime instance
- CLI: snapshot v2 records runtime-level policies; removing one is **widening**. The header qualifies its own count (`0 approval-gated (declared)`), and `--entry` accepts a governance, a runtime, or a bare registry
- `orpc-agent init` — interactive setup; `inspect` renders an Ink view in a terminal while `check` stays plain text with no rendering framework in its path
- `@orpc-agent/core` becomes a peer dependency of the CLI: the requirement is one *module instance*, not one version — a duplicated copy makes an application's schema converter invisible and fabricates drift
- Removed: the `warnings` flag, and the `registry`/`policies` pair on `createAgentRuntime`. Each was a second way to say something a configuration choice already says

## Shipped — v0.3

- `@orpc-agent/cli` — capability inventory and CI drift gate (`orpc-agent inspect | snapshot | check`), with committed snapshots dogfooded on both examples ([ADR-015](docs/architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command)). Core: `defaultToolName` becomes public, collapsing three copies into one
- Reverses the 0.2 plan's "no CLI" exclusion deliberately; the surface name `cli` stays reserved for nothing — a future CLI *adapter* would take the surface `shell`

## Shipped — v0.2 "Durability seams"

Driven by the first production consumer (an ~85-capability finance app):

- `@orpc-agent/postgres` — reference `ApprovalCoordinator` + `AuditSink` over a driver-agnostic query seam; DDL as exported strings; the shared coordinator contract suite runs against in-memory, pglite, and a real server incl. a two-connection consumption race ([Q8](docs/open-questions.md#q8) resolved via [ADR-013](docs/architecture/decisions.md#adr-013-postgres-reference-persistence-package))
- Core: startup footgun warnings, schema-conversion cache invalidation + descriptor isolation ([ADR-014](docs/architecture/decisions.md#adr-014-as-built-api-deltas-for-v02))
- MCP: `session.authInfo` typed as the SDK's `AuthInfo`
- Guides: [headless invocations](docs/guides/headless-invocations.md), [workflow steps](docs/guides/workflow-steps.md), [MCP authentication](docs/guides/mcp-authentication.md) (Better Auth worked example), host-loop approval interop ([ai-sdk adapter](docs/adapters/ai-sdk.md))

## Shipped — v0.1 "Governed core"

The smallest coherent release proving the thesis: *define a capability once, expose it through multiple governed surfaces.*

- `@orpc-agent/core` — capability metadata + registry, 15-stage runtime, policies, in-memory approvals with input-hash binding, structured errors, audit events, tracing interface, timeout/cancellation, eligibility-gated retries, Zod v4 JSON-Schema conversion
- `@orpc-agent/ai-sdk` — AI SDK tools over the runtime (`ai@^5 || ^6`)
- `@orpc-agent/testing` — deterministic governance testing, no LLM required
- `@orpc-agent/opentelemetry` — tracing adapter
- `@orpc-agent/mcp` — MCP server adapter *(final increment; slips to 0.2 rather than delaying the release)*
- `examples/customer-support` — the reference application (one read flow, one approval-gated write flow, and the full governance suite)

Definition of done: the [acceptance criteria](docs/implementation/brief.md#acceptance-criteria). Increment plan: [milestones](docs/implementation/milestones.md).

## Later — exploratory (no commitment)

- Streaming (event-iterator) capabilities with per-chunk governance semantics ([Q11](docs/open-questions.md#q11))
- Framework-level rate limits/quotas ([Q9](docs/open-questions.md#q9))
- Declarative policy input constraints ([Q6](docs/open-questions.md#q6))
- `orpc-agent approvals` — a second CLI command family for pending-approval review, if demand appears ([ADR-015](docs/architecture/decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command) leaves this open; the decision path must go through the app's coordinator)
- Rules engine for the CLI: assertions over new capabilities that have no snapshot baseline to drift from
- Metrics emission; additional adapters (`shell`, A2A) — each begins as a design doc against the [adapter contract](docs/architecture/adapter-model.md). The surface is named `shell`, not `cli`: `@orpc-agent/cli` is the developer tool

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
