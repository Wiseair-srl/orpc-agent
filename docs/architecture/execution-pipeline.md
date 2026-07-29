# Execution pipeline

> **Status:** Stable — 1.0 — the normative specification for the runtime. The implementation must follow the stage ordering and semantics defined here.

This document specifies the canonical lifecycle of every capability invocation. Other documents cite these stages by number ("stage 7"). Do not reorder stages in the implementation without an ADR.

Two pipelines exist: **discovery** (`runtime.describe`) and **invocation** (`runtime.invoke` / `runtime.resume`). They share policy machinery but differ in inputs and outputs.

## Invocation pipeline

```text
 1. adapter: authenticate transport, build actor + context, call invoke(surface fixed)
 2. runtime: executionId, span agent.capability_call, emit capability.requested
 3. resolve capability id ................................. miss -> CAPABILITY_NOT_FOUND
 4. exposure check for surface ........................... fail -> CAPABILITY_NOT_FOUND (concealed)
 5. input validation (Standard Schema) ................... fail -> INPUT_INVALID
 6. actor check .......................................... fail -> UNAUTHENTICATED
 7. invocation-phase policies ............................ deny/hide -> POLICY_DENIED / concealed
 8. approval gate ........................................ pending -> return "approval-required"
    (resume re-enters here: verify record, mark consumed)
 9. execution-phase policies ............................. deny -> POLICY_DENIED
10. attach controls: composite AbortSignal (timeout + caller signal); emit capability.started
11. procedure invocation via oRPC call — middleware chain + handler; retry loop wraps this stage
12. output validation .................................... fail -> OUTPUT_INVALID
13. output redaction (meta.redact.output)
14. emit capability.completed; end span ok
15. return { status: "completed", output }
```

Any failure at any stage is normalized to a `CapabilityError`, emits the matching terminal audit event (`capability.denied`, `capability.failed`, or `capability.cancelled`), ends the span with error status, and returns a `failed` or `cancelled` envelope. `runtime.invoke` **never throws for governed failures** — it returns an `ExecutionResult` ([reference/runtime.md](../reference/runtime.md)).

### Stage 1 — Adapter entry

The adapter (AI SDK tool `execute`, MCP `tools/call` handler, a workflow step, or direct server code) is responsible for:

