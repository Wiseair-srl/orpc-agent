# Contributing to oRPC Agent

Thanks for your interest. v0.1 is **implemented in-repo but unpublished**: the documentation in `docs/` remains the source of truth, and the code under `packages/` is built from it. The most valuable contributions right now are security analysis, review of the as-built code against the documented invariants, and documentation fixes — plus the v0.2 items on the [ROADMAP](ROADMAP.md).

## Ground rules

- Be respectful: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security vulnerabilities go through [SECURITY.md](SECURITY.md), never public issues.
- By contributing you agree your contributions are MIT-licensed like the project.
- This is an independent community project, not affiliated with the oRPC maintainers.

## What to contribute now

| Contribution | How |
|---|---|
| Design review ("this won't work because…") | Open an issue referencing the doc + section; concrete failure scenarios beat opinions |
| Security analysis | Issues for design-level concerns (referencing [threat-model](docs/security/threat-model.md) rows); [SECURITY.md](SECURITY.md) for exploitable specifics |
| Answers to open questions | Comment on the tracking issue for the [open question](docs/open-questions.md); PRs that resolve one must update that file + any affected ADR |
| Docs fixes (inconsistencies, unclear passages) | Direct PR; see [docs style](docs/contributing/documentation.md) |
| Implementation | Claim a milestone-scoped issue (M1 first — see [dependency order](docs/implementation/milestones.md#dependency-graph)); read the [implementation brief](docs/implementation/brief.md) fully before writing code |

## Working agreements

1. **Docs lead, code follows.** A change to public API, lifecycle order, policy semantics, error codes, event names, or security behavior lands as a docs PR (and an ADR when architectural) before or with the code. Silent drift between docs and code is treated as a bug in whichever moved without the other.
2. **Terminology is enforced.** Use the [glossary](docs/glossary.md); reviewers will flag "tool" for capability, "user" for actor, etc.
3. **Security invariants are load-bearing.** Tests tagged `SI-*` may not be deleted or weakened without an ADR ([security-model](docs/security/security-model.md)).
4. **Small PRs.** One increment, one concern. Anything touching two milestones splits.

## Development quickstart

```bash
pnpm install
pnpm build          # turbo/workspace build (scaffolding lands in M1)
pnpm test           # vitest across packages
pnpm lint           # eslint + boundary checks (core must not import adapters)
```

Full setup, repo layout, and PR checklist: [docs/contributing/development.md](docs/contributing/development.md). Release mechanics: [docs/contributing/release-process.md](docs/contributing/release-process.md). Decision-making and roles: [GOVERNANCE.md](GOVERNANCE.md).

## Proposing larger changes

Open a "design proposal" issue containing: problem, proposed change, affected docs/ADRs, security impact (which SI/threat rows it touches), and migration story. Maintainers triage weekly; accepted proposals become ADRs before implementation.
