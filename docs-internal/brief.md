# Implementation brief for the coding agent

> **Status:** Delivered — these were the build instructions for v0.1, and v0.1 is implemented against them (all acceptance criteria green). Kept as the record of what was specified; the [decision records](../architecture/decisions.md) carry the as-built addenda. If this brief and another doc disagree, the [execution pipeline](../architecture/execution-pipeline.md) and [reference](../reference/core.md) win, and the disagreement is a bug to report. Begin coding from this document without reinterpreting the project.

## Project objective

Build oRPC Agent v0.1: a TypeScript monorepo of five packages that turns existing oRPC procedures into governed capabilities invocable by AI agents and other machine clients through a single runtime — with explicit per-surface exposure, deterministic policies, input-bound human approvals, normalized model-safe errors, structured audit events, and OpenTelemetry-compatible tracing — plus a customer-support reference application and a deterministic testing package, exactly as specified by the documentation in this repository.

## First release scope

**Core** (`@orpc-agent/core`): `AgentMeta` validation; `agentProcedure`; dot-path registry with filter/inspect; runtime with the 15-stage pipeline; policies (4 decisions, 3 phases, all-evaluate, deny-precedence, fail-closed); approvals (in-memory coordinator, inline handler, hash-bound single-use resume); `CapabilityError` with the 21-code table; audit events (11 types, strict mode); neutral tracing interface; timeout/cancellation via composite `AbortSignal`; eligibility-gated retries; schema subpath with Zod v4 JSON-Schema conversion + converter registry.

**AI SDK adapter**: per-request tool sets from `describe`, raw-arg forwarding, envelope results, approval signaling, abort propagation, name mapping.

**MCP adapter**: per-session identity via `createContext`, tools/list + tools/call, same envelope + `isError`, cancellation.

**OpenTelemetry adapter**: `TracingAdapter` implementation, 4 span names, safe attributes.

**Testing package**: test runtime wrapping the real one, `fakeActor`/`testClock`/`approvalProbe`/`capturedAudit`, overrides, adapter conformance factory.

**Reference example**: customer-support app with the 9 capabilities, 3 policies, approval dashboard flow, chat + MCP endpoints, full governance test suite.

## Package order

M1 core-model → M2 core-runtime → M3 core-policies → M4 core-approvals → M5 testing → {M6 ai-sdk ∥ M7 opentelemetry ∥ M8 mcp} → M9 example+docs-sync. Details, per-increment tests, and acceptance: [milestones.md](milestones.md).

## Required public APIs

Implement exactly these exports (contracts in [reference/core](../reference/core.md), [reference/runtime](../reference/runtime.md), [reference/errors](../reference/errors.md), [reference/events](../reference/events.md), [reference/configuration](../reference/configuration.md)):

- **core**: `agentProcedure`, `createCapabilityRegistry`, `createAgentRuntime`, `definePolicy`, `composePolicies`, `allow`, `deny`, `hide`, `requireApproval`, `unwrap`, `createInMemoryApprovalCoordinator`, `CapabilityError`; types `AgentMeta`, `AgentCapability`, `CapabilityRegistry`, `AgentRuntime`, `Actor`, `AgentInvocationInfo`, `ExecutionRequest`, `ExecutionResult`, `ExecutionOptions`, `CapabilityDescriptor`, `AgentPolicy`, `PolicyDecision`, `PolicyPhase`, `PolicyRequest`, `ApprovalRequest`, `ApprovalRecord`, `ApprovalDecision`, `ApprovalCoordinator`, `AgentAuditEvent`, `AuditSink`, `TracingAdapter`, `SpanHandle`, `ExposureSurface`, `SideEffect`, `RiskLevel`, `FailureStage`, `ErrorCode`
- **core/schema** subpath: `toJsonSchema`, `registerSchemaConverter`
- **ai-sdk**: `toAISDKTools`, `AISDKToolsOptions`, `AISDKToolResult`
- **mcp**: `createMCPServer`, `MCPServerOptions`
- **opentelemetry**: `createOpenTelemetryTracing`
- **testing**: `createAgentTestRuntime`, `fakeActor`, `testClock`, `approvalProbe`, `capturedAudit`

Additions require doc PRs; renames require ADRs. No other public surface.

## Runtime lifecycle (canonical)

Implement [execution-pipeline.md](../architecture/execution-pipeline.md) verbatim:

1. Adapter authenticates, builds actor+context, calls `invoke` with its hardcoded surface.
2. Assign `executionId`; open span `agent.capability_call`; emit `capability.requested`.
3. Resolve id — miss ⇒ `CAPABILITY_NOT_FOUND`.
4. Exposure check — fail ⇒ concealed `CAPABILITY_NOT_FOUND`, audited truthfully.
5. Validate input (Standard Schema) — fail ⇒ `INPUT_INVALID` with issue summary.
6. Actor presence/shape — fail ⇒ `UNAUTHENTICATED`.
7. Invocation-phase policies: runtime-level then capability-level, ALL evaluated, precedence deny > hide > require-approval > allow, throw/timeout ⇒ `POLICY_FAILED` deny.
8. Approval gate: create hashed request, emit, return `approval-required` (or await inline handler). Resume re-enters here: approved ∧ unexpired ∧ unconsumed ∧ hash-match ∧ approver≠requester, then atomic `markConsumed`, new executionId, original actor.
9. Execution-phase policies (opted-in only).
10. Compose AbortSignal (caller + timeout); emit `capability.started` (awaited iff `strict`).
11. Invoke procedure via oRPC server-side call with `{...context, agent}` and signal; middleware runs here; retry loop wraps this stage only.
12. Validate output — fail ⇒ `OUTPUT_INVALID`, withhold output.
13. Apply `redact.output`.
14. Emit `capability.completed`; close span.
15. Return envelope. All failures: normalize → emit terminal event → close span error → return envelope. Never throw for governed outcomes.

