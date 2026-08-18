# Reference: errors

> Codes are stable: additions allowed, meanings never repurposed. Looking one up because you just saw it? [Troubleshooting](../guides/troubleshooting.md) is indexed by symptom.

Package: `@orpc-agent/core`. Concepts and rationale: [concepts/errors.md](../concepts/errors.md).

## `CapabilityError`

```ts
class CapabilityError extends Error {
  readonly code: ErrorCode;          // stable machine-readable identifier
  readonly stage: FailureStage;      // where in the pipeline it failed
  readonly publicMessage: string;    // model-safe; the ONLY message adapters may forward
  readonly retryable: boolean;       // may an identical request succeed later?
  readonly exposeToModel: boolean;   // gate for code+publicMessage vs generic shape
  readonly details?: unknown;        // model-safe structured data (e.g. validation issues)
  readonly cause?: unknown;          // private diagnostic; NEVER serialized outward
}
```

`message` (inherited) equals `publicMessage` plus code — safe to log. `cause` carries the original thrown error for server-side logs only (SI-9).

```ts
type FailureStage =
  | "discovery" | "input-validation" | "authentication" | "authorization"
  | "policy" | "approval" | "execution" | "output-validation"
  | "timeout" | "cancellation" | "adapter";
```

## Error codes

| Code | Stage | Retryable | exposeToModel | Produced when |
|---|---|---|---|---|
| `CAPABILITY_NOT_FOUND` | discovery | no | yes | Unknown id, unexposed surface, or hidden by policy — externally indistinguishable (SI-8) |
| `INPUT_INVALID` | input-validation | no | yes | Input fails the input schema; `details` carries issue paths/messages |
| `UNAUTHENTICATED` | authentication | no | yes | Missing/malformed actor, or oRPC `UNAUTHORIZED` from middleware |
| `FORBIDDEN` | authorization | no | yes | oRPC `FORBIDDEN` from middleware / app authorization |
| `POLICY_DENIED` | policy | no | yes | A policy returned `deny`; public message from the decision |
| `POLICY_FAILED` | policy | no | no | A policy threw or timed out — fail closed (SI-7) |
| `APPROVAL_REQUIRED` | approval | no | yes | Only via `unwrap()`/adapter translation of the `approval-required` envelope |
| `APPROVAL_PENDING` | approval | yes | yes | `resume()` before a decision exists |
| `APPROVAL_REJECTED` | approval | no | yes | Resume after rejection |
| `APPROVAL_EXPIRED` | approval | no | yes | Resume after expiry; a new request is needed |
| `APPROVAL_CONSUMED` | approval | no | yes | Resume of an already-executed approval (single-use, SI-5) |
| `APPROVAL_INPUT_MISMATCH` | approval | no | no | Stored input no longer matches its hash — integrity failure |
| `APPROVAL_SELF_APPROVAL` | approval | no | yes | Approver identity equals requester (SI-4) |
| `APPROVAL_UNSERIALIZABLE_INPUT` | approval | no | no | Approval required but validated input not canonically serializable |
| `APPROVAL_RESUME_MISMATCH` | approval | no | no | `resume()` with `expectedActor`/`expectedSurface` guards that don't match the record — concealed like an unknown id (SI-8); audit gets the real code |
| `EXECUTION_FAILED` | execution | varies | varies | Handler threw. oRPC type-safe errors: exposeToModel=true with their message. Unexpected throws: exposeToModel=false, generic public message |
| `OUTPUT_INVALID` | output-validation | no | no | Handler output violates output schema; output withheld |
| `TIMEOUT` | timeout | yes | yes | Composite signal fired from the timeout timer |
| `CANCELLED` | cancellation | no | yes | Composite signal fired from the caller's signal |
| `AUDIT_UNAVAILABLE` | execution | yes | no | `audit.strict` and the `capability.started` sink write failed |
| `ADAPTER_ERROR` | adapter | no | no | Protocol translation failure inside an adapter |
| `INTERNAL_ERROR` | (any) | no | — | Runtime invariant violation; also the generic *serialized shape* for any non-exposed error |

Notes:
- `retryable` describes whether an **identical** request could succeed later; it feeds runtime retry eligibility and the model-visible flag. `EXECUTION_FAILED` retryability comes from the thrown error when it is a `CapabilityError`, else `false`.
- `TIMEOUT` is retryable but still subject to SI-11: the runtime will not auto-retry a timed-out write.

## Adapter serialization

The only two shapes a model client can ever receive:

```jsonc
// exposeToModel === true
{ "code": "POLICY_DENIED", "message": "Refunds above $500 require manager approval.", "retryable": false }

// exposeToModel === false — regardless of the real code
{ "code": "INTERNAL_ERROR", "message": "The operation failed.", "retryable": false }
```

`details` is included only for `INPUT_INVALID` (validation issues) — it is data the model itself produced. `stage`, `cause`, and stack traces never cross the adapter boundary (SI-9). Full model-visible mapping per adapter: [adapters/ai-sdk.md](../adapters/ai-sdk.md#result-shape), [adapters/mcp.md](../adapters/mcp.md#result-shape).

## Relationship to oRPC errors

Inside a handler you keep using oRPC's error system (`.errors()`, `errors.NOT_ELIGIBLE()`, `ORPCError`). The runtime maps them at the boundary (pipeline stage 11):

| Thrown in procedure | Becomes |
|---|---|
| Type-safe error from `.errors()` | `EXECUTION_FAILED`, exposeToModel=true, its message as `publicMessage` |
| `ORPCError("UNAUTHORIZED")` | `UNAUTHENTICATED` (stage authentication) |
| `ORPCError("FORBIDDEN")` | `FORBIDDEN` (stage authorization) |
| Other `ORPCError` | `EXECUTION_FAILED`, exposeToModel=true, message preserved |
| Any other throw | `EXECUTION_FAILED`, exposeToModel=false, cause preserved privately |

Design intent: errors you *declared* are contract, safe for models to see and react to; errors you didn't are internals.
