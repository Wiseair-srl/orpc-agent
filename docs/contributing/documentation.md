# Contributing: writing documentation

> Documentation changes get the same review as code. A wrong page is a bug that ships to everyone.

## Structure and ownership

| Area | Nature | Change process |
|---|---|---|
| `architecture/`, `reference/`, `security/` | **Normative** — the implementation follows them | PR, plus an ADR for any semantic change |
| `concepts/`, `guides/`, `adapters/`, `examples/` | Explanatory — must agree with the normative pages | PR; reviewers check consistency |
| `faq`, `glossary`, `index`, `roadmap`, `migration/` | Navigational and release-facing | PR |
| `open-questions.md` | Living | Updated whenever a question opens or resolves |

Anything written for the people building the framework rather than the people using it — release plans, increment sequencing — lives in `docs-internal/` and is not published.

## Style rules

- **No version numbers in prose** unless the sentence is genuinely about a release. Package versions live in the README and on the home page; a hand-maintained version string on every page drifts on the first release that forgets one.
- **Write in the present tense about what ships.** "There is no rewrite mechanism", not "v0.1 has no rewrite mechanism" — a reader cannot tell whether the second means *then* or *now*.
- **Terminology per the [glossary](../glossary.md)** — especially tool/capability, user/actor, authn/authz, permission/approval, retry/replay, audit/tracing.
- **One API, one example domain.** Code examples use the exact public symbols from the [reference](../reference/core.md), and the running example is the customer-support app (`orders.refund`, the $500 threshold, the `orders:refund` permission). Don't invent parallel examples with new names.
- **Cite anchors, don't restate.** Pipeline stages ("stage 8"), invariants ("SI-5"), decisions ("ADR-006"), threats ("T7"), questions ("Q12"). If you find yourself restating an argument in full, you are probably editing the wrong file — link to the page that owns it.
- **One home per fact.** Reference pages own type definitions and contracts; concepts pages explain *why* and quote only the fields under discussion. Two full copies of a type drift independently.
- **Text diagrams** (ASCII) only — renderable anywhere, diffable.
- **Cross-link relatively** (`../concepts/policies.md`) and end substantial pages with a Related section.
- **Honest-claims vocabulary**: "designed to", "reduces the impact of", "requires application-level authorization" — never "fully secure", "solves prompt injection", "exactly-once", "zero configuration", "production-safe by default".
- Concise where possible, detailed where lifecycle or security semantics matter. No decorative prose.

## The status blockquote

Optional, and only worth a line when it carries something the body does not: the package and peer range on a reference or adapter page, a caveat that changes how the page should be read, or a pointer to the page that owns the semantics. A blockquote that only says the page is stable is noise — every published page is.

Keep it the first element after the H1; the theme styles it as a callout.

## Site tooling and local preview

The docs render as a VitePress site; config lives in `docs/.vitepress/` (nav, sidebar, local search, theme).

```bash
pnpm docs:dev       # live preview at localhost:5173
pnpm docs:build     # production build — FAILS on dead links (runs in CI)
```

Conventions the site relies on:

- New pages must be added to the sidebar in `docs/.vitepress/config.ts`.
- Links to repository-root files (`ROADMAP.md`, `CONTRIBUTING.md`, `SECURITY.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`) are rewritten at render time to the wrapper pages under `/roadmap` and `/appendix/*`, which `@include` the root markdown — link the root file with a normal relative path and the site handles it.
- Links into source directories (`packages/`, `examples/`) cannot render on the site; name the path in inline code instead.

## Before merging

```bash
pnpm check:docs     # symbols, error codes, event names, spans vs the implementation
pnpm docs:build     # every relative link resolves
pnpm check:anchors  # every #fragment resolves too (needs docs:build first)
```

`check:docs` also fails on a version string inside a status blockquote, and on a reference above the current maximum for `SI-n`, `ADR-nnn`, stage numbers, `Tn`, or `Qn` — the caps it enforces are read from the source pages, so they cannot themselves go stale.

`check:anchors` exists because `docs:build` validates link *targets* but not their fragments: renaming a heading silently breaks every deep link into it. It compares against the rendered HTML rather than reimplementing the slugifier, so it cannot drift from what ships.

**Avoid em dashes and backticks in headings.** They survive into the slug — `## Schema utilities — \`x\`` becomes `#schema-utilities-—-x`, which nobody guesses and nobody wants in a URL. Put the punctuation in the first sentence instead.

## When code and docs disagree

The docs win until an ADR says otherwise, and the disagreement is filed as a bug either way ([CONTRIBUTING](../../CONTRIBUTING.md#working-agreements)).
