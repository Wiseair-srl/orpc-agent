# Implementation milestones

> **Status:** Normative plan for building v0.1. Companion to the [implementation brief](brief.md). Each increment is independently reviewable; do not start an increment before its dependencies are merged.

## Dependency graph

```text
M1 core: meta + agentProcedure + registry
 └─► M2 core: runtime pipeline (validate/exposure/errors/timeout/cancel/audit)
      └─► M3 core: policies + describe
           └─► M4 core: approvals
                ├─► M5 testing package        (used to harden M2–M4 retroactively)
                ├─► M6 ai-sdk adapter
                ├─► M7 opentelemetry adapter
                └─► M8 mcp adapter
                     └─► M9 reference example + docs sync  (needs M5, M6, M7; M8 for its MCP endpoint)
```

M5 lands immediately after M4, then M6/M7/M8 can proceed **in parallel**. Workspace scaffolding (pnpm, TS config, CI with boundary checks per [package-boundaries](../architecture/package-boundaries.md#boundary-tests-implementation-must-enforce)) is part of M1.

---

## M1 — Capability model

**Scope.** `AgentMeta` types and validation; `agentProcedure`; `createCapabilityRegistry` with dot-path ids, inclusion/exclusion, `filter`, `inspect`; schema subpath (`toJsonSchema`, `registerSchemaConverter`, Zod v4 built-in). Resolve [Q2](../open-questions.md#q2) (pin oRPC version; record call-utility findings).
**Public API introduced.** `agentProcedure`, `createCapabilityRegistry`, `AgentMeta`, `AgentCapability`, `CapabilityRegistry`, enums (`ExposureSurface`, `SideEffect`, `RiskLevel`), schema subpath.
**Internal modules.** `meta/validate.ts`, `registry/build.ts`, `schema/convert.ts`.
**Tests.** Metadata validation matrix (each required-field omission; retry-without-idempotent rejection; toolName collisions); id derivation; filter/inspect; Zod v4 conversion; unknown-vendor startup error.
**Docs affected.** Confirm [reference/metadata](../reference/metadata.md), [reference/core](../reference/core.md) match as built; ADR-001 addendum for Q2 findings.
**Acceptance.** A procedure tree becomes a validated registry; all listed startup errors fire with aggregated messages; boundary CI green.

## M2 — Runtime pipeline (no policies yet)

**Scope.** `createAgentRuntime` (audit config, tracing interface, defaults, `now`); `invoke` implementing stages 2–6 and 10–15 (policies stubbed to allow, approval gate pass-through); `CapabilityError` + full code table; ORPCError mapping; composite signal; retry loop with SI-11 eligibility; audit emission incl. `strict`; `unwrap`.
**Public API.** `createAgentRuntime`, `AgentRuntime.invoke`, `ExecutionResult`, `ExecutionOptions`, `CapabilityError`, `ErrorCode`, `FailureStage`, `AgentAuditEvent`, `AuditSink`, `TracingAdapter`, `SpanHandle`, `unwrap`, `Actor`, `AgentInvocationInfo`.
**Internal modules.** `runtime/pipeline.ts`, `runtime/errors.ts`, `runtime/signals.ts`, `runtime/audit.ts`, `runtime/retry.ts`.
**Tests.** Stage-order observability (audit sequence per path); every error code reachable; concealment equivalence (unknown vs not-exposed byte-identical externally, distinct in audit); timeout vs cancel; retry eligibility matrix (read+retryable retried; write not; write+idempotent+config retried); `ctx.agent` injection; strict-audit abort; envelope-never-throws property test.
**Acceptance.** `orders.search`-style capability invocable end to end on `direct`; the [pipeline doc](../architecture/execution-pipeline.md)'s stage table reproduced by an integration test's event log.

## M3 — Policies and discovery

**Scope.** `definePolicy`, `composePolicies`, decision helpers; stage 7/9 evaluation (all-evaluate, precedence, merge, fail-closed, policy timeout); `describe` with discovery phase; descriptor building; `capabilities.discovered`.
**Public API.** `definePolicy`, `composePolicies`, `allow`, `deny`, `hide`, `requireApproval`, `AgentPolicy`, `PolicyDecision`, `PolicyPhase`, `PolicyRequest`, `CapabilityDescriptor`, `AgentRuntime.describe`.
**Tests.** Precedence table (all 2-policy combinations); merge of multiple require-approvals; throw/timeout ⇒ POLICY_FAILED deny; hide-at-invocation ⇒ concealed; discovery excludes hidden, annotates requiresApproval; `policyDecisions` completeness in audit; phase defaulting.
**Acceptance.** [concepts/policies](../concepts/policies.md#evaluation-and-composition-semantics-normative) semantics all demonstrably true.

## M4 — Approvals

**Scope.** Canonical JSON + SHA-256 hashing; `ApprovalCoordinator` interface; in-memory coordinator; stage-8 gate (static + policy-driven); `resume` with the six integrity checks; inline handler mode; self-approval rejection; approval events.
**Public API.** `ApprovalRequest/Record/Decision/Coordinator`, `createInMemoryApprovalCoordinator`, `AgentRuntime.resume`, `AgentRuntime.approvals`, approvals config.
**Tests.** Full lifecycle; each failure code (`PENDING/REJECTED/EXPIRED/CONSUMED/INPUT_MISMATCH/SELF_APPROVAL/UNSERIALIZABLE_INPUT`); hash stability (key order); consumption atomicity under concurrent resume; execution-phase policy re-run at resume; expiry via injected clock; original-actor execution with approver in `ctx.agent`.
**Acceptance.** The [lifecycle walkthrough](../concepts/lifecycle.md) acts 2–4 reproducible as one test.

## M5 — Testing package

**Scope.** `createAgentTestRuntime` (wraps real runtime; fakes at seams), `fakeActor`, `testClock`, `approvalProbe`, `capturedAudit`, `"auto-approve"/"auto-reject"`, per-call test conveniences, `overrides`, adapter-conformance describe-block factory.
**Tests.** Self-tests + **retrofit**: port M2–M4's ad-hoc harnesses to this package (it becomes core's own test dependency).
**Acceptance.** Every example in [guides/testing-capabilities](../guides/testing-capabilities.md) compiles and passes verbatim (they become the package's doc tests).

## M6 — AI SDK adapter

**Scope.** `toAISDKTools`: describe-driven per-request tool sets, name mapping + collisions, `jsonSchema()` wrapping, raw-arg forwarding, envelope result shapes, approval suffix, abort propagation.
**Tests.** Conformance factory; envelope translation per status; INPUT_INVALID details pass-through; concealed error shape; naming bijection; per-request isolation (two actors ⇒ different tool sets).
**Acceptance.** A scripted `generateText` with a mocked model driving tool calls end-to-end (no live provider in CI).

## M7 — OpenTelemetry adapter

**Scope.** `createOpenTelemetryTracing`; span mapping incl. parenting from active context; attribute conventions; `actorIdAttribute`.
**Tests.** In-memory span exporter assertions: names, nesting, attributes, ok-on-approval-required, error status/code on failure, absence of payload attributes.
**Acceptance.** The [span tree](../adapters/opentelemetry.md#span-tree) reproduced in a test.

## M8 — MCP adapter

**Scope.** `createMCPServer`: per-session `createContext`, tools/list from describe, tools/call via invoke, envelope + `isError`, cancellation, annotations pass-through.
**Tests.** Conformance factory over an in-memory MCP transport; per-session visibility differences; concealment over the wire; no decide-capability exposure (lint-style test asserting no approval-decide surface).
**Acceptance.** MCP inspector (or SDK test client) session against the fixture registry behaves per [adapters/mcp](../adapters/mcp.md).

## M9 — Reference example + docs sync

**Scope.** `examples/customer-support/`: the nine capabilities, policies, runtimes, chat endpoint (mock-model script for CI), approvals dashboard routes, MCP endpoint, seed data; its test suite (the doc's "tests shipped" list); a final docs pass replacing "Design target" phrasing with as-built truth where M1–M8 diverged (each divergence needs an ADR addendum).
**Acceptance.** = the v0.1 acceptance criteria in the [brief](brief.md#acceptance-criteria).

---

## Review protocol per increment

1. PR references the normative doc sections it implements; deviations require a docs PR in the same change.
2. Security-invariant tests (SI-tagged) may never be deleted or weakened without an ADR.
3. Public API surface diffed against [reference](../reference/core.md) (api-extractor or equivalent) — additions allowed, renames are doc bugs or ADRs.
