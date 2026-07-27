# Policies

> **Status:** Implemented in v0.1 — v0.1 concepts and normative policy semantics. APIs shown are the as-built v0.1 surface.

A **policy** is a deterministic function that evaluates an execution request and returns one of four decisions. Policies are the governance layer's programmable part — small, composable, auditable — and deliberately *not* a general plugin system.

```ts
import { definePolicy, allow, deny, hide, requireApproval } from "@orpc-agent/core";

export const refundLimit = definePolicy("refund-limit", ({ capability, input }) => {
  if (capability.id !== "orders.refund") return allow();
  const { amount } = input as { amount: number };
  if (amount >= 5000) return deny("REFUND_TOO_LARGE", "Refunds of $5000 or more cannot be issued by agents.");
  if (amount > 500)  return requireApproval({ reason: `Refund of $${amount} exceeds $500`, approvalType: "manager" });
  return allow();
});
```

## The four decisions

| Decision | Effect | Typical use |
|---|---|---|
| `allow(metadata?)` | Proceed; metadata lands in the audit record | Default stance; annotate why |
| `deny(code?, message?)` | Stop with `POLICY_DENIED`; `message` is model-visible | Hard business limits |
| `hide()` | At discovery: exclude from listings. Elsewhere: concealing deny (`CAPABILITY_NOT_FOUND`) | Existence itself is sensitive (SI-8) |
| `requireApproval({ reason, approvalType?, expiresInMs? })` | Gate at pipeline stage 8 | Thresholds, sensitive targets |

`deny` vs `hide`: deny admits the capability exists ("you can't"); hide does not ("there is no such thing"). Choose hide when knowing the capability exists leaks information.

## Phases

```ts
type PolicyPhase = "discovery" | "invocation" | "execution";
definePolicy(name, evaluate, { phases: ["invocation", "execution"] });  // default: ["invocation"]
```

- **discovery** — during `describe`; `input` is `undefined`. `hide`/`deny` exclude from the listing; `require-approval` annotates the descriptor (`requiresApproval: true`) so adapters can hint the model.
- **invocation** — pipeline stage 7, with validated input. The main gate.
- **execution** — pipeline stage 9. Runs at approval *resumption* (and, for opted-in policies, right before the procedure call). Exists because hours may pass between "may ask" and "may run": re-check membership, limits, record state. Policies default to invocation-only, so nothing evaluates twice unless it opted in.

This phase model implements the discovery / invocation / execution separation of [ADR-005](../architecture/decisions.md#adr-005-discovery-and-execution-authorization-are-separate).

## Evaluation and composition semantics (normative)

1. **Order.** Runtime-level `policies` array in declaration order, then the capability's `meta.policies` in order.
2. **All policies evaluate.** No short-circuiting on the first deny — the audit record captures every policy's stance (`policyDecisions`), which is worth the marginal cost of evaluating deterministic functions.
3. **Precedence.** `deny` > `hide` > `require-approval` > `allow`. Deny always wins; conservative conflict resolution.
4. **Approval merging.** Multiple `require-approval` decisions merge into **one** approval request: all reasons, all types, the minimum expiry. One human decision satisfies the merged requirement; if your domain needs two *distinct* sign-offs, model it as a policy that inspects `approval` metadata and re-requires (documented pattern, v0.1 keeps single-request semantics).
5. **Fail closed.** A policy that throws, rejects, or exceeds `defaults.policyTimeoutMs` produces `POLICY_FAILED`, treated as deny (SI-7). Never fail open.
6. **No input rewriting.** Policies cannot modify the validated input (SI-6). A "safe rewrite" mechanism (e.g., clamping limits) is deliberately absent from v0.1 — silent mutation of what the model asked for is a debugging and audit nightmare; deny with a clear message instead ([open-questions](../open-questions.md#q6)).
7. **Determinism expectation.** Same request + same context ⇒ same decision. Read from `actor`/`context`/`input`; avoid clocks (inject via context if time matters), randomness, and network calls. Async is permitted (a membership lookup against a request-scoped loader is fine) but slow or flaky policies degrade every invocation — heavyweight authorization belongs in middleware or precomputed context.

## What policies see

```ts
type PolicyRequest = {
  phase: PolicyPhase;
  capability: { id: string; meta: AgentMeta };   // classifications to target: sideEffect, risk, tags
  surface: ExposureSurface;
  actor: Actor;
  context: unknown;                              // your app context (type it in your own helpers)
  input?: unknown;                               // validated; undefined at discovery
  approval?: ApprovalRecord;                     // present on resumed executions
};
```

Patterns that compose well:

```ts
// Target by classification, not by id list
const destructiveNeedsApproval = definePolicy("destructive-approval", ({ capability }) =>
  capability.meta.sideEffect === "destructive"
    ? requireApproval({ reason: "Destructive operation", approvalType: "manager" })
    : allow());

// Surface-aware tightening
const mcpReadOnly = definePolicy("mcp-read-only", ({ surface, capability }) =>
  surface === "mcp" && capability.meta.sideEffect !== "read" && capability.meta.sideEffect !== "none"
    ? deny("MCP_READ_ONLY", "Write operations are not available over MCP.")
    : allow());

// Tenancy backstop (middleware remains authoritative; this is defense in depth)
const orgIsolation = definePolicy("org-isolation", ({ actor, context }) => {
  const ctx = context as AppContext;
  return actor.attributes?.orgId === ctx.organizationId
    ? allow()
    : deny("ORG_MISMATCH", "Operation not available for this organization.");
});
```

## Policies vs middleware (the boundary that matters)

| | Policies | oRPC middleware |
|---|---|---|
| Question | May the *agent path* proceed — visibility, gating, approval? | May this operation *happen* — authn, tenancy, permissions? |
| Runs | Pipeline stages 7/9 (and discovery) | Inside the procedure call, stage 11 |
| Applies to | Agent-runtime invocations only | Every invocation from every caller |
| Authoritative for security | No — additive (SI-2) | **Yes** ([ADR-008](../architecture/decisions.md#adr-008-existing-orpc-middleware-remains-authoritative)) |

If a check must hold for *all* callers, it belongs in middleware. If it is agent-specific (approval thresholds, surface restrictions, model-facing visibility), it belongs in a policy. Duplicating a critical check in both is legitimate defense in depth.

## Related

- Guide: [adding-policies.md](../guides/adding-policies.md) · Reference: [core.md](../reference/core.md#definepolicy) · Testing: [testing-capabilities.md](../guides/testing-capabilities.md)
