# Threat model

> **Status:** Implemented in v0.1 — v0.1. Scope: the framework's own layers (adapter → runtime → capability). Application infrastructure (network, OS, database, identity provider) and model-provider security are out of scope here but not out of your responsibility.

## Assets

- **A1** Application data and state (customer records, orders, money movements)
- **A2** Actor credentials and session integrity
- **A3** The approval decision channel
- **A4** Audit-trail integrity and completeness
- **A5** Compute/spend (model tokens, expensive downstream calls)
- **A6** Capability inventory secrecy (what operations exist, for some deployments)

## Adversaries and fault sources

- **ADV1** External attacker injecting content the model will read (emails, tickets, web pages)
- **ADV2** Malicious or compromised MCP client / external caller
- **ADV3** Legitimate but over-trusted internal user driving the agent beyond their authority
- **ADV4** Buggy or misaligned model behavior (loops, hallucinated calls, wrong targets) — a fault source as dangerous as an adversary
- **ADV5** Compromised application dependency reading process memory is **out of scope** (no in-process framework survives it)

## Threat catalog

| ID | Threat (adversary → asset) | Mitigations | Residual risk |
|---|---|---|---|
| T1 | Injected content steers model into unauthorized *invocation* (ADV1 → A1) | SI-1 exposure allowlist; SI-2 execution-time checks; middleware authority (ADR-008); approvals on high-impact ops (SI-4/5); deterministic policies (SI-7) | Steering *within* the actor's legitimate authority — bounded, not eliminated; see [prompt-injection.md](prompt-injection.md) |
| T2 | Injected content steers model into *exfiltration* via outputs (ADV1 → A1) | `redact.output`; minimal output schemas; SI-9 error concealment; SI-10 payload-free evidence | Data legitimately returned to the model can still be misused by it; output design is the control |
| T3 | External client invokes capabilities not shown to it (ADV2 → A1) | SI-2 (discovery ≠ authorization); SI-8 concealment; per-session actor from transport auth (SI-3) | None beyond app-auth strength — by design the hidden/shown distinction carries no security weight |
| T4 | Client probes for hidden capabilities (ADV2 → A6) | SI-8: unknown/unexposed/hidden indistinguishable; probing visible in audit (`capability.denied`, reason recorded) | Timing side channels not addressed in v0.1 (accepted; noted in [open-questions](../open-questions.md#q10)) |
| T5 | Model or client floods retries / expensive calls (ADV4, ADV2 → A5) | SI-11 no auto-retry for writes; SI-12 timeouts; audit visibility of re-invocations | **Rate limiting is not in v0.1** — deploy app-level limits in middleware; framework-level quotas are an open question |
| T6 | Model manufactures its own approval (ADV4 → A3) | SI-4: decision path bypasses the model entirely; no decide-capability exposed to model surfaces; self-approval rejected | Social engineering of the human approver — mitigated only by readable approval UIs and culture |
| T7 | Input mutated between approval and execution (any → A3) | SI-5 hash binding; atomic consumption; re-validation at resume | Compromise of the coordinator store itself → detected by hash mismatch, not prevented |
| T8 | Approval replayed for repeated execution (any → A3) | Single-use consumption (`APPROVAL_CONSUMED`); expiry | Multi-process coordinators must implement `markConsumed` atomically — an implementation obligation, stated in the interface contract |
| T9 | Actor spoofing via tool arguments ("act as admin") (ADV1/ADV4 → A2) | SI-3: actor built from transport auth only; arguments never touch identity; `context.agent.actor` read-only downstream | None within the framework; session theft is app-level |
| T10 | Cross-tenant access via crafted ids (ADV3/ADV4 → A1) | Middleware tenancy scoping (authoritative); policy backstop; context-derived tenant identity ([authorization.md](authorization.md#multi-tenancy)) | Apps that scope by argument instead of context defeat this — documented anti-pattern |
| T11 | Sensitive data leaks through traces/audit (any → A1) | SI-10 structural payload absence; hash-not-value in events; `actorIdAttribute` off by default | Custom sinks/spans that add payloads own their consequences |
| T12 | Audit evasion — acting without records (any → A4) | Events emitted from inside the runtime on every path incl. denials; `strict` mode for audit-before-effect (`AUDIT_UNAVAILABLE`) | Default best-effort mode can drop events on sink failure — deployments needing proof use `strict` |
| T13 | Malicious capability metadata (supply-chain style, e.g. a package exporting a "helpful" capability) (→ A1) | Explicit registry composition (nothing auto-registers); `inspect()` review surface; exposure still deny-by-default | Review discipline; the framework cannot judge intent |
| T14 | Policy bugs fail open (fault → A1) | SI-7 fail-closed on throw/timeout; deny-wins precedence; deterministic policy contract; testing package for policy assertions | A policy that *returns* `allow` wrongly is a logic bug — testable, not preventable |
| T15 | Unbounded execution / hung downstreams (fault → A5) | SI-12 composite signal; per-capability `timeoutMs` | Handlers ignoring `signal` — lint-able convention, verified in the reference app |

## Assumptions

1. The application authenticates transports correctly; a forged session defeats layer 1 for that actor.
2. The process, its memory, and its dependencies are trusted (see ADV5).
3. The approval coordinator store enforces its atomicity contract.
4. Handlers forward `signal` and do not perform effects after abort where avoidable.
5. Deployments needing audit completeness run `strict` mode with a durable sink.

## Review cadence

This model is revisited at every minor release and whenever an adapter with a new trust profile (workflow, A2A, CLI) lands — each new surface gets a row-by-row pass. Reports: [SECURITY.md](../../SECURITY.md).
