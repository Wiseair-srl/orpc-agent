# Security model

> **Status:** Design draft — the invariants below are **binding** for the v0.1 implementation. oRPC Agent provides controls that reduce the impact of agent misbehavior; it does not make an unsafe application safe, and it requires application-level authorization to exist and remain enforced.

## Threat posture

Design assumption: the model end of every surface is **untrusted input**. Agents may receive malicious instructions (prompt injection), produce invalid or adversarial arguments, attempt unauthorized operations, repeat calls, leak outputs into model context, act on stale state, trigger expensive operations, and misunderstand consequences. The framework's job is to make the blast radius of all of that small, visible, and attributable — never to assume it won't happen.

The trust boundary runs through the adapter:

```text
UNTRUSTED                                   TRUSTED (your process)
model output, tool args,   ||  adapter -> runtime -> policies -> middleware -> handler
external MCP clients,      ||        identity from authenticated
retrieved content          ||        transport credentials only
```

Everything left of the boundary can *request*; only things right of it can *decide*.

## Security invariants (SI-1 … SI-12)

The implementation must never violate these. Tests asserting each are part of the required test matrix ([implementation brief](../implementation/brief.md#security-invariants)).

- **SI-1 — Deny by default.** No capability is reachable on any surface without explicit `expose.<surface>: true`. Absent metadata, absent surface key, or `false` all deny.
- **SI-2 — Enforcement at execution time.** Discovery filtering and adapter tool lists are UX. Exposure, policies, middleware, and approvals are evaluated on **every** invocation regardless of what any client was shown.
- **SI-3 — The model is never the actor.** Actor identity derives from authenticated application credentials. Nothing a model writes — arguments, prompts, retrieved text — can create, change, or elevate identity.
- **SI-4 — No self-approval.** Approval decisions originate from trusted humans, deterministic policy, or external authorized systems. The approver must differ from the requesting actor (default-enforced). A model can at most *trigger* an approval flow; it cannot decide one.
- **SI-5 — Approval binds the exact operation.** Capability id + requesting actor + SHA-256 of canonical validated input. Any change → new approval. One execution per approval (atomic consumption).
- **SI-6 — What was validated is what executes.** No stage may mutate input after schema validation; policies cannot rewrite it (v0.1 has no rewrite mechanism by design).
- **SI-7 — Fail closed.** Policy errors and policy timeouts deny (`POLICY_FAILED`). Unresolvable state never resolves to allow.
- **SI-8 — Concealment.** Unknown, unexposed, and policy-hidden capabilities are externally indistinguishable (`CAPABILITY_NOT_FOUND` with identical shape). Audit records the true reason internally.
- **SI-9 — Internal details never reach models.** Only `publicMessage` of errors marked `exposeToModel` crosses the adapter boundary; `cause`, `stage`, stacks, and non-exposed messages do not.
- **SI-10 — No payloads in evidence by default.** Audit events and trace attributes carry hashes, ids, classifications, and durations — never raw inputs/outputs unless an application explicitly opts in through redaction hooks.
- **SI-11 — Writes are not auto-retried.** The runtime retries only `none`/`read` side effects, or writes that explicitly declare `idempotent: true` *and* a retry config. Model-initiated repetition is always a new execution, visibly distinct in audit.
- **SI-12 — Bounded execution.** Every execution carries a composed timeout + cancellation signal, propagated to the procedure and its downstream calls; each execution finalizes exactly one result envelope.

## Defense in depth: the five gates

A write operation initiated by a model passes five independent gates; compromising one leaves four:

```text
1. EXPOSURE      is the capability reachable on this surface at all?        (SI-1)
2. VALIDATION    is the input structurally legal?                           (SI-6)
3. POLICY        may this actor ask this, now, with this input?             (SI-7)
4. APPROVAL      does a trusted decision cover exactly this operation?      (SI-4, SI-5)
5. APPLICATION   middleware + handler authorization — the authoritative gate (ADR-008)
```

The framework *adds* gates 1–4 around gate 5; it never replaces gate 5. A capability is exactly as secure as its procedure when called by a hostile client — design procedures accordingly.

## What oRPC Agent does not claim

Stated plainly, because security tools that overclaim are dangerous:

- It does **not** solve prompt injection ([prompt-injection.md](prompt-injection.md) — it reduces impact, not occurrence).
- It does **not** provide exactly-once execution ([idempotency-and-retries.md](idempotency-and-retries.md)).
- It is **not** an authentication or authorization system — it requires yours.
- It does **not** sandbox procedure code; a handler that ignores its `signal` or leaks data in outputs defeats the corresponding controls.
- Defaults are conservative, but **no configuration of this framework makes an unsafe capability safe** — a `db.rawQuery` capability is unsafe at any setting.

## Residual risks that remain yours

| Risk | Your mitigation |
|---|---|
| Over-broad capabilities | Narrow verbs, strict schemas ([capabilities](../concepts/capabilities.md#granularity-guidance)) |
| Sensitive outputs entering model context | `redact.output`, minimal output schemas ([sensitive-data.md](sensitive-data.md)) |
| Approver fatigue (rubber-stamping) | Meaningful thresholds, readable `redact.approvalInput`, few but real approvals |
| Cost/abuse via legitimate calls | Rate limiting in middleware (Planned framework support: [open-questions](../open-questions.md#q9)) |
| Compromised application identity | Your session/token security — the framework trusts your authentication |

## Reading path

[authorization.md](authorization.md) → [prompt-injection.md](prompt-injection.md) → [sensitive-data.md](sensitive-data.md) → [idempotency-and-retries.md](idempotency-and-retries.md) → [threat-model.md](threat-model.md). Vulnerability reporting: [SECURITY.md](../../SECURITY.md).