Discovery: exposure filter → discovery-phase policies → minimal descriptors → `capabilities.discovered`.

## Security invariants

Never violate; each ships with named tests (`SI-*` tags) that must never be weakened:

SI-1 deny-by-default per surface · SI-2 enforcement at execution time (filtering is UX) · SI-3 model never the actor · SI-4 no self-approval; decisions never from model output · SI-5 approval binds (capability, actor, input-hash), single-use atomic consumption · SI-6 validated input is immutable through execution · SI-7 policy errors fail closed · SI-8 unknown/unexposed/hidden externally indistinguishable · SI-9 internal details never reach models · SI-10 no payloads in audit/traces by default · SI-11 no auto-retry of write/destructive/external absent explicit idempotent+retry · SI-12 signal propagation, exactly one envelope per execution. Full text: [security-model.md](../security/security-model.md).

## Required test matrix

Minimum behaviors with passing tests before v0.1 (shapes in [guides/testing-capabilities](../guides/testing-capabilities.md) and per-milestone lists):

- [ ] Metadata validation: every required-field omission; retry-without-idempotent on writes; toolName collisions; aggregate startup error
- [ ] Registry: id derivation, exclusion + inspect, filter composition
- [ ] Pipeline order: audit event sequence for success / each failure class
- [ ] Every `ErrorCode` reachable via a test; envelope-never-throws property
- [ ] Concealment: unknown vs unexposed vs hidden — identical external shape, distinct audit reasons
- [ ] Validation: raw-in/validated-through (SI-6); issue summary exposure; output-invalid withholds + `executedBeforeFailure`
- [ ] Policies: precedence table; all-evaluate audit completeness; merge of approvals; fail-closed throw/timeout; phases incl. discovery annotation; hide-at-invocation concealment
- [ ] Approvals: full lifecycle; all seven failure codes; hash key-order stability; concurrent-resume atomicity; execution-phase re-check; original-actor + approver in ctx; inline mode; self-approval both settings
- [ ] Bounds: timeout vs cancel distinction; signal reaches handler; late completion not consumed
- [ ] Retries: eligibility matrix; same-executionId + `capability.retried`; model re-invocation distinct
- [ ] Redaction: output redaction before adapter/trace; approvalInput display; trace attributes payload-free
- [ ] Audit: strict-mode abort (`AUDIT_UNAVAILABLE`); sink isolation; onSinkError
- [ ] ctx.agent: injection, absence on non-agent calls, idempotencyKey stability across retries
- [ ] Adapters (each): conformance factory — listing correctness, raw forwarding, 4-status translation, concealed serialization, naming bijection, cancellation
- [ ] Example suite: exposure snapshots; refund 400/649/9000 table; E2E approval flow audit sequence; MCP concealment; timeout-not-retried write

## Deferred features (do not build)

Durable execution engine or any scheduler; persistent approval/audit store packages (interfaces + in-memory only); workflow/A2A/CLI adapters; MCP `list_changed`, elicitation approvals, resources/prompts; streaming (event-iterator) capabilities — registry must reject them with a clear error; rate limiting/quotas; policy input rewriting; session/multi-use approvals; exactly-once semantics; replay; run-explorer UI; long-term memory; multi-agent orchestration; metrics emission. See [ROADMAP](../../ROADMAP.md) and [open-questions](../open-questions.md).

## Acceptance criteria

v0.1 is complete when, observably:

1. `pnpm install && pnpm build && pnpm test` passes on a clean checkout; CI enforces package-boundary rules (core imports no adapter/provider/protocol SDK; adapters import no adapter).
2. The full test matrix above is green, with SI-tagged tests present for all twelve invariants.
3. The reference example runs its scripted (mock-model) chat flow: read → eligibility → refund(649) → approval-required → decide-as-manager → resume → completed → draft → send-with-inline-confirmation, producing exactly the audit sequence in [the example doc](../examples/customer-support-agent.md#the-end-to-end-flow-normative-for-the-example).
4. The same example refuses: refund 9000 (`POLICY_DENIED`), refund over MCP (`CAPABILITY_NOT_FOUND`), self-approval (`APPROVAL_SELF_APPROVAL`), double resume (`APPROVAL_CONSUMED`), post-expiry resume (`APPROVAL_EXPIRED`).
5. `describe("mcp")` and `describe("aiSdk")` listings in the example match the exposure table in the example doc, verified by snapshot.
6. OpenTelemetry in-memory exporter shows the documented span tree with no payload attributes.
7. Public exports of every package equal the Required-public-APIs list (api-report diff clean).
8. Docs updated where implementation forced divergence, each with an ADR addendum; no silent drift (a final grep-based consistency check of symbol names, error codes, and event names across docs passes).
