# Adapter model

> The normative contract every adapter implements. Adapters are thin by design: if one makes an authorization decision, that is a bug.

An **adapter** exposes capabilities to one external protocol or runtime. Adapters are thin by design: every governance decision belongs to the runtime, so that a capability behaves identically no matter which surface invokes it. If an adapter ever makes an authorization decision, that is a bug ([ADR-002](decisions.md#adr-002-capability-is-the-internal-abstraction), [ADR-005](decisions.md#adr-005-discovery-and-execution-authorization-are-separate)).

## The adapter contract

Every adapter, present and future, implements the same four obligations:

```text
+------------------------------------------------------------------+
|                           ADAPTER                                |
|                                                                  |
| 1. IDENTITY    authenticate the transport; build Actor + context |
| 2. DISCOVERY   runtime.describe(surface, { actor, context })     |
|                -> translate CapabilityDescriptor[] to protocol   |
| 3. INVOCATION  runtime.invoke(id, rawInput,                      |
|                  { actor, context, surface, signal })            |
| 4. TRANSLATION ExecutionResult -> protocol response              |
|                (model-safe; envelope statuses preserved)         |
+------------------------------------------------------------------+
```

What adapters must **not** do:

- pre-validate input (the runtime is the validation authority; adapters forward raw arguments);
- filter capabilities by their own logic beyond an optional caller-supplied `filter` convenience (which is UX, not security — SI-2);
- unwrap or reinterpret errors beyond the defined serialization;
- invent a surface value (each adapter hardcodes its own);
- expose `details`, `cause`, or stack traces to model clients (SI-9).

## Surface identity

```ts
type ExposureSurface = "direct" | "aiSdk" | "mcp" | "workflow" | "test";
```

The surface is part of every exposure check, policy request, and audit event. `direct` is server-side application code calling `runtime.invoke` itself; `workflow` is reserved for a future durable-execution adapter but usable today by passing `surface: "workflow"` from workflow glue code; `test` is the default surface of `@orpc-agent/testing`.

## Naming translation

Capability IDs are dot-paths (`orders.refund`). Protocols with restricted tool-name alphabets translate deterministically:

- Default mapping: `.` → `_` (`orders.refund` → `orders_refund`).
- Overrides: `meta.adapters.aiSdk.toolName` / `meta.adapters.mcp.toolName`.
- Collisions after mapping are a startup error, never a silent rename.
- Adapters keep a bidirectional map so protocol tool names resolve back to capability IDs before calling the runtime.

## Result translation

The `ExecutionResult` envelope has four statuses; each adapter defines a deterministic protocol shape for all four. Requirements:

| Status | Adapter obligation |
|---|---|
| `completed` | Serialize the **redacted** output. |
| `approval-required` | Return a structured, model-visible signal containing the approval id and a human-readable reason — the model must be able to tell the user "this is awaiting approval" and must not interpret it as failure. |
| `failed` | Serialize `{ code, message: publicMessage, retryable }` when `exposeToModel`, else the generic `INTERNAL_ERROR` shape. |
| `cancelled` | Same as failed; codes `TIMEOUT` / `CANCELLED`. |

Concrete shapes per adapter: [adapters/ai-sdk.md](../adapters/ai-sdk.md), [adapters/mcp.md](../adapters/mcp.md).

## Cancellation propagation

```text
protocol abort (HTTP disconnect, MCP cancellation, AbortSignal from AI SDK)
        -> adapter passes signal to runtime.invoke
        -> runtime composes it with the capability timeout
        -> oRPC forwards the composite signal to the handler
        -> handler forwards it to downstream calls (fetch, DB drivers)
```

Adapters must forward whatever cancellation primitive their protocol provides; the runtime handles composition and normalization (`TIMEOUT` vs `CANCELLED`).

## Context construction

Adapters own the mapping from protocol session to application identity:

```ts
// MCP adapter option
createContext: async (session) => ({
  actor: { id: session.userId, kind: "user" },
  context: await buildAppContext(session),   // the app's oRPC context
})
```

The AI SDK adapter receives `actor` and `context` directly because tool sets are built per request inside the application's own authenticated handler. In both cases the model never supplies identity (SI-3); nothing a model writes into tool arguments can change who the actor is.

## Writing a future adapter

A new adapter (CLI, A2A, workflow engine) is conformant when:

1. It calls only `runtime.describe` and `runtime.invoke`/`runtime.resume` — never procedures directly.
2. It hardcodes one surface value and documents it.
3. It translates all four result statuses deterministically.
4. It sources actor identity from transport authentication.
5. It adds its protocol SDK as a peer dependency and depends on no other adapter.
6. Its behavior is covered by the shared adapter conformance checklist in [testing](../adapters/testing.md#adapter-conformance).

Durable-execution engines (Temporal, Inngest, Trigger.dev) integrate as adapters too: the engine drives when steps run and owns persistence; each step's body is `runtime.invoke` with `surface: "workflow"`. Core never becomes a workflow engine ([ADR-007](decisions.md#adr-007-durable-execution-is-adapter-based)).
