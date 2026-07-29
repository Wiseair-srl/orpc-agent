# Contributing: release process

> **Status:** Stable — 1.0. Applies from the first published release onward.

## Versioning

- Changesets-driven; independent package versions within one coordinated release train (a release publishes all changed packages together, keeping intra-repo peer ranges valid).
- **Semver, strictly, from 1.0 onward**: major = a breaking change to any documented API; minor = additive; patch = fixes. A breaking change never ships in a minor, whatever the migration notes say — that was the pre-1.0 allowance and it is over.
- The published surface is what the [reference](../reference/core.md) documents. Anything reachable but undocumented is not part of the contract.
- Peer-dependency ranges are part of the contract: widening one is a minor, narrowing one is a major. Note that changesets bumps a package **major** when a package it peer-depends on is bumped at all — intended, since a peer range change is breaking downstream.

## Release checklist

1. All CI green: tests (incl. SI-tagged and adapter conformance), boundary rules, api-report diffs clean or doc-synced.
2. Docs sweep: changed behavior reflected; ADR addenda for divergences; [open-questions](../open-questions.md) updated; ROADMAP tier moves recorded.
3. Security pass for the release diff: does any change touch pipeline stages, invariants, adapter trust boundaries, or error serialization? If yes → security-reviewer sign-off ([GOVERNANCE](../../GOVERNANCE.md#decision-process)).
4. Changesets consumed → versions bumped → changelogs generated (human-edited summary at top: what breaks, what's new, migration).
5. Tag `vX.Y.Z`, publish to npm with provenance from CI (no local publishes), GitHub release mirrors the changelog.
6. Post-release: verify a clean `pnpm add` of each package in a scratch project; smoke the getting-started snippet.

## Security releases

Fixes for reported vulnerabilities ([SECURITY.md](../../SECURITY.md)) may skip the normal train: minimal-diff patch on the latest minor of the current major (and the previous minor if within its 6-month critical-fix window), advisory published simultaneously, credit per reporter preference. Any maintainer may veto a regular release to prioritize a security one.

## Deprecations

Deprecate in a minor — runtime warning where feasible, changelog entry, doc strike-through — and remove no earlier than the next major. Error codes and audit event types are never repurposed, only added or (rarely, with ADR) retired.
