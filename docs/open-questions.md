# Open design questions

> **Status:** Living document. Every unresolved decision lives here — not scattered through the docs. Each entry states the decision needed, options, a recommendation, and implications. **Q1 and Q2** were resolved by the v0.1 release, **Q8** by v0.2; the rest are open and none blocks a release.

## Q1 — Final npm scope <a id="q1"></a>
**Status: RESOLVED (2026-07-27).** Option (a) confirmed: npm org `orpc-agent` registered (owner: pbwise), all five packages published at 0.1.0 under `@orpc-agent/*` with the independence disclaimer in every description and README. Release flow: changesets (linked lockstep across `@orpc-agent/*`), `pnpm release` locally or the CI release job on main (needs `NPM_TOKEN` + `RELEASE_TOKEN` secrets). Courtesy note to oRPC maintainers still pending.

## Q2 — oRPC peer version range <a id="q2"></a>
**Status: RESOLVED (v0.1).** Pinned `@orpc/server ^1.14.10`; the runtime uses the `call` utility (middleware chain runs unchanged); stage-5 validation is runtime-side (governance needs the value pre-execution) while the handler's value comes from oRPC's own in-call parse; output validation is delegated to oRPC's in-call validation and mapped to `OUTPUT_INVALID`. Full findings: [ADR-001 addendum](architecture/decisions.md#adr-001-orpc-procedures-are-the-source-of-truth).

## Q3 — JSON Schema conversion beyond Zod v4 <a id="q3"></a>
**Decision.** Adopt a community Standard-Schema→JSON-Schema converter as a default fallback, or stay registry-only (built-in Zod v4, everything else user-registered)?
**Options.** Registry-only (explicit, predictable); bundle a community converter (broader out-of-box, variable fidelity).
**Recommendation.** Registry-only for v0.1 (ADR-009); re-evaluate at 0.2 with real user data.
**Implications.** Valibot/ArkType users write one line more; failure modes stay loud and early.
**Blocking?** No.

## Q4 — MCP approval UX (elicitation) <a id="q4"></a>
**Decision.** Should the MCP adapter use MCP elicitation to relay human-confirmation approvals through the *client's* UI?
**Options.** (a) v0.1 behavior only (pending-approval envelope; decisions in your app); (b) elicitation-based confirmation for `human-confirmation` types where clients support it.
**Recommendation.** (a) for v0.1; prototype (b) behind a flag in 0.2 — elicitation support across clients is still uneven, and confirmation-via-the-requesting-client needs a careful SI-4 analysis (the confirming human must be the *authenticated principal*, not whoever holds the client window).
**Blocking?** No (MCP ships with (a)).

## Q5 — Session-scoped approvals <a id="q5"></a>
**Decision.** May one approval cover N identical (same hash) executions within a bounded window ("approve refunds like this for the next hour")?
**Options.** Single-use only (current, SI-5 strict); counted/windowed approvals (`uses: 3`, `windowMs`).
**Recommendation.** Single-use in v0.1. Revisit only with concrete demand, as an explicit extension of the record schema — never a default.
**Implications.** Windowed approvals weaken input-binding's audit clarity; if added, each consumption must still be individually audited.
**Blocking?** No.

## Q6 — Policy-driven input constraints <a id="q6"></a>
**Decision.** Provide a safe mechanism for policies to *constrain* (not rewrite) inputs — e.g., clamp `limit ≤ 25` for `mcp` surface?
**Options.** (a) None — deny with a message (current, SI-6); (b) declarative bounded overrides in the decision (`{ type: "allow", constraints: { limit: { max: 25 } } }`) applied *before* validation and visible in audit.
**Recommendation.** (a) for v0.1. If (b) ever lands, constraints must be declarative (no arbitrary functions), pre-validation, audited, and reflected in discovery schemas — a full design, not a patch.
**Blocking?** No.

## Q7 — First workflow adapter target <a id="q7"></a>
**Decision.** Which engine gets the reference `workflow`-surface adapter (post-0.1): Temporal, Inngest, or Trigger.dev?
**Recommendation.** Decide by user demand at 0.2 planning; design the adapter against the conformance contract so the choice isn't architectural.
**Update (0.2).** [Mastra](https://mastra.ai) joined the candidate list and currently leads it: first-production-consumer demand, and its app-process suspend/resume workflow model is the cheapest conformant target — the integration may reduce to the [workflow-steps recipe](guides/workflow-steps.md) plus a thin step wrapper. Decision still deferred until the pattern is proven in a real application; the recipe is engine-agnostic on purpose.
**Blocking?** No (Deferred scope).

## Q8 — Reference persistent stores <a id="q8"></a>
**Status: RESOLVED (0.2).** Ship **one** reference package, `@orpc-agent/postgres`, exporting both `createPgApprovalCoordinator` and `createPgAuditSink` — superseding the earlier two-package placeholder names: both are dependency-free SQL glue over the same query seam, and the "smallest coherent architecture" argument of [ADR-009](architecture/decisions.md#adr-009-standard-schema-interoperability-lives-in-core) applies. The demand signal the 0.1 recommendation waited for arrived with the first production consumer. Bounds pinned in [ADR-013](architecture/decisions.md#adr-013-postgres-reference-persistence-package): driver-agnostic query seam, DDL as exported strings (no migrations framework), JS-injected clock, batching never voids strict audit. The hand-rolled recipes in [human-approval](guides/human-approval.md#production-coordinator) and [auditing](guides/auditing.md#minimal-wiring) remain the custom-store path.

## Q9 — Rate limiting / quotas <a id="q9"></a>
**Decision.** Does the framework grow first-class per-actor/per-capability rate limits (threat T5), or stay app-level (middleware) forever?
**Options.** App-level only (current); a `limits` meta block + runtime enforcement with audit events.
**Recommendation.** App-level for 0.1–0.2; the clean seam exists (a policy with a counter in context), and premature quota machinery in core violates the storage-neutral stance.
**Blocking?** No.

## Q10 — Discovery timing side channels <a id="q10"></a>
**Decision.** Should concealment (SI-8) also normalize *response timing* between unknown / unexposed / hidden outcomes?
**Recommendation.** Accepted risk for v0.1 (noted in threat model T4); measure real deltas during M3 and add jitter/normalization only if they're distinguishable in practice.
**Blocking?** No.

## Q11 — Streaming outputs <a id="q11"></a>
**Decision.** Governance semantics for oRPC event-iterator procedures: what do output validation (stage 12), redaction (stage 13), and audit mean per-chunk? Do adapters stream tool results?
**Recommendation.** Out of v0.1 (capabilities return complete values; the registry rejects event-iterator outputs with a clear error). Design doc required before 0.3.
**Implications.** Excludes long-running incremental reads from v0.1 capability sets.
**Blocking?** No.