- authenticating the transport (session cookie, OAuth token, service credential);
- constructing the `Actor` from that authenticated identity — never from model output (SI-3);
- constructing the application `context` (the same context type the app's oRPC procedures expect);
- fixing the `surface` value (`"aiSdk"`, `"mcp"`, `"direct"`, `"workflow"`, `"test"`) — callers cannot spoof another adapter's surface because each adapter hardcodes its own.

Rationale for position: authentication is application-owned and protocol-specific; the runtime cannot do it portably, so it happens before the runtime is entered. The runtime *verifies presence and shape* of the actor later (stage 6) as a backstop.

### Stage 2 — Execution identity

The runtime assigns a unique `executionId` (used in audit events, trace attributes, `ctx.agent`, and the idempotency key), opens the root span `agent.capability_call`, and emits `capability.requested`. This happens before resolution so that even requests for unknown capabilities are auditable — probing for hidden capabilities is itself a signal worth recording.

### Stage 3 — Capability resolution

The id (`"orders.refund"`) is looked up in the registry. A miss produces `CAPABILITY_NOT_FOUND` (stage `discovery`, `exposeToModel: true`).

### Stage 4 — Exposure check

The capability's `meta.expose[surface]` must be exactly `true`. Anything else — `false`, absent — denies (SI-1). Externally this is indistinguishable from a missing capability: same code `CAPABILITY_NOT_FOUND`, same public message (SI-8). The audit event `capability.denied` records the true reason (`"not-exposed"`).

Rationale for position: exposure is a static property; checking it before validation avoids leaking, via validation error messages, the existence of a capability the surface should not see.

### Stage 5 — Input validation

The raw input is validated with the procedure's input schema via the Standard Schema interface (`~standard.validate`). Failure produces `INPUT_INVALID` (stage `input-validation`, `retryable: false`, `exposeToModel: true`) with issue paths and messages summarized in `details` — the model sent the input, so echoing issue paths back is safe and lets it self-correct.

The validated (parsed, defaulted, coerced) value — not the raw value — is what every later stage sees (SI-6). Policies receive it, approval hashes bind it, and the procedure executes it.

Rationale for position: validation precedes policies so policies can rely on typed, constrained input, and precedes approval so approvals bind a canonical value.

### Stage 6 — Actor check

The runtime asserts an `Actor` is present and well-formed (`id`, `kind`). A missing actor is `UNAUTHENTICATED` (stage `authentication`). Anonymous access is modeled explicitly with `kind: "anonymous"`, never by omitting the actor.

This is deliberately *after* input validation: validation errors are cheaper to produce and carry no authorization information, so ordering them first leaks nothing and gives better model feedback. Applications that consider input shapes sensitive can rely on the exposure check (stage 4) having already gated visibility.

### Stage 7 — Invocation-phase policies

All configured policies run: first the runtime-level `policies` array in order, then the capability's `meta.policies` in order. Every policy is evaluated — no short-circuiting — so the audit record contains each policy's stance. Decisions combine with precedence:

```text
deny  >  hide  >  require-approval  >  allow
```

- Any `deny` → `POLICY_DENIED` (public message from the decision, or a generic one).
- Any `hide` (with no deny) → concealed denial: external `CAPABILITY_NOT_FOUND`, audited as `"hidden"`.
- Any `require-approval` (with no deny/hide) → proceed to stage 8 with the merged approval requirement.
- A policy that throws or exceeds `defaults.policyTimeoutMs` fails closed: `POLICY_FAILED`, treated as deny (SI-7).

Multiple `require-approval` decisions merge into **one** approval request (all reasons, all types, the minimum expiry). Policy semantics are fully specified in [concepts/policies.md](../concepts/policies.md).

### Stage 8 — Approval gate

Approval is required when stage 7 produced `require-approval` or `meta.approval.required` is `true`. The runtime:

1. Serializes the validated input to canonical JSON (sorted keys) and hashes it (SHA-256). Unserializable input fails with `APPROVAL_UNSERIALIZABLE_INPUT`.
2. Creates an `ApprovalRequest` via the configured coordinator, storing input, hash, actor, capability id, reasons, risk, side effect, and expiry.
3. Emits `capability.approval_requested`, ends the span with status ok (the execution is suspended, not failed), and returns `{ status: "approval-required", approval }`.

If an **inline approval handler** is configured instead of a coordinator, the runtime awaits it here and continues or fails in the same call ([concepts/approvals.md](../concepts/approvals.md)).

**Resumption** re-enters the pipeline at this stage. `runtime.resume(approvalId, { context })`:

1. Loads the record; verifies `status === "approved"`, not expired, not consumed, and that the approver differs from the requesting actor (SI-4, unless `rejectSelfApproval: false`).
2. Re-hashes the stored input and compares with the stored hash — mismatch is `APPROVAL_INPUT_MISMATCH` (SI-5).
3. Re-validates the stored input against the *current* schema (the deploy may have changed since approval).
4. Marks the record consumed atomically (`markConsumed`) so an approval executes at most once.
5. Opens a **new** execution (new `executionId`, linked to the approval id in events) and continues at stage 9, running as the **original actor**, with the approver recorded in `ctx.agent.approval`.

Failure codes on resume: `APPROVAL_PENDING`, `APPROVAL_REJECTED`, `APPROVAL_EXPIRED`, `APPROVAL_CONSUMED`, `APPROVAL_INPUT_MISMATCH`, `APPROVAL_SELF_APPROVAL`.

### Stage 9 — Execution-phase policies

Only policies that declared `phases: ["execution"]` (or included it) run here. Their purpose is freshness: between approval request and resumption, hours may pass — membership, limits, and record state may have changed. In a no-approval flow these policies run immediately after stage 7; policies default to `["invocation"]` so nothing runs twice unless it opted in.

### Stage 10 — Controls

The runtime composes an `AbortSignal` from the caller's signal and a timer of `meta.timeoutMs ?? defaults.timeoutMs` (default 30 000 ms), then emits `capability.started`. With `audit: { strict: true }`, this emission is awaited and a sink failure aborts with `AUDIT_UNAVAILABLE` — for deployments where "no audit record, no execution" is a compliance requirement. Default is best-effort emission.

### Stage 11 — Procedure invocation

The runtime invokes the underlying procedure with oRPC's server-side call utilities, passing:

- `context`: the application context supplied by the adapter, extended with `agent: AgentInvocationInfo` (`executionId`, `capabilityId`, `surface`, `actor`, `approval?`, `correlationId?`, `idempotencyKey`);
- `signal`: the composite abort signal, which oRPC forwards to the handler.

**This is where the application's oRPC middleware chain runs — unchanged and authoritative** (ADR-008). Authentication guards, organization scoping, permission checks, and context enrichment written for the rest of the app execute exactly as they do for HTTP traffic, immediately before the handler. Policies never replace them; policies decide whether the agent may *ask*, middleware decides whether the operation may *happen*.

Error mapping from this stage:

- oRPC type-safe errors (declared via `.errors()` and thrown as `errors.X()`) → `EXECUTION_FAILED`, `exposeToModel: true`, public message from the error — these are intentional, contract-level failures the model may act on.
- `ORPCError` with code `UNAUTHORIZED` → `UNAUTHENTICATED` (stage `authentication`); `FORBIDDEN` → `FORBIDDEN` (stage `authorization`).
- Any other thrown value → `EXECUTION_FAILED`, `exposeToModel: false`, public message `"The operation failed."`, original error preserved in `cause` (SI-9).
- Abort due to timeout → `TIMEOUT` (stage `timeout`); abort due to caller cancellation → `CANCELLED` (stage `cancellation`). Both return the `cancelled` envelope.

**Retry loop.** Runtime-managed retries wrap stage 11 only. Eligibility (SI-11): `meta.retry.maxAttempts > 0` **and** the error is `retryable` **and** (`sideEffect` is `"none"`/`"read"`, or `idempotent: true` was explicitly declared). Each re-attempt emits `capability.retried` with the attempt number and reuses the same `executionId` — distinguishing runtime retries from a model calling the tool again, which is a new execution. Details: [security/idempotency-and-retries.md](../security/idempotency-and-retries.md).

### Stage 12 — Output validation

The handler's return value is validated against the output schema. Failure is `OUTPUT_INVALID` (stage `output-validation`, `exposeToModel: false`) and the output is withheld — an output that violates its own contract must not reach a model.

### Stage 13 — Redaction

`meta.redact.output`, when defined, maps the validated output to its model-safe form (drop internal ids, mask PII). Redaction happens after validation — the contract is checked on the true output — and before any adapter serialization or trace attribute (SI-10).

### Stages 14–15 — Completion

`capability.completed` is emitted with duration and attempt count (never payloads), the span ends with ok status, and the `completed` envelope returns to the adapter, which serializes it for its protocol.

## Discovery pipeline (`runtime.describe`)

```text
1. surface fixed by caller
2. exposure filter: meta.expose[surface] === true
3. discovery-phase policies per candidate (input is undefined):
     deny/hide  -> excluded (indistinguishable from nonexistent)
     require-approval -> included, descriptor.requiresApproval = true
     policy error -> excluded (fail closed)
4. build CapabilityDescriptor: { id, description, inputSchema (JSON Schema),
   sideEffect, risk, tags, requiresApproval? }   — no output schema by default
5. emit capabilities.discovered (capabilityIds only)
6. return descriptors
```

Discovery output is deliberately minimal: models get what they need to call correctly and nothing else. Adapters convert descriptors to protocol shapes (AI SDK tool definitions, MCP tool listings).

## Which stages emit events

| Stage | Events |
|---|---|
| 2 | `capability.requested` |
| 3, 4, 7 (deny/hide) | `capability.denied` |
| 8 | `capability.approval_requested`; coordinator decisions emit `capability.approved` / `capability.rejected` |
| 10 | `capability.started` |
| 11 (re-attempt) | `capability.retried` |
| 14 / failure / abort | `capability.completed` / `capability.failed` / `capability.cancelled` |
| describe | `capabilities.discovered` |

## Which stages can short-circuit

Stages 3–10 each terminate the pipeline on failure. Stage 7 evaluates *all* policies before combining (auditability) but the combined result can terminate. Stage 8 suspends rather than terminates. Stages 11–13 terminate on failure. Nothing after stage 11 can un-run the procedure: a stage-12/13 failure reports failure even though side effects may have occurred — the audit event notes `executedBeforeFailure: true`.

## Data visibility per stage

| Data | 3–4 | 5 | 6–9 | 11 | 12–13 | adapter |
|---|---|---|---|---|---|---|
| raw input | – | ✓ | – | – | – | ✓ (received it) |
| validated input | – | produced | ✓ | ✓ | – | – |
| actor / context | ✓ | ✓ | ✓ | ✓ (as ctx) | – | ✓ (built it) |
| raw output | – | – | – | produced | ✓ | – |
| redacted output | – | – | – | – | produced | ✓ |

Policies never see raw (pre-validation) input. Adapters never see unredacted output.

## Why this ordering (summary)

- **Exposure before validation** — existence concealment beats helpful errors for unexposed capabilities.
- **Validation before policies** — policies reason over typed, canonical input; approval binds the value that will execute.
- **Policies before middleware** — the governance layer answers "may the agent ask this at all" cheaply, before the app spends work; middleware stays the last, authoritative word directly before the handler.
- **Approval before execution-phase policies** — execution-phase policies exist precisely to re-check the world after approval latency.
- **Output validation before redaction** — the contract is verified against the true output; redaction shapes only what leaves the trust boundary.
