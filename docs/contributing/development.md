# Contributing: development

> **Status:** Stable — 1.0. describes the dev environment as scaffolded (pnpm workspace, TypeScript strict, Vitest, boundary/API/docs checks in CI).

## Setup

Requirements: Node ≥ 20, pnpm ≥ 9, git.

```bash
git clone <repo-url> && cd orpc-agent
pnpm install
pnpm build
pnpm test
```

## Repository layout

```text
packages/core | ai-sdk | mcp | opentelemetry | testing    # see docs/architecture/package-boundaries.md
examples/customer-support
docs/                                                     # the source of truth
```

Per-package scripts: `build`, `test`, `test:watch`, `lint`, `typecheck` — all runnable from the root via the workspace runner (`pnpm -r test` or filtered: `pnpm --filter @orpc-agent/core test`).

## Conventions

- **TypeScript strict**, ESM-first. No default exports on public surfaces.
- **Tests**: Vitest. Governance/security tests use `@orpc-agent/testing` (from M5 onward — core's own suites get retrofitted). Security-invariant tests carry `SI-n` in the test name and may not be weakened without an ADR.
- **Boundaries in CI**: dependency-cruiser rules fail the build if core imports an adapter, an adapter imports another adapter, or a forbidden runtime dep appears in a manifest ([package-boundaries](../architecture/package-boundaries.md#boundary-tests-implementation-must-enforce)).
- **Public API discipline**: api-extractor (or equivalent) report checked in per package; a diff = a deliberate, doc-synced change.
- **Commits**: Conventional Commits (`feat(core): …`, `fix(mcp): …`, `docs: …`); changesets drive versioning ([release-process](release-process.md)).
- **Determinism**: no `Date.now()`/`Math.random()` in runtime logic paths — clocks are injected (`now`), randomness has no place in governance.

## Implementing against the docs

1. Pick the current milestone issue ([milestones](../implementation/milestones.md) — respect the dependency graph).
2. Read the referenced normative sections *first*: [pipeline](../architecture/execution-pipeline.md), relevant [reference](../reference/core.md) pages, the [brief](../implementation/brief.md).
3. Where reality diverges from the docs (an oRPC API differs, a type can't be expressed), **stop and file the divergence** — a docs PR/ADR addendum accompanies the code; you don't get to pick silently.
4. PR checklist: tests for new behavior · SI tests untouched or ADR-justified · api-report clean or doc-synced · terminology per [glossary](../glossary.md) · docs updated in the same PR.

## Running the example

```bash
pnpm --filter customer-support dev        # seeds SQLite, serves UI + chat (mock model by default)
pnpm --filter customer-support test       # the governance suite — the executable spec
MODEL_PROVIDER=... pnpm --filter customer-support dev   # optional: a real provider, never required
```

CI runs the example only in mock-model mode — no network, no provider keys, deterministic.
