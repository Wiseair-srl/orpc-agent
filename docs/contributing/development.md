# Contributing: development

> The dev environment: pnpm workspace, TypeScript strict, Vitest, boundary/API/docs checks in CI.

## Setup

Requirements: Node ≥ 20, pnpm ≥ 9, git.

```bash
git clone https://github.com/Wiseair-srl/orpc-agent.git && cd orpc-agent
pnpm install
pnpm build
pnpm test
```

## Repository layout

```text
packages/    core · ai-sdk · mcp · postgres · opentelemetry · testing · cli
examples/    customer-support · mastra-task-board
docs/        the published site
```

Boundaries and per-package responsibilities: [package-boundaries](../architecture/package-boundaries.md).

## The checks

Tests run from the root (one Vitest project across the workspace). The rest are the gates CI enforces:

```bash
pnpm test                  # the whole suite
pnpm typecheck             # every package
pnpm check:boundaries      # no core→adapter, no adapter→adapter, no forbidden runtime dep
pnpm check:api             # public exports match the reference pages
pnpm check:docs            # symbols, error codes, event names, spans agree with the source
pnpm check:capabilities    # the examples' committed capability snapshots still match
pnpm docs:build            # the site builds; fails on any dead link
```

## Conventions

- **TypeScript strict**, ESM only. No default exports on public surfaces.
- **Tests**: Vitest. Governance and security tests use `@orpc-agent/testing` — including core's own. Security-invariant tests carry `SI-n` in the test name and may not be weakened without an ADR.
- **Public API discipline**: a change to a package's exports is a deliberate, doc-synced change; `check:api` fails otherwise.
- **Commits**: Conventional Commits (`feat(core): …`, `fix(mcp): …`, `docs: …`); changesets drive versioning ([release process](release-process.md)).
- **Determinism**: no `Date.now()`/`Math.random()` in runtime logic paths — clocks are injected (`now`), and randomness has no place in governance.

## Making a change

1. Read the normative pages first: [execution pipeline](../architecture/execution-pipeline.md), the relevant [reference](../reference/core.md) page, [security model](../security/security-model.md).
2. Where reality diverges from the docs (an oRPC API differs, a type cannot be expressed), **file the divergence** rather than choosing silently — a docs PR or an ADR accompanies the code.
3. PR checklist: tests for new behaviour · SI tests untouched or ADR-justified · `check:api` clean or doc-synced · terminology per the [glossary](../glossary.md) · docs updated in the same PR.

## Running the examples

```bash
pnpm --filter customer-support-example demo    # the documented end-to-end flow, scripted
pnpm --filter mastra-task-board-example dev    # board UI on :5173, server on :3000
pnpm --filter mastra-task-board-example demo   # the same flow without a model key
```

CI runs both in scripted mode — no network, no provider keys, deterministic.
