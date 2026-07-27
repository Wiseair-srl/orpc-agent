# Contributing: documentation

> The docs are the project's first implementation — treat edits with code-review seriousness.

## Structure and ownership

| Area | Nature | Change process |
|---|---|---|
| `architecture/`, `reference/`, `security/` | **Normative** — implementation follows them | PR + (for semantics changes) ADR |
| `concepts/`, `guides/`, `adapters/`, `examples/` | Explanatory — must agree with normative docs | PR; reviewers check consistency |
| `faq`, `glossary`, `index`, `roadmap` | Navigational | PR |
| `open-questions.md` | Living | Updated whenever a question opens/resolves |

## Style rules

- **Status header** under every H1 stating implementation status. Never present unimplemented behavior as shipped: shipped pages say **Implemented in v0.1**, and anything not yet built is labelled **Planned** or **Deferred**.
- **Terminology per the [glossary](../glossary.md)** — especially tool/capability, user/actor, authn/authz, permission/approval, retry/replay, audit/tracing.
- **One API, everywhere.** Code examples use the exact public symbols from [reference/core](../reference/core.md); the example domain is the customer-support app (`orders.refund`, $500 threshold, `orders:refund` permission). Don't invent parallel examples with new names.
- **Cite anchors, don't restate**: pipeline stages ("stage 8"), invariants ("SI-5"), decisions ("ADR-006"), threats ("T7"). If you must restate, you're probably editing the wrong file.
- **Text diagrams** (ASCII) only — renderable anywhere, diffable.
- **Cross-link relatively** (`../concepts/policies.md`) and end pages with a Related section.
- Honest-claims vocabulary: "designed to", "reduces the impact of", "requires application-level authorization" — never "fully secure", "solves prompt injection", "exactly-once", "zero configuration", "production-safe by default".
- Concise where possible, detailed where lifecycle or security semantics matter. No decorative prose.

## Consistency checks before merging

Run the grep pass (a script lands with M1; until then, manually):

```bash
# symbols that must not exist (old/renamed): defineAgentAction, AgentToolError, AgentMetadata, createOpenTelemetryPlugin
# enums spelled exactly: "aiSdk" (never "ai-sdk" as a surface value), sideEffect values, error codes
# every relative link resolves; every SI-n ≤ 12, ADR ≤ 011, stage ≤ 15, T ≤ 15, Q ≤ 11, M ≤ 9
```

## When code and docs disagree

The docs win until an ADR says otherwise; the disagreement is filed as a bug either way ([CONTRIBUTING](../../CONTRIBUTING.md#working-agreements)). M9's final sweep replaced the pre-implementation "Proposed API"/"Design target" phrasing with as-built truth.
