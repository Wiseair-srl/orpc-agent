# Security policy

oRPC Agent is a security-focused framework in **design phase**: no packages are published yet, so "vulnerabilities" today are design flaws — and we want those reports just as much as code exploits later.

## Reporting

**Do not open public issues for exploitable problems.**

- Preferred: GitHub private vulnerability reporting ("Report a vulnerability") on this repository.
- We aim to acknowledge within **72 hours** and give an assessment within **14 days**. Coordinated disclosure: we'll agree on a timeline with you; default publication is upon fix release (or 90 days, whichever is sooner).
- No bug bounty exists; credit is given in advisories unless you prefer otherwise.

In scope (design phase): violations of the documented [security invariants](docs/security/security-model.md#security-invariants-si-1--si-12) (SI-1…SI-12), flaws in the [approval integrity design](docs/concepts/approvals.md#input-integrity-mechanics), concealment gaps ([SI-8]), error-information leaks (SI-9), unsound claims in the docs. Once code ships: anything where implementation lets an agent surface do what the documentation says it cannot.

Out of scope: vulnerabilities in applications built with the framework (report to those projects), in oRPC itself, in model providers, and prompt-injection *occurrence* (the framework bounds impact; it does not prevent injection — [documented](docs/security/prompt-injection.md)).

## What the framework does and does not claim

Read before reporting, to calibrate expectations:

- It **provides controls for** exposure, execution-time authorization, approvals, redaction, and audit; it **requires** application-level authentication and authorization to exist.
- It does **not** claim to solve prompt injection, provide exactly-once execution, or be "production-safe by default".
- Supported-version policy (post-release): latest minor receives fixes; the previous minor receives critical fixes for 6 months.

## Design-phase security review

Structured review is actively wanted: the [threat model](docs/security/threat-model.md) (T1–T15) and the [execution pipeline](docs/architecture/execution-pipeline.md) are the highest-value review targets. Non-exploitable design critique is welcome as a public issue labeled `security-design`.
