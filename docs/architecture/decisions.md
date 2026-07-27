# Architecture decision records

> **Status:** All ADRs below are **Accepted (design phase)** — they bind the v0.1 implementation. Revisiting one requires a superseding ADR.

Format per record: context → decision → alternatives → consequences → unresolved questions.

---

## ADR-001: oRPC procedures are the source of truth

**Context.** Agent frameworks typically introduce their own action abstraction (`defineTool`, `defineAction`) with its own schema, execution function, and context. Teams that already have typed oRPC procedures would then maintain two definitions of every operation, which drift.

**Decision.** oRPC Agent introduces no second business-action abstraction. A capability *is* an oRPC procedure carrying `agent` metadata in its ordinary `.meta()`. `agentProcedure(base)` only types that metadata (and the injected `ctx.agent`); it returns a standard oRPC builder. Validation, context, middleware, and errors remain oRPC's.

**Alternatives considered.**
- `defineAgentAction({ input, execute })` — rejected: duplicates schemas and logic; the exact failure mode this project exists to remove.
- Wrapping procedures in a `Capability` class at definition time — rejected: creates a parallel object graph; the registry derives capability records instead, at composition time.

**Consequences.** The framework inherits oRPC's evolution (a peer-dependency version policy is required). Capabilities work as normal procedures in existing routers, HTTP handlers, and OpenAPI generation with zero changes. Anything oRPC cannot express (e.g., non-serializable inputs) constrains capabilities too.

**Unresolved.** None — resolved by the addendum below.

