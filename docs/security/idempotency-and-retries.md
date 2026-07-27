# Idempotency and retries

> **Status:** Implemented in v0.1 — v0.1 semantics. This page states guarantees precisely, including the ones the framework does **not** make.

## What the framework guarantees — and what it doesn't

| Guarantee | Status |
|---|---|
| At-most-once *result finalization* per execution (one envelope, SI-12) | ✅ Guaranteed |
| No runtime-initiated retry of `write`/`destructive`/`external` without explicit opt-in (SI-11) | ✅ Guaranteed |
| Approval executes at most once (atomic consumption, SI-5) | ✅ Guaranteed (within one coordinator) |
| Distinguishable runtime retries vs model re-invocations in audit | ✅ Guaranteed |
| Stable `idempotencyKey` available to handlers per execution | ✅ Guaranteed |
| Exactly-once *effect* execution | ❌ **Not provided. Not claimed.** |
| Cross-invocation deduplication ("the model called refund twice") | ❌ Application responsibility (key provided, storage yours) |

Exactly-once effects are impossible for a library that doesn't own your datastore and your downstream services: a timeout after the payment gateway accepted the charge is a fact the runtime cannot un-happen. What the design does instead is (a) never *create* duplicate attempts for non-idempotent work, and (b) give handlers the key material to deduplicate where the effect lives.

## Runtime retries

Runtime-managed retries wrap **pipeline stage 11 only** (the procedure call). All conditions must hold:

```text
meta.retry.maxAttempts > 0
AND error.retryable === true            (TIMEOUT, retryable EXECUTION_FAILED, ...)
AND ( sideEffect ∈ { "none", "read" }
      OR (idempotent === true AND retry explicitly configured) )
AND meta.retry.retryOn?.(error) !== false
```

Defaults: **zero retries for everything.** Reads opt in with one line; writes opt in only by *also* declaring `idempotent: true` — a reviewable claim that repeating the call with identical input is safe because the handler deduplicates. Destructive/external operations follow the same rule; the registry rejects `retry` config without the `idempotent` declaration for all three write-like classes ([reference/metadata.md](../reference/metadata.md#validation-at-registry-build)).

Retry mechanics: exponential backoff from `backoffMs` (default 250), same `executionId`, `capability.retried` event per re-attempt with the previous error code, attempt count on the final event. Approval is **not** re-requested between attempts — the consumed record covers the execution it authorized, retries included. The execution timeout arms per attempt (so a timed-out *read* with retry config genuinely retries under a fresh timer); the caller's cancellation signal spans the whole execution and is always terminal ([ADR-012](../architecture/decisions.md#adr-012-as-built-api-deltas-for-v01)).

## Retry vs replay vs re-invocation (terminology that prevents incidents)

- **Runtime retry** — same execution, same `executionId`, runtime-initiated, bounded by `maxAttempts`. Invisible to the model.
- **Model re-invocation** — the model calls the tool again (impatience, steering, loop bugs). A **new** execution and audit trail; policies and approvals run afresh. The framework never suppresses it silently — that's deduplication, below.
- **Replay** — a workflow engine re-running step code for determinism (future `workflow` surface). Engines replay *orchestration*; the capability call must still execute effects once — which is precisely what engine-level step memoization plus handler idempotency provide. Core takes no position beyond providing stable keys ([ADR-007](../architecture/decisions.md#adr-007-durable-execution-is-adapter-based)).

## Handler-level idempotency (the part that's yours)

The runtime injects `context.agent.idempotencyKey` — stable across runtime retries of one execution, unique across executions. Use it where the effect lives:

```ts
export const refundOrder = agentBase
  .meta({ agent: { sideEffect: "write", idempotent: true, retry: { maxAttempts: 1 }, /* ... */ } })
  .input(RefundInput).output(RefundResult)
  .handler(async ({ input, context, signal }) => {
    // Downstream dedup: gateway treats the key as an idempotency token
    return context.payments.refund(input, {
      idempotencyKey: context.agent!.idempotencyKey,
      signal,
    });
  });
```

For **cross-invocation** deduplication (the model legitimately must not refund the same order twice, ever), the key is business state, not plumbing: check `orders.refunds` in the handler and throw a declared `ALREADY_REFUNDED` error. That rule survives every client, not just agents — which is why it belongs in the procedure, not in a policy.

## Timeouts and cancellation

Every execution runs under one composed `AbortSignal`: caller signal (adapter/protocol cancellation) + capability timeout (`meta.timeoutMs` ?? 30 000 ms). Propagation chain and obligations:

```text
adapter signal ──┐
                 ├─> composite signal ─> oRPC call ─> handler ─> fetch/DB/downstream
timeout timer ───┘
```

- The **runtime** guarantees the signal reaches the handler and that the result is finalized once: `TIMEOUT` (stage `timeout`, retryable) or `CANCELLED` (stage `cancellation`, not retryable — the caller left).
- The **handler** must forward `signal` to downstream calls; a handler that ignores it turns "bounded execution" into "bounded reporting". This is stated everywhere handlers are taught, and the reference app models it.
- After abort, the runtime does not consume the output of a late-finishing handler; effects that completed downstream are the idempotency problem above — one more reason `TIMEOUT` is retryable *only* for reads by default.

## Related

- [security-model.md](security-model.md) (SI-5, SI-11, SI-12) · [reference/metadata.md](../reference/metadata.md#retry--idempotent) · [concepts/approvals.md](../concepts/approvals.md)
