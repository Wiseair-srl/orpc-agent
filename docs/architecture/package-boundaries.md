# Package boundaries

> Seven packages published under the `@orpc-agent` scope ([ADR-011](decisions.md#adr-011-npm-scope-and-project-independence)), and the dependency rules that keep them apart.

## Monorepo layout

```text
orpc-agent/
├── packages/
│   ├── core/            -> @orpc-agent/core
│   ├── ai-sdk/          -> @orpc-agent/ai-sdk
│   ├── mcp/             -> @orpc-agent/mcp
│   ├── postgres/        -> @orpc-agent/postgres
│   ├── opentelemetry/   -> @orpc-agent/opentelemetry
│   ├── testing/         -> @orpc-agent/testing
│   └── cli/             -> @orpc-agent/cli
├── examples/
│   ├── customer-support/
│   └── mastra-task-board/
└── docs/
```

pnpm workspaces; TypeScript strict; **ESM only** (`type: module`, Node ≥ 20.19 — no CJS build ships). There is **no** separate schema package: Standard Schema support lives in core under the `@orpc-agent/core/schema` subpath ([ADR-009](decisions.md#adr-009-standard-schema-interoperability-lives-in-core)).

## Dependency direction

```text
            @orpc/server (peer)      @standard-schema/spec (types)
                    \                 /
                     v               v
                   @orpc-agent/core
        ^     ^     ^       ^      ^        ^
        |     |     |       |      |        |
   ai-sdk   mcp   postgres  otel  testing  cli
   (peer:   (peer: (no      (peer: (no      (peer:
   ai@^5    mcp    driver)  otel   protocol core —
   ||^6)    sdk)            api)   deps)    one instance)
```

Rules (binding):

- Core depends on **no** model provider, no `ai`, no MCP SDK, no OpenTelemetry, no database driver.
- Adapters depend on core plus exactly their protocol SDK, always as a **peer dependency** so the application controls the version.
- No adapter depends on another adapter. The MCP package is never required by the AI SDK package and vice versa.
- Testing depends only on core; it must run without any LLM, network, or protocol SDK.
- The CLI takes core as a **peer**: the requirement is one *module instance*, not one version ([ADR-016](decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract) §8).
- Examples may depend on everything.

## @orpc-agent/core

**Purpose.** The neutral capability model and governed runtime: metadata typing, registry, execution pipeline, policies, approvals, errors, audit events, tracing interface, schema utilities.

**Public exports.**

```text
agentProcedure, createCapabilityRegistry, defineGovernance,
createAgentRuntime, definePolicy, composePolicies,
allow, deny, hide, requireApproval, unwrap, defaultToolName,
createInMemoryApprovalCoordinator, CapabilityError
types: AgentMeta, AgentCapability, CapabilityRegistry, AgentGovernance,
  AgentRuntime, AgentRuntimeOptions, Actor, AgentInvocationInfo,
  ExecutionRequest, ExecutionResult, ExecutionOptions,
  CapabilityDescriptor, DescribeScope, AgentPolicy, PolicyDecision,
  PolicyPhase, PolicyRequest, ApprovalRequest, ApprovalRecord,
  ApprovalDecision, ApprovalCoordinator, AgentAuditEvent, AuditSink,
  TracingAdapter, SpanHandle, ExposureSurface, SideEffect, RiskLevel,
  FailureStage, ErrorCode
subpath @orpc-agent/core/schema: toJsonSchema, registerSchemaConverter
```

**Dependencies.** Peer: `@orpc/server`. Type-only: `@standard-schema/spec`. Runtime deps: none beyond the platform (Web Crypto for hashing, `AbortSignal`).

**Non-responsibilities.** No persistence (the in-memory approval coordinator is for development and tests), no HTTP server, no model calls, no OpenTelemetry objects (only the neutral `TracingAdapter` interface), no scheduling.

## @orpc-agent/ai-sdk

**Purpose.** Convert a runtime's exposed capabilities into Vercel AI SDK tools: per-request tool sets bound to an actor and context, structured tool results, model-safe error envelopes, approval-required signaling.

**Public exports.** `toAISDKTools(runtime, options)`; types `AISDKToolsOptions`, `AISDKToolResult`.

**Dependencies.** `@orpc-agent/core`; peer `ai@^5 || ^6` (one code path, both majors covered in CI).

**Non-responsibilities.** No agent loop, no prompt management, no model selection, no streaming UI helpers. It produces tools; the application runs `generateText`/`streamText`.

**Relationship.** Pure consumer of `runtime.describe("aiSdk", …)` and `runtime.invoke(…, { surface: "aiSdk" })` per the [adapter model](adapter-model.md).

## @orpc-agent/mcp

**Purpose.** Expose a runtime as an MCP server: `tools/list` from discovery, `tools/call` through the runtime, per-session actor/context construction from transport authentication.

**Public exports.** `createMCPServer(runtime, options)` returning `{ server, connect(transport) }`; type `MCPServerOptions`.

**Dependencies.** `@orpc-agent/core`; peer `@modelcontextprotocol/sdk`.

**Non-responsibilities.** No OAuth server (the app authenticates and hands the adapter a verified identity), no MCP resource or prompt features, no dynamic `list_changed`.

## @orpc-agent/opentelemetry

**Purpose.** Implement core's `TracingAdapter` on `@opentelemetry/api`: real spans for `agent.capability_call`, `agent.policy_evaluation`, `agent.approval_request`, `agent.procedure_execution`, with the attribute conventions in [reference/events.md](../reference/events.md).

**Public exports.** `createOpenTelemetryTracing(options?)`.

**Dependencies.** `@orpc-agent/core`; peer `@opentelemetry/api`.

**Non-responsibilities.** No exporter/SDK setup (the app owns its OTel SDK), no metrics, no log correlation.

## @orpc-agent/postgres

**Purpose.** Postgres reference implementations of the durability seams: `ApprovalCoordinator` (compare-and-set consumption, lazy clock-injected expiry) and `AuditSink` (strict-mode-safe, optional terminal-event batching). Bounds: [ADR-013](decisions.md#adr-013-postgres-reference-persistence-package).

**Public exports.** `createPgApprovalCoordinator(options)`, `createPgAuditSink(options)`, `APPROVALS_DDL`, `AUDIT_DDL`; types `PgQuery`, `PgApprovalCoordinatorOptions`, `PgAuditSinkOptions`, `PgAuditSink`.

**Dependencies.** `@orpc-agent/core` only — **no database driver**; the `PgQuery` function is the seam, and the boundary check bans `pg`/pglite imports from `src/`.

**Non-responsibilities.** No migrations framework (DDL ships as strings; the app owns its schema lifecycle), no connection pooling, no retention/pruning policy.

## @orpc-agent/cli

**Purpose.** Developer tooling, not an adapter: it exposes nothing to an agent and hardcodes no surface value. Binary `orpc-agent`, first command family `inspect` / `snapshot` / `check` — the capability inventory and the CI drift gate. Bounds: [ADR-015](decisions.md#adr-015-a-developer-cli-with-capability-inventory-as-its-first-command).

**Public exports.** `buildSnapshot`, `diffSnapshots`, `loadSnapshot`, `snapshotJson`, `renderInventory`, `renderChanges`, `renderGithub`, `renderMarkdown`, `LoadError`; types `CapabilitySnapshot`, `CapabilityEntry`, `Change`, `ChangeKind`, `LoadOptions`.

**Dependencies.** `@orpc-agent/core` only. It runs on every pull request, so its install surface stays that: no rendering framework, no transpiler. `tsx`/`jiti` are *spawned* as loaders when the project already has them — the boundary check bans importing either from `src/`.

**Non-responsibilities.** Does not evaluate policies (declarations, not reachability — see ADR-005), does not invoke application code (a function export is refused, never called), does not judge new capabilities that have no snapshot baseline.

## @orpc-agent/testing

**Purpose.** Deterministic verification of governance without a model: direct invocation with fake actors, policy decision assertions, approval probes (auto-approve / auto-reject / manual), captured audit events, fake clock, handler overrides.

**Public exports.** `createAgentTestRuntime(options)`; `fakeActor`, `testClock`, `approvalProbe`, `capturedAudit`.

**Dependencies.** `@orpc-agent/core` only.

**Non-responsibilities.** Not a test framework (works inside Vitest/Jest/node:test), no snapshot management, no LLM simulation.

## Boundary tests (implementation must enforce)

- A dependency-cruiser (or equivalent) rule fails CI if core imports from any adapter, or an adapter imports from another adapter.
- Core's published `package.json` lists no runtime dependency on `ai`, `@modelcontextprotocol/sdk`, or `@opentelemetry/*`.
- The testing package's test suite runs with network access disabled.