**Addendum (as built, v0.1 — resolves [Q2](../open-questions.md#q2)).**
- Peer range: `@orpc/server ^1.14.10` (pinned at M1 start). The runtime invokes procedures via oRPC's `call` utility with `{ context, signal, path }`, so the full middleware chain runs exactly as on HTTP paths.
- Input validation runs twice by necessity, once per purpose: the runtime validates at stage 5 (policies, hashes, and approvals need the validated value *before* execution), and oRPC validates inside `call` (that parse feeds the handler). Fresh invocations pass the **raw** input to `call` — for deterministic schemas both parses agree, and middleware placed before the validation index sees the same raw input it would see on HTTP. Resumption passes the **stored** input; oRPC's in-call parse is exactly the "re-validate against the current schema" step the pipeline mandates (the runtime additionally re-validates *before* consuming the record so schema drift cannot burn an approval).
- Output validation is delegated to oRPC's in-call validation (no double validation). Its failure shape (`ORPCError` `INTERNAL_SERVER_ERROR` with a `ValidationError` cause) is mapped to `OUTPUT_INVALID` with `executedBeforeFailure: true`; the equivalent `BAD_REQUEST` shape maps to `INPUT_INVALID`. This detection is version-coupled to the pinned range and revisited on peer bumps.
- Event-iterator (streaming) procedures are detected via `@orpc/contract`'s schema marker symbol (matched by description, `ORPC_EVENT_ITERATOR_DETAILS`) and rejected at registry build, per the v0.1 scope exclusion.
- Lazy routers/procedures are rejected at registry build with a clear error (registry construction is synchronous); resolve with `unlazyRouter` first.

---

## ADR-002: Capability is the internal abstraction

**Context.** "Tool" is how the AI SDK and MCP name their invocable units. Designing the core around "tools" would bake one adapter's vocabulary — and its assumptions (model-facing, flat namespace, no approval lifecycle) — into the neutral layer.

**Decision.** The internal model is the **capability**: a governed application operation with identity, classification, exposure, and policy. "Tool" appears only inside adapters, meaning "the protocol representation of a capability on this surface." Core code and docs never say "tool" for the internal object.

**Alternatives.** Adopt "tool" everywhere for familiarity — rejected: conflates a security-bearing application concept with a protocol serialization; makes surfaces like `direct` and `workflow` awkward ("tools" nobody's model sees).

**Consequences.** A glossary and terminology discipline are required ([glossary](../glossary.md)). Adapter docs must always state the mapping ("one capability ⇢ one AI SDK tool").

**Unresolved.** None.

---

## ADR-003: Core is provider-neutral

**Context.** Model SDKs churn quickly and applications mix providers. A core that imports a provider or protocol SDK inherits its release cadence and lock-in.

**Decision.** `@orpc-agent/core` has no dependency on any model provider, the `ai` package, the MCP SDK, or OpenTelemetry. Protocol and telemetry integrations live in adapter packages behind neutral interfaces defined by core (`ExecutionResult`, `CapabilityDescriptor`, `TracingAdapter`, `AuditSink`, `ApprovalCoordinator`). CI enforces the import boundary.

**Alternatives.** Ship AI SDK support inside core for a one-package quick start — rejected: the quick start costs one extra install; the coupling costs every future adapter.

**Consequences.** Some duplication of thin glue across adapters; a conformance checklist keeps them behaviorally aligned ([adapter-model](adapter-model.md)).

**Unresolved.** None.

---

## ADR-004: Exposure is explicit and surface-specific

**Context.** Auto-exposing a router to agents is convenient and dangerous: procedures written for trusted UI callers become reachable by a prompt-injectable client with no one deciding that.

**Decision.** Deny by default (SI-1). A procedure becomes a capability only when it carries `agent` metadata, and it is reachable on a surface only when `expose.<surface>` is exactly `true`. There is no `exposeAll` helper. Registry `inspect()` reports excluded procedures so omissions are visible, not silent.

**Alternatives.**
- Expose-by-default with a blocklist — rejected: unsafe default; new procedures would leak.
- Single boolean `exposed` for all surfaces — rejected: MCP (external clients) and direct (server code) have different trust profiles; surface-specific exposure is the whole point.

**Consequences.** More annotation work per capability; that friction is intentional — each exposure is a reviewed decision. Registries stay small and auditable.

**Unresolved.** None.

---

## ADR-005: Discovery and execution authorization are separate

**Context.** Many agent stacks "secure" tools by filtering the tool list per user. The model not seeing a tool does not prevent a crafted request from invoking it; filtering is UX.

**Decision.** Three independently answered questions — discovery (may the client know it exists), invocation (may the actor request it), execution (may this exact validated input run now). Discovery filtering never substitutes for the invocation/execution checks, which run on every call (SI-2). Hidden or unexposed capabilities are externally indistinguishable from nonexistent ones (SI-8).

**Alternatives.** Trust the filtered list within one process — rejected: breaks the moment there is any second path to the runtime (MCP, tests, workflow), and encourages copying the anti-pattern.

**Consequences.** Policies may run at discovery and again at invocation; policy authors must keep them cheap and deterministic. Slightly more evaluation cost per call, bought as defense in depth.

**Unresolved.** None.

---

## ADR-006: Approvals are external and input-bound

**Context.** A model asked to "confirm you want to proceed" will happily confirm; approval that flows through the model is theater. Separately, an approval for "refund $50" must not authorize a later "refund $5 000".

**Decision.** Approval decisions originate only from trusted humans, deterministic policy, or external authorized systems — never from model output (SI-4). The approval record binds capability id, requesting actor, and the SHA-256 hash of the canonical validated input; any change produces a new request; records are single-use, expiring, and the approver must differ from the requester by default (SI-5).

**Alternatives.**
- Boolean `approved` flag on the call — rejected: no lifecycle, no integrity, no audit.
- Approval as a model-visible tool (`request_approval`) — rejected as the *mechanism* (a model may *trigger* the flow, but the decision path must bypass the model).

**Consequences.** Approvals need storage; v0.1 ships an in-memory coordinator and a storage-neutral interface, so production persistence is an application adapter (consistent with ADR-010). Resumption re-validates and re-checks execution-phase policies.

**Unresolved.** Whether one approval may cover a bounded session of identical calls (rejected for v0.1; [open-questions](../open-questions.md#q5)).

**Addendum (as built, v0.1).** The inline `approvals.handler` and the coordinator flow compose instead of being strictly mutually exclusive: the handler may return `undefined` to defer a given request to the coordinator (suspend/resume) flow. This keeps one chat runtime able to confirm `human-confirmation` gates inline while manager-type approvals still suspend for the dashboard — the exact shape of the reference example. A decided request never resumes; a deferred request follows the coordinator lifecycle unchanged. Inline decisions are subject to the same `rejectSelfApproval` check; the reference example's chat-runtime variant disables it for requester-confirmed sends only, with the reason documented at the config site, while the dashboard/resume runtime keeps the default.

---

## ADR-007: Durable execution is adapter-based

**Context.** Long-lived approvals and multi-step operations tempt frameworks into building a workflow engine: persistence, timers, replay, versioning — an enormous, well-solved domain (Temporal, Inngest, Trigger.dev).

**Decision.** Core stays in-process and single-execution. Durability integrates at two seams: the `ApprovalCoordinator` interface (persist and decide out-of-process; resume re-enters the pipeline) and the `workflow` surface (engine steps call `runtime.invoke`). Core never schedules, persists, or replays.

**Alternatives.** Minimal built-in durable queue — rejected: half a workflow engine is worse than none; it would still need everything hard (exactly-once, versioning) while blocking real engines.

**Consequences.** v0.1 approval resumption across process restarts requires an application-provided persistent coordinator. Honest limitation, documented ([concepts/approvals](../concepts/approvals.md)).

**Unresolved.** Which engine gets the first official workflow adapter ([open-questions](../open-questions.md#q7)).

---

## ADR-008: Existing oRPC middleware remains authoritative

**Context.** Applications already enforce authentication, tenancy, and permissions in oRPC middleware. A governance layer that bypassed or replaced it would fork the security model.

**Decision.** The runtime invokes procedures through oRPC's own call path, so the full middleware chain runs unchanged on every agent-originated execution (pipeline stage 11). Agent policies are *additive* and answer agent-specific questions (exposure, risk, approval); application middleware remains the last, authoritative authorization word. Policies run before the procedure call because oRPC middleware is not interceptable mid-chain from outside — and does not need to be.

**Alternatives.** Re-implement authorization checks as policies and call handlers directly — rejected: two sources of truth; every middleware change would need mirroring.

**Consequences.** A capability is exactly as secure as its procedure (SI-2 depends on it). Middleware cannot see policy verdicts except through `ctx.agent`; anything middleware must know is passed there.

**Unresolved.** None.

---

## ADR-009: Standard Schema interoperability lives in core

**Context.** oRPC accepts any Standard Schema library (Zod, Valibot, ArkType…). The runtime needs to *validate* (covered by the spec's `~standard.validate`) and adapters need **JSON Schema** for model/protocol wire formats — which Standard Schema does not standardize.

**Decision.** No separate schema package. Core exposes a `@orpc-agent/core/schema` subpath with `toJsonSchema(schema)` and `registerSchemaConverter(vendor, fn)`. v0.1 ships a built-in converter for Zod v4 (`z.toJSONSchema`); other vendors register a converter or the registry fails at startup with a clear error for capabilities exposed to schema-consuming surfaces. Validation everywhere uses only the Standard Schema interface.

**Alternatives.**
- Separate `@orpc-agent/standard-schema` package — rejected: one small module doesn't justify a package boundary users must discover (smallest coherent architecture).
- Depend on a third-party any-schema-to-JSON-Schema converter — rejected for v0.1: quality varies by vendor; an explicit registry keeps failure modes visible. Revisit as converters mature ([open-questions](../open-questions.md#q3)).

**Consequences.** Non-Zod users write or import one converter function. JSON Schema fidelity is vendor-dependent and documented as such.

**Unresolved.** Adopting a community converter as default ([open-questions](../open-questions.md#q3)).

---

## ADR-010: Audit events are structured and storage-neutral

**Context.** Audit requirements (retention, residency, WORM storage, SIEM shipping) vary too much for a framework to own a database.

**Decision.** The runtime emits typed `AgentAuditEvent`s to registered `AuditSink` functions and stores nothing. Events carry identities, classifications, hashes, decisions, and durations — never raw inputs/outputs by default (SI-10). Default mode is best-effort emission; `strict: true` awaits `capability.started` and fails execution with `AUDIT_UNAVAILABLE` if the sink fails, for audit-before-effect deployments.

**Alternatives.** Bundled SQLite/Postgres audit store — rejected: schema migrations, retention, and compliance would dominate the project; a sink is trivially adapted to any store.

**Consequences.** Applications must connect a sink to get persistence (the docs say so loudly); the testing package captures events in memory, which doubles as the reference sink implementation.

**Unresolved.** Whether a maintained `@orpc-agent/audit-postgres` reference sink is worth shipping post-0.1 ([open-questions](../open-questions.md#q8)).

---

## ADR-011: npm scope and project independence

**Context.** The natural-looking `@orpc/agent-core` name implies publication under the oRPC organization's npm scope. This project is an independent community effort, not affiliated with or endorsed by the oRPC maintainers; publishing into their scope is neither possible nor honest.

**Decision.** All packages publish under a dedicated scope, placeholder `@orpc-agent/*` (core, ai-sdk, mcp, opentelemetry, testing). The README and every package carry an independence disclaimer. If the oRPC maintainers ever want the project upstream, migrating scope is a mechanical rename release.

**Alternatives.** Unscoped names (`orpc-agent-core`) — rejected: squat-prone and inconsistent. Ship under a personal scope — rejected: hostile to future governance transfer.

**Consequences.** Scope must be registered before first publish; docs mark the scope as placeholder until then.

**Unresolved.** Final scope confirmation and a courtesy heads-up to the oRPC maintainers ([open-questions](../open-questions.md#q1)).

---

## ADR-012: As-built API deltas for v0.1

**Context.** Implementing M1–M9 against the reference docs surfaced a small set of API details the design pages had not pinned. Per the review protocol, each is recorded here and reflected in the reference pages; none changes a documented behavior, and every security invariant test passes unweakened.

**Decision.** The following are part of the v0.1 as-built surface:

1. **`runtime.registry`** — `AgentRuntime` exposes its registry read-only. Adapters need capability meta for protocol concerns (`adapters.*.toolName`, MCP `annotations`) that descriptors deliberately omit; going through the runtime keeps adapters free of second sources of truth.
2. **`inspect().unexposed`** — the registry's inspect result adds the ids of capabilities whose expose map enables no surface (the "defined, reachable nowhere" staging state the metadata page says `inspect()` flags).
3. **`policyDecisions[].type` may be `"error"`** — a policy that threw or timed out is recorded honestly in the audit stance list instead of being coerced into a decision it never made (fail-closed handling is unchanged: `POLICY_FAILED`).
4. **Per-attempt timeout timer** — the execution timeout arms per stage-11 attempt (the caller signal spans the whole execution and is always terminal). This is what makes `TIMEOUT` retryable-in-practice for reads with retry config, per the errors table; timed-out writes remain never-retried (SI-11).
5. **Canonical JSON strictness** — function- and symbol-valued object properties make an input unserializable (`APPROVAL_UNSERIALIZABLE_INPUT`) instead of being silently dropped à la `JSON.stringify`: an approval hash must never bind less than the value that executes (SI-5). `undefined`-valued properties are dropped (semantically absent); `Date` serializes via `toJSON`.
6. **`resume` of an unknown approval id** returns a failed envelope with `INTERNAL_ERROR` (stage `approval`) rather than a dedicated code — the closed error table has no "approval not found" entry, and inventing one was out of scope for v0.1.
7. **Policy timeout is a shared batch deadline** (`defaults.policyTimeoutMs` per evaluation batch, as the configuration table states); a policy exceeding the remaining budget fails the batch closed.
8. **Coordinator decision events** carry the **approver** as the envelope actor (the acting entity for that event); the requester remains on all execution events and in the record itself.
9. **Builds are ESM-only** (`type: module`, Node ≥ 20.19). "CJS compatibility left to the build tool" resolved to not shipping CJS in v0.1; revisit on demand.
10. **The adapter conformance checklist** ships as shared in-repo test infrastructure (`test-fixtures/conformance.ts`, exercised by both adapter packages) rather than as a public export of `@orpc-agent/testing` — the required public API list is closed, and the checklist's consumers are adapter authors working in-tree. Promoting it to a public subpath is a candidate for 0.2.
11. **`toolNaming`** adapter options are functions `(capabilityId) => string` replacing the default `.`→`_` mapping; per-capability `meta.adapters.*.toolName` overrides still win. Collisions throw at adapter build.
12. **The testing package** declares `@orpc/server` as a peer (handler `overrides` reconstruct procedures) and `createAgentTestRuntime` accepts an optional `tracing` adapter for conformance suites. Both keep the no-protocol-SDK rule intact.

**Consequences.** Reference pages note items 1–3 and 6–8 inline; the brief's "no other public surface" rule now reads against this ADR. Nothing here weakens an SI-* invariant.

**Unresolved.** None.
