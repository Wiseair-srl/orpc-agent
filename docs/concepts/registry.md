# Capability registry

> **Status:** Implemented in v0.1 — v0.1 concepts. APIs shown are the as-built v0.1 surface.

The **registry** is the typed collection that turns annotated procedures into addressable capabilities. It answers: *what capabilities exist, what are they called, and which subset applies here?*

## Identity comes from structure

```ts
export const capabilities = createCapabilityRegistry({
  customers: { search: searchCustomers, get: getCustomer },
  orders:    { search: searchOrders, refund: refundOrder },
  messages:  { draft: draftMessage, send: sendMessage },
});
```

The capability id is the dot-joined path: `customers.search`, `orders.refund`. One id, used everywhere — `runtime.invoke`, policies, approvals, audit events, trace attributes, adapter tool names (mapped `.`→`_` where protocols require).

Consequences of path-derived identity:

- **Stability matters.** Renaming a path is a breaking change for approvals in flight, audit history, and policy targeting — treat it like renaming a public API.
- **No aliasing.** There is deliberately no `meta.id` override; two sources of naming truth would drift. (Adapter `toolName` overrides affect only the protocol label, never the id.)
- **Hierarchy is free.** Nesting gives namespacing (`orders.*` targeting in policies) without extra machinery.

## Explicit inclusion

Only procedures carrying `meta.agent` become capabilities. Others are excluded from every surface and reported:

```ts
capabilities.inspect();
// {
//   capabilities: [...9 items...],
//   excluded: [{ path: "internal.recomputeStats", reason: "no-agent-meta" }],
// }
```

Passing your entire existing router object is therefore safe: nothing leaks by default (SI-1); `inspect()` makes the boundary visible in code review and in a startup log line.

Registry construction is also the **validation gate** — every metadata problem in the tree fails startup with one aggregated error ([reference/metadata.md](../reference/metadata.md#validation-at-registry-build)).

## Filtering is composition, not authorization

```ts
const readOnly = capabilities.filter({ sideEffect: ["none", "read"] });
const supportRuntime = createAgentRuntime({ registry: readOnly, policies });
```

`filter` produces a narrowed registry for building purpose-specific runtimes (a read-only deployment, a low-risk sandbox). It is a *composition* tool: removing a capability from a registry makes it nonexistent for that runtime — which is fine — but per-actor visibility belongs in **policies**, and per-request authorization belongs in policies + middleware (SI-2). If you find yourself filtering registries per user, you are reimplementing discovery policies without the audit trail.

## Introspection surface

| Method | Use |
|---|---|
| `ids()` | Startup logging, docs generation |
| `get(id)` | Runtime resolution, tooling |
| `capabilities()` | Building dashboards / capability inventories |
| `filter(query \| fn)` | Purpose-specific runtimes |
| `inspect()` | Review: what's in, what's out, why |

A recommended practice (recommended, not enforced; the reference example ships one as a test snapshot): snapshot `ids()` plus each capability's `{ sideEffect, risk, expose }` in a checked-in file, so any change to the governed surface shows up in diff review.

## Multiple registries

Registries are cheap values. Patterns that fall out:

- **Environment split** — `capabilities` vs `capabilities.filter({ risk: ["low", "medium"] })` for a staging MCP endpoint.
- **Product split** — separate registries per bounded context, merged at composition time by nesting: `createCapabilityRegistry({ billing: billingDefs, support: supportDefs })`.
- **Test slice** — a registry of just the capability under test, with the rest stubbed via the testing package's `overrides`.

## Related

- [Capabilities](capabilities.md) · [Runtime](runtime.md) · Reference: [core.md](../reference/core.md#createcapabilityregistry)
