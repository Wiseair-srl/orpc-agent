# Architecture decision records

> **Status:** All ADRs below are **Accepted** — they bound the v0.1 implementation and describe it as built (several carry as-built addenda). Revisiting one requires a superseding ADR.

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

---

## ADR-013: Postgres reference persistence package

**Context.** ADR-006 and ADR-010 made approval storage and audit persistence application adapters behind storage-neutral interfaces; [Q8](../open-questions.md#q8) left open whether maintained reference implementations ship. The first production consumer (an ~85-capability internal finance application on Postgres) needs restart-surviving approvals and a durable audit trail — the demand signal Q8 was waiting for. The roadmap's "bundled databases" non-goal bans *owning* storage (schema migrations, retention, residency), not implementing the interfaces over storage the application owns.

**Decision.** Ship one reference package, `@orpc-agent/postgres`, exporting `createPgApprovalCoordinator` + `APPROVALS_DDL` and `createPgAuditSink` + `AUDIT_DDL`, bounded as follows:

1. **Driver-agnostic.** The package's only runtime dependency is `@orpc-agent/core`. It never imports `pg`; the seam is a minimal `PgQuery` function `(sql, params) => Promise<{ rows }>`, and a `pg.Pool` (or pglite, or a serverless driver) adapts with a one-line wrapper. The boundary check enforces the import ban on `src/`.
2. **DDL as exported strings; no migrations framework.** The application owns its schema lifecycle; the package exports canonical DDL and the docs show how to apply it.
3. **The coordinator's clock is JS.** Every time comparison passes `options.now()` as a SQL parameter — never the database's `now()` — preserving the documented "expiry is evaluated against the coordinator's clock" contract and test-clock injection.
4. **Compare-and-set, not locks.** `decide` and `markConsumed` are single-statement conditional `UPDATE`s (the [T8](../security/threat-model.md) obligation); no transactions, no `SELECT … FOR UPDATE`.
5. **Batching never voids strict audit.** The sink writes `capability.started` through synchronously in every configuration; only terminal events may buffer, and buffered events' sink promises settle at flush so per-event error routing (`onSinkError`) survives.

**Alternatives.**
- Recipes-only (the 0.1 status quo) — rejected: every production deployment re-implements the same ~200 lines with the same subtle obligations (CAS atomicity, lazy expiry, strict-mode interplay); a maintained reference is the cheapest way to make those obligations real.
- Two packages (`approvals-postgres` / `audit-postgres`, Q8's placeholders) — rejected: both are dependency-free SQL glue over the same query seam; ADR-009's "smallest coherent architecture" argument applies.
- Depending on `pg` directly — rejected: couples the package to one driver's release cadence and connection model; the query seam serves `pg`, pglite, and serverless drivers unchanged, and doubles as the test seam.

**Consequences.** The guides keep the hand-rolled recipes as the custom-store path; the package page is the recommended default. One behavior becomes documented rather than fixed: persisted inputs round-trip through JSON, so a `Date` inside an approval-gated input revives as an ISO string — resume re-validation fails safe (ADR-001 addendum), and approval-gated capabilities should prefer string/ISO datetime input schemas.

**Unresolved.** None.

---

## ADR-014: As-built API deltas for v0.2

**Context.** Implementing the 0.2 plan surfaced a small set of API details beyond ADR-013's scope. Per the review protocol, each is recorded here and reflected in the reference pages; none changes a documented behavior's contract, and every security-invariant test passes unweakened.

**Decision.** The following are part of the v0.2 as-built surface:

1. **Startup footgun warnings.** `createAgentRuntime` accepts `warnings?: boolean` (default `true`) and emits `console.warn` at construction for two statically detectable production footguns: (a) capabilities with `meta.approval.required` while the coordinator is the in-memory default *and* no inline handler is configured (pure inline confirmation is an explicit choice that legitimately never persists); (b) write/destructive/external capabilities exposed to `aiSdk`/`mcp` with zero audit sinks. Never fatal; static knowledge only (policy-driven gates are opaque at construction).
2. **Schema-conversion cache invalidation.** `toJsonSchema` has memoized per schema object since 0.1; `registerSchemaConverter` now resets that cache, so a re-registered vendor's converter takes effect for already-converted schemas.
3. **Descriptor isolation from the conversion cache.** `describe` clones the cached conversion into each `CapabilityDescriptor.inputSchema` — callers mutating a descriptor can no longer poison every later describe/tool build.
4. **MCP `authInfo` is typed.** `MCPSession.authInfo` is the MCP SDK's `AuthInfo` (was `unknown`) — a type-level narrowing with no runtime change; `createContext` implementations gain real fields (`token`, `clientId`, `scopes`, …) instead of casting.
5. **The coordinator behavioral contract is shared test infrastructure.** The in-memory coordinator's store-level tests moved to `test-fixtures/approval-coordinator-contract.ts` (same in-repo pattern as the adapter conformance checklist, ADR-012 item 10); `@orpc-agent/postgres` runs the identical suite.

**Consequences.** Reference pages note items 1 and 4 inline ([configuration](../reference/configuration.md), [adapters/mcp](../adapters/mcp.md)); the API-surface check gains the `@orpc-agent/postgres` entry. Nothing here weakens an SI-* invariant.

**Unresolved.** None.

## ADR-015: A developer CLI, with capability inventory as its first command

**Context.** Two questions come up on every review of an agent-facing codebase: *what can an agent reach from here*, and *did that change in this pull request*. Both are answerable from data the registry already holds — `inspect()` reports what is in, what is out, and what is staged — but nothing packaged that answer, so each consumer re-derived it by hand or not at all. The 0.2 plan explicitly excluded "any CLI"; this ADR is the deliberate reversal, not an oversight.

The alternative shape considered was a single-purpose `@orpc-agent/inspect`. It was rejected because the expensive and risky part is not the inventory: it is the substrate for loading a user's application (child-process isolation, TypeScript loading, export resolution, side-effect containment), which any later developer command needs identically. Extracting it after publishing a single-purpose package would mean deprecating a package name, moving a binary, and rewriting third-party CI. A second command family is also already promised in the docs — [approvals](../concepts/approvals.md) and [human approval](../guides/human-approval.md) both name a CLI as a legitimate place to surface pending requests.

**Decision.**

1. **`@orpc-agent/cli`, binary `orpc-agent`.** A developer tool, not an adapter: it exposes nothing to an agent and hardcodes no surface value. Its first command family is `inspect` / `snapshot` / `check`.
2. **`shell`, not `cli`, is reserved for a future exposure surface.** `ExposureSurface` has no `cli` member today, so this costs nothing now and prevents a published-name collision if the [exploratory CLI adapter](../../ROADMAP.md) ever lands.
3. **The snapshot is a deterministic governance contract.** No timestamps, generator version, or absolute paths; JSON Schema is canonicalized before hashing; functions (`redact`, `retryOn`, policy bodies) reduce to presence flags; policy names keep declaration order, since evaluation order decides which policy is recorded as the denier.
4. **Drift is classified, not merely detected.** `check` fails on any diff by default, but labels each change *widening* (the agent gained reach or a control weakened), *narrowing*, or *neutral*, and `--fail-on widening` makes only the first fatal. Two classifications are counter-intuitive and deliberate: a `sideEffect` change is widening **in both directions**, because declaring less than before stops every policy keyed on the old value from matching; and `idempotent: false → true` is widening, because it is what permits retrying a write (SI-11).
5. **Exit codes are contractual:** 0 clean, 1 drift, 2 could not run. A gate that cannot tell "changed" from "never loaded the app" rots silently.
6. **The application is loaded, never invoked.** The entry module is imported in a child process with `ORPC_AGENT_INSPECT=1` set and a timeout; a function export is refused rather than called.
7. **The CI path carries no rendering framework.** This runs on every pull request, so its install surface stays the package plus core. `tsx`/`jiti` are used only when the project already has them, and are spawned, never imported.
8. **The tool states what it cannot see.** It does not evaluate policies — discovery decisions need a real actor and context (ADR-005) — so it reports declarations, not reachability. Adapter-level `toolNaming` overrides are outside its view. Both are documented at the top of the reference page, not in a footnote: a governance tool that overstates its coverage is worse than none.
9. **`defaultToolName` becomes public core API.** It had three copies (registry, MCP adapter, AI SDK adapter); the CLI would have been the fourth. Naming is now one implementation, and the CLI's reported wire names are the adapters' actual mapping.

**Consequences.** The examples carry committed snapshots and `pnpm check:capabilities` runs in CI, which makes exposure semantics a regression test of the framework itself: a change to registry construction or metadata normalization that moves what reaches a surface fails the build. A rules engine for code that is wrong from the start (rather than newly wrong) is a different mechanism and is not in this version.

**Unresolved.** Whether `approvals` becomes the second command family, and on what schedule. If it does, the decision path must go through the application's configured coordinator: a CLI that records approval decisions is an approval authority, and who may approve stays the application's authorization question ([human approval](../guides/human-approval.md)).

---

## ADR-016: Runtime policies are part of the governance contract

**Status:** accepted · v0.3

**Context.** [`AgentMeta.approval`](../reference/metadata.md) documents itself as a *static* gate and directs conditional approval into policies — correctly, since a static gate fires on every surface, so an application that gates destructive work only when a model asks would otherwise make its own UI buttons and its cron actors demand human approval. Applications follow that instruction and register one runtime-level policy that returns `requireApproval()` for `aiSdk`/`mcp` and `allow()` for `direct`.

The inventory then reported those applications as having **zero approval gating**, because [`@orpc-agent/cli`](../reference/cli.md) read `meta.approval` and `meta.policies` only. Two distinct failures followed.

1. `82 capabilities · 82 exposed · 0 approval-gated` is a factual claim about declarations that reads as a claim about the application. The caveat lived in a README, which does not travel with terminal output pasted into a compliance review.
2. Worse: deleting the policy from `createAgentRuntime` left **every snapshot field byte-identical**, so `check` passed green while destructive capabilities became callable by a model loop with no approval. The single most security-relevant one-line deletion available in this architecture was invisible to the tool whose stated job is catching widening. ADR-015's snapshot covered capability declarations and silently treated runtime configuration as out of scope.

**Decision.**

1. **`runtime.policies` exposes `{ name, phases }`,** in evaluation order, composites flattened, frozen. Never `evaluate`: a decision is meaningful only inside the pipeline (shared batch deadline, fail-closed on throw, audit record), and handing out the closure would invite calls that look authoritative and are not. This leaks nothing new — the names are already in every `PolicyDecisionRecord`.
2. **The CLI still never evaluates a policy.** It reports that one *exists*; it cannot know which capabilities it gates or under what conditions, and the output says so rather than implying coverage it lacks. The inventory stays read-from-values (ADR-015 §6).
3. **Snapshot version 2 adds an optional `runtime` key, where absent ≠ empty.** Absent means no runtime was observed — *unknown*; present with `policies: []` means observed and none. Representing that difference is what makes the removal check sound, so the key is never defaulted.
4. **Removing a runtime policy is widening.** So is a policy dropping a phase, and so is the snapshot ceasing to observe runtime policies at all — reverting to a weaker check is a weakened control.
5. **Version 1 snapshots are still read,** as "never observed". No committed snapshot breaks and no `--fail-on widening` gate turns red on upgrade. The transition to observed is neutral, because the application did not change — but `check` prints a stderr notice that survives widening-only mode, since until the snapshot is rewritten the removal check is inert.
6. **The header count is qualified:** `0 approval-gated (declared)`, plus whether runtime policies were even in scope. The headline is the line that gets pasted somewhere on its own, so it carries its own caveat.
7. **A runtime dominates its own registry when a module exports both.** Same capabilities plus the policies; previously this was refused as ambiguous, which would have been hostile once the guidance is to point at the runtime.
8. **`@orpc-agent/core` becomes a peer dependency of the CLI.** The requirement is not "same version" but **same module instance**: `registerSchemaConverter` writes to module-level state in core, so a duplicated copy makes the app's converter invisible to the CLI's `toJsonSchema`, and every custom-vendor `inputSchemaHash` becomes `"unconvertible"` — phantom drift no source change caused, reproducible with two *byte-identical* copies.
9. **A startup warning for the same blind spot in core.** `emitStartupWarnings` keyed on `meta.approval.required`, so an application gating only via policy got no warning that its approvals were suspending into the restart-amnesiac default coordinator. Condition 1b covers it, deliberately narrowed to `destructive`/`external` capabilities on model surfaces: warning on every write would fire for ordinary rate-limit policies and devalue all three warnings.
10. **An interactive surface, split from the CI surface** — amending ADR-015 §7 rather than reversing it. That clause exists so the gate's install stays small and its output stays stable, and both survive here: `check` remains plain writes, and no module it reaches imports a rendering framework even optionally. `inspect` gains an [Ink](https://github.com/vadimdemedes/ink) view when attached to a terminal, and `init` — an interactive wizard that discovers the entry, reports what a snapshot would record, and writes the config — is added. ink and react are `optionalDependencies` behind a dynamic `import()`, so `--no-optional` restores the ADR-015 install exactly, and the plain renderers stay the tested fallback rather than a degraded mode.

    `init` refuses without a TTY instead of degrading. The alternative — guessing an entry and writing it — would put an unreviewed governance config into a consumer's repository, which is the failure this whole ADR is about.

    Why `inspect` and not `check`: the runtime-policy state is the fact most easily skimmed past, and a panel is harder to miss than a trailing line. `check`'s output, by contrast, is pasted into pull requests and read out of CI logs, where byte-stable text is worth more than colour.

**Consequences.** A runtime built inside a factory is not reachable by the CLI (a function export is refused, ADR-015 §6). The documented shape is a module-scope runtime spread from the same policy constant the serving runtimes use — construction is pure and does no I/O, and sharing the constant makes the two impossible to drift apart. Both examples in this repository adopt it, which turns `mcp-read-only` and `org-isolation` into gate-protected configuration.

Capability-scoped composite policies still serialize under the composite's name while runtime-level ones are flattened. The asymmetry is deliberate: flattening at capability scope would rewrite values in every committed snapshot for no security gain, whereas at runtime scope it is required for correctness — an unflattened composite keeps its name when a member is removed, which is exactly the removal that must not be invisible.

**Unresolved.** Whether capability-scoped composites should flatten in a future major, accepting the one-time churn for consistency.
