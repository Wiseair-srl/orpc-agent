# Guide: adding policies

> **Status:** Implemented in v0.1. Semantics: [concepts/policies.md](../concepts/policies.md). This guide is the practical path: which policy to write, where to attach it, how to keep it testable.

## Start from the sentence

Every policy worth writing is a sentence with an actor, a condition, and a consequence:

> "Refunds **above $500** require **manager approval**."
> "**Automations** may never run **destructive** capabilities."
> "Over **MCP**, only **reads** are available."
> "Actors outside the order's **organization** must not know `orders.*` exists."

If the sentence holds for *every caller* (not just agents), stop — that's middleware, not a policy ([the boundary](../concepts/policies.md#policies-vs-middleware-the-boundary-that-matters)).

## Write it as a pure function

```ts
// src/policies/refund-limit.ts
import { definePolicy, allow, requireApproval, deny } from "@orpc-agent/core";

export const refundLimit = definePolicy("refund-limit", ({ capability, input }) => {
  if (capability.id !== "orders.refund") return allow();
  const { amount } = input as { amount: number };
  if (amount >= 5000) return deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.");
  if (amount > 500)  return requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager" });
  return allow();
});
```

Habits that pay off:

- **Name policies like log lines** — the `name` lands in every audit record's `policyDecisions`.
- **Target classifications, not id lists**, when the rule is general: `capability.meta.sideEffect === "destructive"` survives new capabilities; `["orders.refund", "orders.cancel", ...]` rots.
- **Default to `allow()` explicitly** at the end — a policy that falls through to `undefined` is a bug the runtime treats as `POLICY_FAILED` (deny, SI-7), which is safe but noisy.
- **Type your context once**: write a tiny `appPolicy` helper that casts `context` to `AppContext` so every policy body stays clean.

## Choose the phase deliberately

| You want | Phase |
|---|---|
| The main gate (almost everything) | `["invocation"]` — the default |
| Hide from listings too | `["discovery", "invocation"]` |
| Re-check after approval latency | `["invocation", "execution"]` |

```ts
export const membershipFresh = definePolicy(
  "membership-fresh",
  async ({ actor, context }) => (await (context as AppContext).members.isActive(actor.id))
    ? allow()
    : deny("MEMBERSHIP_INACTIVE", "Your access has changed. Contact an administrator."),
  { phases: ["invocation", "execution"] },   // runs again at resume time
);
```

Remember discovery calls carry `input: undefined` — guard input access by phase.

## Attach at the right level

```ts
// Runtime-level: cross-cutting rules, evaluated first, in array order
const runtime = createAgentRuntime({
  registry: capabilities,
  policies: [orgIsolation, surfaceRules, destructiveNeedsApproval],
});

// Capability-level: rules that belong to one operation, next to its definition
.meta({ agent: { policies: [refundLimit], /* ... */ } })
```

Ordering within a level is yours; across levels runtime-first. Since **all** policies evaluate and deny wins regardless of position (no short-circuit), order affects audit readability more than outcomes — group related rules and keep the list short enough to read aloud.

**Put a runtime policy under the drift gate.** A conditional approval gate registered here is invisible to a snapshot taken over a bare registry: delete it and every capability field stays byte-identical while the gate is gone. [`orpc-agent`](../reference/cli.md) records `runtime.policies` when `--entry` resolves an [`AgentRuntime`](../reference/runtime.md), and classifies a removal as *widening*. If the serving runtime is built inside a factory, export a module-scope one spread from the same policy constant — construction is pure, so it costs nothing ([ADR-016](../architecture/decisions.md#adr-016-runtime-policies-are-part-of-the-governance-contract)).

The tool records that a policy exists, never what it decides. Which capabilities it gates depends on actor, surface, input and context, and is only knowable by evaluating it.

## Compose reusable sets

```ts
import { composePolicies } from "@orpc-agent/core";

export const baselineGovernance = composePolicies(
  orgIsolation,
  mcpReadOnly,
  destructiveNeedsApproval,
);
// createAgentRuntime({ policies: [baselineGovernance, ...appSpecific] })
```

Composition preserves per-policy identity in audit records — a composed set is packaging, not a black box.

## Test before wiring

Policies are pure — test the function, then the wiring:

```ts
// Unit: the function
expect(refundLimit.evaluate(reqWith({ amount: 400 }))).toEqual(allow());
expect(refundLimit.evaluate(reqWith({ amount: 700 })).type).toBe("require-approval");

// Wired: precedence, fail-closed, audit
const t = createAgentTestRuntime({ registry, policies: [refundLimit] });
const r = await t.invoke("orders.refund", { orderId: "o1", amount: 700, reason: "x" });
expect(r.status).toBe("approval-required");
expect(t.audit.ofType("capability.approval_requested")).toHaveLength(1);
```

Full patterns: [testing-capabilities.md](testing-capabilities.md).

## Pitfalls

- **Slow policies tax every call.** A policy awaiting an uncached HTTP call adds that latency to *all* invocations. Precompute into context, or move the check into middleware where it already lives.
- **Nondeterminism** (clock/randomness inside the function) makes audit records unexplainable — inject time via context if a rule is time-based.
- **Rewriting input is not available** (SI-6): clamp-style rules become `deny` with a message telling the model the legal range — the model adjusts and retries; nothing silently executed something the model didn't ask for.
- **Policy sprawl**: if every capability grows bespoke policies, push the recurring ones into classifications (`risk`, `tags`) + one classification-driven policy.
