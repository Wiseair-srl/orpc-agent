# Errors

> **Status:** Design draft — v0.1 concepts. Contract tables live in [reference/errors.md](../reference/errors.md).

Error design is security design here. A stack trace that helps you debug also teaches a manipulated model your table names. oRPC Agent therefore separates every failure into a **model-safe face** and a **private diagnostic body**, and never lets adapters see the latter.

## The two-face principle

```ts
class CapabilityError extends Error {
  code: ErrorCode;            // stable, machine-readable
  stage: FailureStage;        // where the pipeline failed
  publicMessage: string;      // written for models and end users
  retryable: boolean;         // could an identical request succeed later?
  exposeToModel: boolean;     // may code+publicMessage cross the adapter boundary?
  details?: unknown;          // model-safe structured data (validation issues)
  cause?: unknown;            // the real error — logs only, never serialized outward
}
```

A model client can only ever receive two shapes: `{ code, message: publicMessage, retryable }` when `exposeToModel`, or the generic `{ code: "INTERNAL_ERROR", message: "The operation failed." }` otherwise (SI-9). Your logs get everything — `stage`, `cause`, stack — via audit events and tracing.

## Why stages matter

`stage` tells you *which guarantee failed* without reading a stack trace:

```text
discovery         -> the capability wasn't there (or must appear not to be)
input-validation  -> the model produced bad arguments (self-correctable)
authentication    -> no valid actor
authorization     -> app middleware said no
policy            -> governance said no (or a policy itself broke: POLICY_FAILED)
approval          -> the approval lifecycle interrupted or refused
execution         -> business logic failed
output-validation -> the handler broke its own contract
timeout / cancellation -> bounded execution fired
adapter           -> protocol translation failed
```

Monitoring by stage is more useful than by message: a spike in `policy` denials is a prompt or UX problem; a spike in `output-validation` is your bug; a spike in `discovery` may be a probing client.

## Designed feedback for models

Models retry and rephrase based on what they read, so each error class is tuned:

- **`INPUT_INVALID`** exposes issue paths and messages in `details` — the model produced the input; echoing structure back lets it self-correct in the next step. Values are not echoed.
- **`POLICY_DENIED`** carries the policy's message — write it as an instruction ("Refunds above $500 require manager approval") so the model does the right next thing instead of retrying blindly.
- **Declared oRPC errors** (`.errors()` / `errors.NOT_ELIGIBLE()`) are contract: exposed with their message. **Undeclared throws** are internals: concealed. The line between "safe to show" and not is exactly the line you already draw when declaring typed errors ([reference/errors.md](../reference/errors.md#relationship-to-orpc-errors)).
- **Concealment class**: unknown id, unexposed surface, and policy `hide` all present as identical `CAPABILITY_NOT_FOUND` (SI-8) — a probing client learns nothing; your audit log records the truth.
- **`retryable`** is honest advice: `TIMEOUT` yes, `POLICY_DENIED` no. Models that respect it save tokens; the runtime's own retry logic uses it under stricter side-effect rules (SI-11).

## Failure after effect

A stage-12 (`OUTPUT_INVALID`) or stage-13 failure happens *after* the procedure ran: side effects may exist even though the caller sees failure. The runtime cannot un-run your handler; it reports honestly instead — the audit event carries `executedBeforeFailure: true`, and the output is withheld from the model (a value that violates its own contract must not be reasoned over). Idempotency design for this window: [security/idempotency-and-retries.md](../security/idempotency-and-retries.md).

## Handling results without exceptions

The runtime returns envelopes; errors are values until you choose otherwise:

```ts
const result = await runtime.invoke("orders.refund", input, { actor, context });
if (result.status === "failed" && result.error.code === "POLICY_DENIED") {
  // deterministic handling, typed access
}

// direct-call convenience: throw instead
const output = unwrap(result);   // throws CapabilityError, incl. APPROVAL_REQUIRED for suspensions
```

Adapters never `unwrap` — they translate all four statuses deterministically ([adapter model](../architecture/adapter-model.md#result-translation)).

## Related

- Contract: [reference/errors.md](../reference/errors.md) · Serialization per adapter: [ai-sdk](../adapters/ai-sdk.md#result-shape), [mcp](../adapters/mcp.md#result-shape)
- Sensitive data rules: [security/sensitive-data.md](../security/sensitive-data.md)
