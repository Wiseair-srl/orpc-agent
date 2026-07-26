# Governance

> **Status:** Bootstrap governance for the design/early-implementation phase. Deliberately lightweight; revisited when the project has multiple active maintainers and shipped releases.

## Principles

1. **Technical decisions are written decisions.** Architecture changes go through ADRs ([docs/architecture/decisions.md](docs/architecture/decisions.md)); scope changes through [ROADMAP.md](ROADMAP.md); unresolved matters live in [open questions](docs/open-questions.md) — not in chat history.
2. **Security conservatism wins ties.** Where consensus fails on a security-relevant choice, the more restrictive option ships (mirroring the framework's own deny-by-default stance).
3. **Independence.** The project is not affiliated with the oRPC maintainers. If they ever wish to adopt it upstream, maintainers commit to good-faith transfer discussions (ADR-011).

## Roles

- **Maintainers** — merge rights, release rights, ADR acceptance, security-report handling. Initially the founding maintainer; expanded by unanimous maintainer agreement based on sustained, high-quality contribution.
- **Contributors** — anyone with a merged PR or accepted design input. Named in release notes.
- **Security reviewers** — contributors invited to pre-release review of security-relevant changes (SI-tagged tests, pipeline changes, adapter trust boundaries).

## Decision process

| Decision | Process |
|---|---|
| Bug fixes, docs fixes | One maintainer approval |
| Public API addition | PR + reference-doc update; two maintainer approvals once ≥2 maintainers exist |
| Architecture/lifecycle/security-semantics change | ADR PR (status *Proposed*), ≥1 week open for comment, maintainer consensus → *Accepted* |
| Scope tier change (roadmap) | Maintainer consensus recorded in the ROADMAP PR |
| Release | Per [release process](docs/contributing/release-process.md); any maintainer may veto with a stated security reason |

Consensus = no maintainer objection after explicit sign-off request. Sustained disagreement among maintainers resolves by majority; the minority position is recorded in the ADR's alternatives.

## Conduct and moderation

The [Code of Conduct](CODE_OF_CONDUCT.md) applies to all project spaces. Maintainers enforce it; conflicts of interest (a maintainer is party to a report) recuse.

## Changing this document

PR + all-maintainer approval + 1 week comment period.
