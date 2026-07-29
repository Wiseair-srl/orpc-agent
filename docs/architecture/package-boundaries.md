# Package boundaries

> **Status:** Stable — 1.0. the package layout as built. Published to npm at 1.0.0 under the `@orpc-agent` scope ([ADR-011](decisions.md#adr-011-npm-scope-and-project-independence)).

## Monorepo layout

```text
orpc-agent/
├── packages/
│   ├── core/            -> @orpc-agent/core
│   ├── ai-sdk/          -> @orpc-agent/ai-sdk
│   ├── mcp/             -> @orpc-agent/mcp
│   ├── opentelemetry/   -> @orpc-agent/opentelemetry
│   └── testing/         -> @orpc-agent/testing
├── examples/
│   └── customer-support/
└── docs/
```

pnpm workspaces; TypeScript strict; ESM-first with CJS compatibility left to the build tool. There is **no** separate schema package: Standard Schema support lives in core under the `@orpc-agent/core/schema` subpath ([ADR-009](decisions.md#adr-009-standard-schema-interoperability-lives-in-core)).

## Dependency direction

```text
            @orpc/server (peer)      @standard-schema/spec (types)
                    \                 /
                     v               v
                   @orpc-agent/core
                  ^      ^      ^      ^
                  |      |      |      |
        ai-sdk ---+      |      |      +--- testing
        (peer: ai@^5)    |      |           (no protocol deps)
                         |      |
        mcp -------------+      +--- opentelemetry
        (peer: @modelcontextprotocol/sdk)   (peer: @opentelemetry/api)
```

Rules (binding):

- Core depends on **no** model provider, no `ai`, no MCP SDK, no OpenTelemetry.
- Adapters depend on core plus exactly their protocol SDK, always as a **peer dependency** so the application controls the version.
- No adapter depends on another adapter. The MCP package is never required by the AI SDK package and vice versa.
- Testing depends only on core; it must run without any LLM, network, or protocol SDK.
- Examples may depend on everything.

## @orpc-agent/core

**Purpose.** The neutral capability model and governed runtime: metadata typing, registry, execution pipeline, policies, approvals, errors, audit events, tracing interface, schema utilities.

**Public exports.**

```text
agentProcedure, createCapabilityRegistry, createAgentRuntime,
definePolicy, composePolicies, allow, deny, hide, requireApproval,
unwrap, createInMemoryApprovalCoordinator, CapabilityError
types: AgentMeta, AgentCapability, CapabilityRegistry, AgentRuntime,
  Actor, AgentInvocationInfo, ExecutionRequest, ExecutionResult,
  ExecutionOptions, CapabilityDescriptor, AgentPolicy, PolicyDecision,
  PolicyPhase, PolicyRequest, ApprovalRequest, ApprovalRecord,
  ApprovalDecision, ApprovalCoordinator, AgentAuditEvent, AuditSink,
  TracingAdapter, SpanHandle, ExposureSurface, SideEffect, RiskLevel,
  FailureStage, ErrorCode
subpath @orpc-agent/core/schema: toJsonSchema, registerSchemaConverter
```

**Dependencies.** Peer: `@orpc/server`. Type-only: `@standard-schema/spec`. Runtime deps: none beyond the platform (Web Crypto for hashing, `AbortSignal`).

**Non-responsibilities.** No persistence (the in-memory approval coordinator is for development and tests), no HTTP server, no model calls, no OpenTelemetry objects (only the neutral `TracingAdapter` interface), no scheduling.

**Maturity.** Stable at 1.0.

## @orpc-agent/ai-sdk

**Purpose.** Convert a runtime's exposed capabilities into Vercel AI SDK v5 tools: per-request tool sets bound to an actor and context, structured tool results, model-safe error envelopes, approval-required signaling.

**Public exports.** `toAISDKTools(runtime, options)`; types `AISDKToolsOptions`, `AISDKToolResult`.

**Dependencies.** `@orpc-agent/core`; peer `ai@^5`.

**Non-responsibilities.** No agent loop, no prompt management, no model selection, no streaming UI helpers. It produces tools; the application runs `generateText`/`streamText`.

**Relationship.** Pure consumer of `runtime.describe("aiSdk", …)` and `runtime.invoke(…, { surface: "aiSdk" })` per the [adapter model](adapter-model.md).

**Maturity.** Stable at 1.0.

## @orpc-agent/mcp

**Purpose.** Expose a runtime as an MCP server: `tools/list` from discovery, `tools/call` through the runtime, per-session actor/context construction from transport authentication.

**Public exports.** `createMCPServer(runtime, options)` returning `{ server, connect(transport) }`; type `MCPServerOptions`.

**Dependencies.** `@orpc-agent/core`; peer `@modelcontextprotocol/sdk`.

**Non-responsibilities.** No OAuth server (the app authenticates and hands the adapter a verified identity), no resource/prompt MCP features in v0.1, no dynamic `list_changed` in v0.1 (Planned).

**Maturity.** Stable at 1.0.

## @orpc-agent/opentelemetry

**Purpose.** Implement core's `TracingAdapter` on `@opentelemetry/api`: real spans for `agent.capability_call`, `agent.policy_evaluation`, `agent.approval_request`, `agent.procedure_execution`, with the attribute conventions in [reference/events.md](../reference/events.md).

**Public exports.** `createOpenTelemetryTracing(options?)`.

**Dependencies.** `@orpc-agent/core`; peer `@opentelemetry/api`.

**Non-responsibilities.** No exporter/SDK setup (the app owns its OTel SDK), no metrics in v0.1, no log correlation.

**Maturity.** Stable at 1.0.

## @orpc-agent/postgres

**Purpose.** Postgres reference implementations of the durability seams: `ApprovalCoordinator` (compare-and-set consumption, lazy clock-injected expiry) and `AuditSink` (strict-mode-safe, optional terminal-event batching). Bounds: [ADR-013](decisions.md#adr-013-postgres-reference-persistence-package).

**Public exports.** `createPgApprovalCoordinator(options)`, `createPgAuditSink(options)`, `APPROVALS_DDL`, `AUDIT_DDL`; types `PgQuery`, `PgApprovalCoordinatorOptions`, `PgAuditSinkOptions`, `PgAuditSink`.

**Dependencies.** `@orpc-agent/core` only — **no database driver**; the `PgQuery` function is the seam, and the boundary check bans `pg`/pglite imports from `src/`.

**Non-responsibilities.** No migrations framework (DDL ships as strings; the app owns its schema lifecycle), no connection pooling, no retention/pruning policy.

**Maturity.** Stable at 1.0 (added in 0.2).

## @orpc-agent/cli

**Purpose.** Developer tooling, not an adapter: it exposes nothing to an agent and hardcodes no surface value. Binary `orpc-agent`, first command family `inspect` / `snapshot` / `check` — the capability inventory and the CI drift gate. Bounds: [ADR-015](decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command).

**Public exports.** `buildSnapshot`, `diffSnapshots`, `loadSnapshot`, `snapshotJson`, `renderInventory`, `renderChanges`, `renderGithub`, `renderMarkdown`, `LoadError`; types `CapabilitySnapshot`, `CapabilityEntry`, `Change`, `ChangeKind`, `LoadOptions`.

**Dependencies.** `@orpc-agent/core` only. It runs on every pull request, so its install surface stays that: no rendering framework, no transpiler. `tsx`/`jiti` are *spawned* as loaders when the project already has them — the boundary check bans importing either from `src/`.

**Non-responsibilities.** Does not evaluate policies (declarations, not reachability — see ADR-005), does not invoke application code (a function export is refused, never called), does not judge new capabilities that have no snapshot baseline.

**Maturity.** Stable at 1.0 (added in 0.3).

## @orpc-agent/testing

**Purpose.** Deterministic verification of governance without a model: direct invocation with fake actors, policy decision assertions, approval probes (auto-approve / auto-reject / manual), captured audit events, fake clock, handler overrides.

**Public exports.** `createAgentTestRuntime(options)`; `fakeActor`, `testClock`, `approvalProbe`, `capturedAudit`.

**Dependencies.** `@orpc-agent/core` only.

**Non-responsibilities.** Not a test framework (works inside Vitest/Jest/node:test), no snapshot management, no LLM simulation.

**Maturity.** Stable at 1.0, co-developed with core (core's own tests use it).

## Boundary tests (implementation must enforce)

- A dependency-cruiser (or equivalent) rule fails CI if core imports from any adapter, or an adapter imports from another adapter.
- Core's published `package.json` lists no runtime dependency on `ai`, `@modelcontextprotocol/sdk`, or `@opentelemetry/*`.
- The testing package's test suite runs with network access disabled.
