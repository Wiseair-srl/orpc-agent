# FAQ

> **Status:** Stable — 1.0.

## Positioning

**Why not just define AI SDK tools by hand?**
For three tools, do. The costs arrive with scale and stakes: duplicated schemas drifting from your API, ad-hoc auth per tool, string errors leaking internals, nothing audited, no approval story, and a second implementation of every operation your UI already has. oRPC Agent's bet: you already wrote the operation once as an oRPC procedure — govern that, everywhere ([migration guide](guides/migrating-existing-tools.md)).

**Is this an agent framework?**
No. It has no loop, no planner, no memory, no prompts. It is the layer *under* your loop (AI SDK, OpenAI Agents SDK, LangGraph, Mastra, hand-rolled) that makes what the loop can *do* governed. Pick any loop; keep it.

**How does it relate to oRPC's own ecosystem (OpenAPI, etc.)?**
oRPC owns contracts and transports; this project adds agent-specific governance (exposure, policies, approvals, audit) as a separate, independent layer. If oRPC ships overlapping integrations, ours remain a governance wrapper over the same procedures. This is **not** an official oRPC project (ADR-011).

**Does it work with tRPC / plain functions?**
Not in v0.1 — the design leans on oRPC's meta, context, middleware-in-call-path, and Standard Schema support. The *concepts* port; the code targets oRPC deliberately (narrow and coherent beats broad and vague).

**Which model providers are supported?**
Any the Vercel AI SDK supports, and anything speaking MCP. Core never touches a provider (ADR-003). "Works with every provider" is not claimed — adapters are tested against specific SDK major versions (peer ranges in each package).

## Security

**Does it prevent prompt injection?**
No, and distrust anything that says it does. It *bounds the impact* of a steered model: allowlisted narrow capabilities, execution-time authorization, approvals bound to exact inputs, minimized outputs, full audit ([prompt-injection](security/prompt-injection.md)).

**If I filter tools per user, isn't that enough?**
No — filtering shapes conversations; requests can arrive anyway (hallucinated names, other surfaces, bugs). Every invocation re-runs exposure, policies, middleware, approvals (SI-2, ADR-005).

**Can the model approve an operation if I give it an "approve" tool?**
Don't. The design's answer is structural: approval decisions flow through `runtime.approvals.decide`, which is your authenticated app surface, and the approver must differ from the requesting actor (SI-4). Exposing a decide-capability to a model surface reintroduces self-approval through the side door.

**Is execution exactly-once?**
No, and no library that doesn't own your datastore can honestly claim it. Guaranteed: at-most-once result finalization per execution, single-use approvals, no auto-retry of writes, and stable idempotency keys for *your* deduplication ([idempotency-and-retries](security/idempotency-and-retries.md)).

**Why must `risk` be spelled out even for reads?**
Because sensitivity ≠ side effect (a salary *read* is high-risk), and because deriving it would silently misclassify. The friction is the feature: someone decides, in a reviewable diff.

## Design

**Why an envelope instead of throwing?**
`approval-required` is a normal outcome; adapters need exhaustive, typed cases; exceptions across adapter boundaries lose information. `unwrap()` exists when you want throwing ergonomics ([concepts/runtime](concepts/runtime.md#the-result-envelope)).

**Why can't policies modify input?**
Silent rewrites make audit records lie ("model asked X, Y executed") and breed heisenbugs. Deny with a message; the model adjusts and re-asks — visibly (SI-6, [open-questions Q6](open-questions.md#q6)).

**Why dot-path ids instead of configurable names?**
One naming truth. Ids feed approvals, audit, policies, tool names — an alias layer would drift. Renaming a path is a breaking change and should feel like one ([concepts/registry](concepts/registry.md#identity-comes-from-structure)).

**Why is there no built-in approval/audit database?**
Storage requirements (retention, residency, compliance) diverge too much; interfaces + your store beat a bundled database you'd fight (ADR-010, ADR-007). In-memory implementations ship for dev/test.

**Streaming outputs?**
Deferred. oRPC supports event iterators, but governed streaming (validate/redact/audit *chunks*?) needs design work — [open-questions Q11](open-questions.md#q11). v0.1 capabilities return complete values.

## Practical

**What's the minimum viable adoption?**
One procedure annotated, one registry, one runtime, `toAISDKTools` — ~20 lines over what you have ([getting-started](getting-started.md)). Policies, approvals, audit, MCP are additive later.

**Can my UI use the runtime too?**
Yes — `surface: "direct"` gives UI actions the same audit trail and policy evaluation as agent calls. Optional; your existing oRPC routers keep working unchanged either way.

**What happens to my existing oRPC middleware?**
It runs, unchanged, on every governed invocation — inside the procedure call, as always, and it remains the authoritative authorization layer (ADR-008).

**When is v0.1?**
v0.1 is implemented in-repo — the [implementation brief](implementation/brief.md)'s acceptance criteria all pass. What remains before an npm release is scope registration ([Q1](open-questions.md#q1)); scope is fixed ([ROADMAP](../ROADMAP.md)) and release dates are still not promised.
