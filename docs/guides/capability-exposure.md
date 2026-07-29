# Guide: capability exposure

> **Status:** Stable — 1.0. Concepts: [ADR-004](../architecture/decisions.md#adr-004-exposure-is-explicit-and-surface-specific), SI-1/SI-2/SI-8.

Exposure answers one question per surface: *is this capability reachable here at all?* It is the outermost gate (pipeline stage 4) and the easiest one to reason about — a static map you can review in a diff.

## The decision, per surface

```ts
expose: {
  direct: true,     // your server code calls it via runtime.invoke
  aiSdk: true,      // your own model loop may call it
  mcp: false,       // external MCP clients may NOT
  // workflow, test: same idea; absent = denied
}
```

Ask per surface, in increasing order of caution:

| Surface | Caller | Ask yourself |
|---|---|---|
| `test` | Your CI | Usually `true` — governance tests need reach. (The test runtime can also target other surfaces to test *their* exposure.) |
| `direct` | Your own server code | Does non-agent code invoke this *through the governed path*? (Its normal oRPC router path is unaffected either way.) |
| `workflow` | Your durable jobs | Will steps replay? Is the handler idempotent enough for that world? |
| `aiSdk` | Your model loop, your prompts | Would I let a well-meaning intern with these prompts trigger this? |
| `mcp` | External clients, other people's loops | Would I let a *third-party integration* trigger this? Highest bar. |

The reference app's answers are a worked example: searches on `aiSdk`+`mcp`+`direct`; `orders.refund` on `aiSdk`+`direct` only; `admin.deleteAccount` **not a capability at all** ([example](../examples/customer-support-agent.md#capability-inventory)).

## Exposure ≠ visibility ≠ permission

Three different mechanisms, commonly confused:

- **Exposure** (`expose.mcp: false`) — structural: nobody on that surface, ever, regardless of actor. Checked at stage 4.
- **Visibility** (policy `hide()` at discovery) — conditional: *this actor* shouldn't see it listed; enforcement still happens at invoke (SI-2).
- **Permission** (middleware / policy `deny`) — the actor may see it yet not be allowed to run it.

Use the weakest mechanism that states your intent: "never on MCP" is exposure; "only admins see it" is a discovery policy; "only admins run it" is middleware (+ optional policy backstop).

## Staged rollout pattern

```ts
// 1. Define with empty exposure — capability exists, reachable nowhere
expose: {}

// 2. Enable for tests; write governance tests
expose: { test: true }

// 3. Enable direct; wire into a UI action through the governed path (optional but
//    valuable: same audit trail as agents)
expose: { test: true, direct: true }

// 4. Enable your own loop
expose: { test: true, direct: true, aiSdk: true }

// 5. External surface last, if ever
expose: { test: true, direct: true, aiSdk: true, mcp: true }
```

Each step is a one-line diff — which is the review ritual working as intended.

## Narrowed deployments

Exposure is per-capability; **registries** narrow whole deployments:

```ts
// A read-only MCP endpoint, structurally incapable of writes
const mcpRegistry = capabilities.filter({ sideEffect: ["none", "read"] });
const mcpRuntime = createAgentRuntime({
  governance: defineGovernance({ registry: mcpRegistry, policies: mcpPolicies }),
  audit,
});
```

Filtering removes capabilities from that runtime entirely (they're `CAPABILITY_NOT_FOUND` there); combine with per-capability `expose` for the full picture. Per-*actor* narrowing stays in policies — never fork registries per user ([concepts/registry.md](../concepts/registry.md#filtering-is-composition-not-authorization)).

## Auditing your surface area

Make the exposed set reviewable and diffable:

```ts
// scripts/capability-report.ts — run in CI, commit the output
for (const c of capabilities.capabilities()) {
  console.log(
    `${c.id}\t${c.meta.sideEffect}/${c.meta.risk}\t` +
    Object.entries(c.meta.expose).filter(([, v]) => v).map(([s]) => s).join(","),
  );
}
```

A PR that flips `mcp: false → true` on a `destructive` capability should look exactly as loud in review as it is in consequence.

## Anti-patterns

- **`exposeAll`-style helpers** — don't build one; the framework deliberately has none.
- **Exposing "temporarily" for debugging** — use the `test` surface and the test runtime instead.
- **Treating adapter `filter` options as exposure** — they shape listings, not reachability (SI-2).
- **Encoding exposure in descriptions** ("not for external use") — prose gates nothing.
