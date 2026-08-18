# Open design questions

> Every decision still open, in one place rather than scattered through the docs. Each entry states what has to be decided, the options, and the current answer. **None of them blocks a release.**

Resolved questions keep their number so existing citations still land: [Q2](#q2) and [Q8](#q8) are recorded at the bottom, with pointers to the decision records that answered them.

## Q3 — JSON Schema conversion beyond Zod v4 <a id="q3"></a>

**Decision needed.** Adopt a community Standard-Schema→JSON-Schema converter as a default fallback, or stay registry-only (Zod v4 built in, everything else registered by the application)?

**Options.** Registry-only — explicit and predictable. Bundle a community converter — broader out of the box, variable fidelity.

**Current answer.** Registry-only ([ADR-009](architecture/decisions.md#adr-009-standard-schema-interoperability-lives-in-core)). Valibot and ArkType users write one line more, and failure modes stay loud and early. Revisit as the converters mature.

## Q4 — MCP approval UX (elicitation) <a id="q4"></a>

**Decision needed.** Should the MCP adapter use MCP elicitation to relay human-confirmation approvals through the *client's* UI?

**Options.** (a) Today's behaviour — a pending-approval envelope, decided in your application. (b) Elicitation-based confirmation for `human-confirmation` types where clients support it.

**Current answer.** (a) for elicitation itself. Elicitation support across clients is still uneven, and confirmation-via-the-requesting-client needs a careful SI-4 analysis: the confirming human must be the *authenticated principal*, not whoever holds the client window. A prototype behind a flag is the next step.

Meanwhile the adapter ships two opt-ins that close most of the UX gap without touching the trust model: `approvals.url` (deep link from the suspension envelope into the app's authenticated approver UI) and `approvals.resumeTool` (execute-what-was-approved, requester- and surface-bound). Deciding remains outside MCP ([adapter doc](adapters/mcp.md#closing-the-approval-loop-from-chat)).

## Q5 — Session-scoped approvals <a id="q5"></a>

**Decision needed.** May one approval cover N identical (same-hash) executions within a bounded window — "approve refunds like this for the next hour"?

**Options.** Single-use only (today, SI-5 strict); counted or windowed approvals (`uses: 3`, `windowMs`).

**Current answer.** Single-use. Revisit only with concrete demand, as an explicit extension of the record schema — never a default. Windowed approvals weaken input-binding's audit clarity; if they ever land, each consumption must still be individually audited.

## Q6 — Policy-driven input constraints <a id="q6"></a>

**Decision needed.** Should policies be able to *constrain* (not rewrite) inputs — clamp `limit ≤ 25` on the `mcp` surface, say?

**Options.** (a) None — deny with a message (today, SI-6). (b) Declarative bounded overrides in the decision (`{ type: "allow", constraints: { limit: { max: 25 } } }`) applied *before* validation and visible in audit.

**Current answer.** (a). If (b) ever lands, constraints must be declarative (no arbitrary functions), pre-validation, audited, and reflected in discovery schemas — a full design, not a patch.

## Q7 — First workflow adapter target <a id="q7"></a>

**Decision needed.** Which engine gets the reference `workflow`-surface adapter: Temporal, Inngest, Trigger.dev, or [Mastra](https://mastra.ai)?

**Current answer.** Mastra leads the list — production demand, and its app-process suspend/resume model is the cheapest conformant target, possibly reducing to the [workflow-steps recipe](guides/workflow-steps.md) plus a thin step wrapper. Deferred until the pattern is proven in a real application; the recipe stays engine-agnostic on purpose, and the adapter is designed against the [conformance contract](architecture/adapter-model.md) so the choice is not architectural.

## Q9 — Rate limiting and quotas <a id="q9"></a>

**Decision needed.** Does the framework grow first-class per-actor/per-capability rate limits (threat [T5](security/threat-model.md)), or stay app-level forever?

**Options.** App-level middleware only (today); a `limits` meta block with runtime enforcement and audit events.

**Current answer.** App-level. The clean seam already exists — a policy with a counter in context — and premature quota machinery in core would violate the storage-neutral stance.

## Q10 — Discovery timing side channels <a id="q10"></a>

**Decision needed.** Should concealment (SI-8) also normalize *response timing* between unknown, unexposed, and hidden outcomes?

**Current answer.** Accepted risk, noted as [T4](security/threat-model.md). Measure real deltas before adding jitter or normalization; the mitigation is only worth its cost if the difference is distinguishable in practice.

## Q11 — Streaming outputs <a id="q11"></a>

**Decision needed.** What do output validation (stage 12), redaction (stage 13), and audit mean *per chunk* for oRPC event-iterator procedures? Do adapters stream tool results?

**Current answer.** Out of scope. Capabilities return complete values, and the registry rejects event-iterator outputs with a clear error. A design document comes before any implementation. This excludes long-running incremental reads from capability sets today.

## Q12 — `scope` on the MCP adapter <a id="q12"></a>

**Decision needed.** Should [`describe`'s `scope`](reference/runtime.md#scope-discovery-shaping-never-an-authority-boundary) reach `@orpc-agent/mcp`, where a large catalog has the same discovery cost that motivated it ([ADR-017](architecture/decisions.md#adr-017-discovery-takes-a-scope-and-a-budget))?

**Options.** A per-server construction option (`createMCPServer(runtime, { scope })`); a per-session value derived in `createContext`; nothing, leaving MCP clients to receive the full catalog.

**Current answer.** Nothing, deliberately. `tools/list` is driven by the protocol rather than by a per-step host decision, so the natural shape is server configuration rather than a per-call argument — a different design question, and one worth a real MCP consumer's demand signal first. The AI SDK adapter needed neither, because its caller already composes per request.

---

## Resolved

**Q2 — oRPC peer version range** <a id="q2"></a>
Pinned `@orpc/server ^1.14.10`; the runtime invokes procedures through oRPC's `call` utility so the middleware chain runs unchanged. Full findings: [ADR-001](architecture/decisions.md#adr-001-orpc-procedures-are-the-source-of-truth).

**Q8 — Reference persistent stores** <a id="q8"></a>
One package, `@orpc-agent/postgres`, exporting both `createPgApprovalCoordinator` and `createPgAuditSink` over a driver-agnostic query seam. Bounds: [ADR-013](architecture/decisions.md#adr-013-postgres-reference-persistence-package). The hand-rolled recipes in [human approval](guides/human-approval.md#production-coordinator) and [auditing](guides/auditing.md#minimal-wiring) remain the custom-store path.
