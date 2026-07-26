# Contributing: release process

> **Status:** Design draft — applies from the first published release onward.

## Versioning

- Changesets-driven; independent package versions within one coordinated release train (a release publishes all changed packages together, keeping intra-repo peer ranges valid).
- Pre-1.0 semantics: minor = features and *documented* breaking changes with migration notes; patch = fixes. Everything is **experimental** until the stability table in each reference page says otherwise; experimental APIs may break in minors, always with changelog migration notes.
- `0.1.0` ships only when the [acceptance criteria](../implementation/brief.md#acceptance-criteria) pass.

## Release checklist

1. All CI green: tests (incl. SI-tagged and adapter conformance), boundary rules, api-report diffs clean or doc-synced.
2. Docs sweep: changed behavior reflected; ADR addenda for divergences; [open-questions](../open-questions.md) updated; ROADMAP tier moves recorded.
3. Security pass for the release diff: does any change touch pipeline stages, invariants, adapter trust boundaries, or error serialization? If yes → security-reviewer sign-off ([GOVERNANCE](../../GOVERNANCE.md#decision-process)).
4. Changesets consumed → versions bumped → changelogs generated (human-edited summary at top: what breaks, what's new, migration).
5. Tag `vX.Y.Z`, publish to npm with provenance from CI (no local publishes), GitHub release mirrors the changelog.
6. Post-release: verify a clean `pnpm add` of each package in a scratch project; smoke the getting-started snippet.

## Security releases

Fixes for reported vulnerabilities ([SECURITY.md](../../SECURITY.md)) may skip the normal train: minimal-diff patch on the latest minor (and previous minor if within its 6-month critical-fix window), advisory published simultaneously, credit per reporter preference. Any maintainer may veto a regular release to prioritize a security one.

## Deprecations

Experimental-phase policy: deprecate in minor N with a runtime warning where feasible + changelog + doc strike-through; remove no earlier than minor N+2. Error codes and audit event types are never repurposed — only added or (rarely, with ADR) retired.
