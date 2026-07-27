# Authorization

> **Status:** Implemented in v0.1 — v0.1 security semantics.

Four layers touch "may this happen?". They complement each other; none replaces another. The framework's contribution is making each layer's role explicit — and guaranteeing the authoritative one always runs.

## The four layers

```text
              question answered                        owner
1. Adapter    who is this, on this transport?          your app (authentication)
2. Exposure   is this capability on this surface?      capability metadata (SI-1)
3. Policies   may this actor ask, now, with this       oRPC Agent policies
              input — and does it need approval?
4. Middleware may this operation happen at all?        your oRPC middleware + handler
   + handler                                           checks — AUTHORITATIVE (ADR-008)
```

**Layer 1 is authentication, not authorization** — it establishes the `Actor` from session cookies, OAuth tokens, or service credentials. Keep the distinction: authentication says who; authorization says whether ([glossary](../glossary.md)).

**Layer 2 is structural**: a static, reviewable map of what exists where. It cannot reason about actors.

**Layer 3 is agent-specific governance**: surface restrictions, risk gating, approval thresholds, tenancy backstops. Policies run before the procedure and see actor + context + validated input.

**Layer 4 is your existing security model, unchanged.** The runtime invokes procedures through oRPC's call path, so every `.use(...)` guard — session checks, org scoping, permission requirements — runs on agent traffic exactly as on HTTP traffic. If your middleware would reject a request from a hostile HTTP client, it rejects the same request from a model.

## Why adapter filtering is not authorization

Filtering the tool list per user (layer-2/3 information applied at discovery) controls what a *well-behaved* model sees. It does nothing against a request that arrives anyway — a hallucinated tool name, a replayed call, a second surface, a bug in the loop. That is why discovery, invocation, and execution are separate decisions ([ADR-005](../architecture/decisions.md#adr-005-discovery-and-execution-authorization-are-separate)) and why every invoke re-runs layers 2–4 (SI-2).

Rule of thumb: **filtering shapes the conversation; enforcement happens at execution.**

## Division of labor (worked example)

"Support agents may refund orders in their org, up to $500 without approval, never over MCP":

```ts
// Layer 2 — metadata: reachable via aiSdk and direct, not mcp
expose: { aiSdk: true, direct: true }

// Layer 3 — policies: agent-path governance
const refundLimit = definePolicy("refund-limit", ({ capability, input }) =>
  capability.id === "orders.refund" && (input as RefundInput).amount > 500
    ? requireApproval({ reason: "Refund exceeds $500", approvalType: "manager" })
    : allow());

// Layer 4 — middleware: the authoritative permission + tenancy checks
const requirePermission = (perm: string) =>
  base.middleware(({ context, next }) => {
    if (!context.session?.permissions.includes(perm)) throw new ORPCError("FORBIDDEN");
    return next();
  });

export const refundOrder = agentBase
  .use(requirePermission("orders:refund"))
  .use(requireSameOrg("orderId"))
  .meta({ agent: { /* ... */ } })
  ...
```

Delete every policy and the operation is still permission-checked and org-scoped — that is the correct failure mode. Policies add the agent-specific parts (thresholds, approval, surface rules) that middleware has no business knowing.

## Multi-tenancy

Organization and workspace boundaries must be **execution-time** checks in layers 3–4, never a property of which tools were listed:

- Put tenant identity in the execution context from authenticated data (`context.organizationId` derived from the session — not from tool arguments).
- Scope every query in handlers/middleware by that context value. An input like `orderId` is untrusted; the handler resolves it *within* the tenant: `orders.findWithinOrg(orderId, context.organizationId)`.
- Optionally add a policy backstop (`orgIsolation` in [concepts/policies.md](../concepts/policies.md#what-policies-see)) — cheap defense in depth with an audit trail.
- Cross-tenant administration is its own capability with its own risk classification and approval policy, not a bypass flag.

The confused-deputy failure to design against: the model asks for `ord_999` (another tenant's order) because injected content told it to. Layer 4 must make that read impossible *regardless* of what the model asked — the actor's tenancy, not the argument, decides scope.

## Service accounts and automations

Non-human actors (`kind: "service" | "automation"`) get the same treatment: least-privilege permissions in `attributes`, their own policy targeting (e.g., deny `destructive` to automations), and their own audit identity. Resist one shared "agent service account" for all agent traffic — it destroys attribution; the actor should be the *human or system on whose behalf* the call runs.

## Related

- [security-model.md](security-model.md) · [concepts/policies.md](../concepts/policies.md#policies-vs-middleware-the-boundary-that-matters) · [concepts/context.md](../concepts/context.md)
